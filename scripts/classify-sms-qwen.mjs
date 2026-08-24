#!/usr/bin/env node
/**
 * Qwen-based SMS classifier/backfill.
 *
 * Usage:
 *   node scripts/classify-sms-qwen.mjs --dry-run --limit 20
 *   node scripts/classify-sms-qwen.mjs --corpus-source api_retrieval --limit 500
 *   node scripts/classify-sms-qwen.mjs --abstract-present --corpus-source openalex_bulk
 *   node scripts/classify-sms-qwen.mjs --retry-batch-size 5 --singleton-retry
 *   node scripts/classify-sms-qwen.mjs --abstract-present --workers 4 --worker 0
 *   node scripts/classify-sms-qwen.mjs --abstract-present --year-min 2010 --min-abs-rating 3
 *   node scripts/classify-sms-qwen.mjs --ids doi1,doi2
 *   node scripts/classify-sms-qwen.mjs --ids-file reports/priority-missing-abstracts-wd-econometrica-jhe-2026-05-21.json
 *   node scripts/classify-sms-qwen.mjs --venues "World Development,Econometrica,Journal of Health Economics"
 *
 * Writes:
 *   - sms_level
 *   - methodology_design
 *   - causal_strength
 *   - sms_method = 'qwen_llm'
 *   - sms_rationale
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';

config();

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const withEquals = args.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return fallback;
};

const DRY_RUN = args.includes('--dry-run');
// --reclassify: when set alongside --ids-file, skip the sms_level IS NULL gap filter
// so already-classified papers can be corrected (e.g. after a classifier bug fix).
const RECLASSIFY = args.includes('--reclassify');
const LIMIT = Number(argValue('--limit', '0')) || null;
const CORPUS_SOURCE = argValue('--corpus-source', null);
const VENUES = String(argValue('--venues', ''))
  .split(',')
  .map((venue) => venue.trim())
  .filter(Boolean);
const IDS_FILE = argValue('--ids-file', null);
const IDS = String(argValue('--ids', ''))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen2.5:14b-synthesis';
const QWEN_URL = `${LLM_BASE}/v1/chat/completions`;

const BATCH_SIZE = Number(process.env.BATCH_SIZE || argValue('--batch-size', '25')) || 25;
const WORKERS = Number(process.env.WORKERS || argValue('--workers', '1')) || 1;
const WORKER = Number(process.env.WORKER || argValue('--worker', '0')) || 0;
const PRIORITY = args.includes('--priority');
const ABSTRACT_PRESENT = args.includes('--abstract-present');
const YEAR_MIN = Number(argValue('--year-min', '0')) || null;
const MIN_ABS_RATING = Number(argValue('--min-abs-rating', '0')) || 0;
const PAGE_SIZE = Number(process.env.PAGE_SIZE || '50') || 50;
const ABSTRACT_CAP = Number(process.env.ABSTRACT_CAP || argValue('--abstract-cap', '1000')) || 1000;
const SLEEP_MS = Number(process.env.SLEEP_MS || argValue('--sleep-ms', '1000')) || 1000;
const MAX_REQUESTS_PER_RUN = Number(process.env.MAX_REQUESTS || argValue('--max-requests', '1000')) || 1000;
const RETRY_BATCH_SIZE = Number(process.env.RETRY_BATCH_SIZE || argValue('--retry-batch-size', '5')) || 5;
const SINGLETON_RETRY = args.includes('--singleton-retry') || process.env.SINGLETON_RETRY === '1';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || argValue('--heartbeat-ms', '60000')) || 60000;
const WORKER_ID = process.env.WORKER_ID || `sms-qwen-${hostname()}-${process.pid}-${WORKER + 1}of${WORKERS}`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
if (!LLM_KEY) {
  throw new Error('Missing LLM_API_KEY or OPENAI_API_KEY for Qwen/LiteLLM');
}
if (!Number.isInteger(WORKERS) || WORKERS < 1) {
  throw new Error('--workers must be an integer >= 1');
}
if (!Number.isInteger(WORKER) || WORKER < 0 || WORKER >= WORKERS) {
  throw new Error('--worker must be an integer in [0, workers)');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

function loadIdsFile(filePath) {
  if (!filePath) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
  return rows.map((row) => String(row?.id || '').trim()).filter(Boolean);
}

const TARGET_IDS = [...new Set([...IDS, ...loadIdsFile(IDS_FILE)])];

function ratingValue(value) {
  if (value === '4*') return 5;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function absRatingsAtLeast(minRating) {
  if (!minRating || minRating <= 0) return null;
  return ['1', '2', '3', '4', '4*'].filter((rating) => ratingValue(rating) >= minRating);
}

const ABS_RATINGS = absRatingsAtLeast(MIN_ABS_RATING);

const SYSTEM_PROMPT = `You are an expert bibliometrician and research methodologist. Your task is to evaluate the methodological rigor of academic papers using a strict 5-point Scientific Methods Scale (SMS), based on the Maryland Scientific Methods Scale.

The SMS measures the strength of a study's causal inference and its ability to measure the impact of an intervention or variable while controlling for confounders.

Strict Scoring Rules & Guardrails
Before scoring, classify the fundamental nature of the paper. Do not inflate scores for complex topics or thorough literature reviews.

RULE 1: The "Level 1" Trap. If a paper is a Literature Review, Systematic Review, Theoretical Framework, Qualitative Study, Descriptive Study, Predictive Modeling Study, or a Cross-Sectional Survey at a single point in time without a control group, it MUST be scored as Level 1. There are zero exceptions.
RULE 2: Primary vs. Secondary. To score a Level 2 or higher, the paper MUST be primary empirical research testing a specific intervention, policy, or measurable correlation with distinct treatment/control groups, comparison groups, or strong statistical controls.
RULE 3: Statistical Methods. Look for specific methods to award Level 3 or 4: Panel Data, Interrupted Time Series, Fixed Effects, Difference-in-Differences, Regression Discontinuity, Instrumental Variables, Synthetic Control, or Propensity Score Matching.
RULE 4: Experiments with randomization are Level 4-5 even when survey-based. Conjoint experiments, survey experiments, and vignette/factorial experiments that RANDOMIZE attributes across respondents are experimental designs (Level 4; Level 5 if respondents are randomly assigned to arms) — do NOT downgrade them to a Level 1 "survey" just because data were collected via a questionnaire.
RULE 5: Name the design precisely in "method_identified" (e.g. "Conjoint experiment", "Regression Discontinuity", "Difference-in-Differences"). Ensure method_identified is consistent with sms_level — do not describe a discontinuity/RCT/DiD design and then assign Level 1-2, and do not describe observational/cross-sectional data and then assign Level 4-5.

The SMS Rubric
Level 1 (Low Rigor/Not Applicable): Correlational studies without controls, surveys without controls, qualitative research, theoretical papers, expert consensus, predictive modeling, descriptive studies, and all literature reviews.
Level 2 (Moderate Rigor): Observational primary empirical studies with a comparison group or statistical controls, but lacking baseline equivalence or clear temporal sequence, such as standard cross-sectional regressions.
Level 3 (Quasi-Experimental): Studies that control for unobserved variables or track over time. Must use methods like Panel Data, Interrupted Time Series, or Fixed Effects models.
Level 4 (Strong Quasi-Experimental): Studies with robust matched control groups and pre/post intervention data, such as Difference-in-Differences, Regression Discontinuity, Instrumental Variables, Synthetic Control, or strong Propensity Score Matching.
Level 5 (Highest Rigor): True Randomized Controlled Trials with random assignment to treatment and control groups.

Output Format
Return strictly a JSON object with one key "classifications". The array must contain one result per input paper, in the same order:
{"classifications":[{"id":"[same id as input]","paper_title":"[title]","method_identified":"[e.g., Literature Review, Panel Data, Survey]","chain_of_thought":"[Briefly explain: Is it empirical? Does it have a control group? What statistical controls are used?]","sms_level":1}]}

Do not return prose, markdown, or any keys outside the JSON object.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max = ABSTRACT_CAP) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

let totalRequests = 0;
let running = true;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function applyScopeFilters(query) {
  if (CORPUS_SOURCE) query = query.eq('corpus_source', CORPUS_SOURCE);
  if (VENUES.length) query = query.in('venue', VENUES);
  if (PRIORITY) query = query.or(PRIORITY_OR);
  if (ABSTRACT_PRESENT) query = query.not('abstract', 'is', null);
  if (YEAR_MIN) query = query.gte('year', YEAR_MIN);
  if (ABS_RATINGS) query = query.in('abs_rating', ABS_RATINGS);
  return query;
}

function shardForId(id) {
  const text = String(id || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % WORKERS;
}

function buildBatchPrompt(papers) {
  const payload = papers.map((paper) => ({
    id: paper.id,
    title: paper.title || '',
    year: paper.year || null,
    source: paper.source || null,
    abstract: clip(paper.abstract),
  }));
  return `Classify these papers:\n${JSON.stringify(payload)}`;
}

async function callQwen(papers) {
  // Scale max_tokens with batch size. Each paper's JSON output is ~50-150
  // tokens (sms_level, methodology_design, causal_strength, brief rationale).
  // The previous flat 4000 caused frequent 90s timeouts because qwen2.5:14b on
  // a V100 generates ~30-60 tokens/sec, so 4000 tokens = 67-133s — right at
  // the timeout boundary. 200 tokens/paper is generous; floor at 500.
  const maxTokens = Math.max(papers.length * 200, 500);
  const response = await fetch(QWEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LLM_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildBatchPrompt(papers) },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  totalRequests++;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Qwen request failed ${response.status}: ${text.slice(0, 500)}`);
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Qwen response had no message content');

  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.classifications)) return parsed.classifications;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed.papers)) return parsed.papers;
  if (parsed.sms_level || parsed.method_identified) return [parsed];
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value)) return value;
  }
  throw new Error('Qwen response JSON had no classifications array');
}

function normalizeClassification(item) {
  if (!item) return null;
  const rawLevel = Number(item.sms_level ?? item.level);
  if (!Number.isFinite(rawLevel)) return null;

  const method = String(item.method_identified || item.method || '');
  const explanation = String(item.chain_of_thought || item.rationale || item.sms_rationale || '');
  const text = `${method} ${explanation}`.toLowerCase();
  let level = Math.max(1, Math.min(5, parseInt(rawLevel, 10)));
  let design = normalizeDesign(method, text);

  if (isMandatoryLevelOne(text, design)) {
    level = 1;
    design = mandatoryLevelOneDesign(text, design);
  }

  // Non-empirical work (Review, Theoretical) → SMS 0. Distinguishes from
  // weak-empirical (SMS 1 = descriptive/qualitative/cross-sectional survey).
  if (design === 'Review' || design === 'Theoretical') {
    level = 0;
  }

  const issue = consistencyIssue(level, design, text);
  let rationale = String(explanation || method || design).replace(/\s+/g, ' ').trim();
  if (issue) rationale = `[REVIEW] ${rationale} (self-check: ${issue})`;

  return {
    level,
    design,
    needsReview: !!issue,
    rationale: rationale.slice(0, 220),
  };
}

// Design detection. CRITICAL (2026-07-15): short acronyms ("did", "IV", "DD",
// "RDD") occur as ordinary words in the chain-of-thought prose — e.g. Hartmann's
// "...it DID not use advanced controls..." matched \bdid\b and mislabelled a
// conjoint experiment as DiD. So acronyms are trusted ONLY in the model's
// `method_identified` field (`m`); the free prose (`full`) is scanned only for
// unambiguous spelled-out phrases.
function normalizeDesign(method, text) {
  const m = String(method || '').toLowerCase();
  const full = `${method} ${text}`.toLowerCase();
  if (/\brct\b|randomi[sz]ed controlled trial|random assignment|randomi[sz]ed (field |lab )?(experiment|evaluation)|randomly (assigned|allocated)/.test(full)) return 'RCT';
  if (/conjoint/.test(full)) return 'Conjoint';
  if (/difference.?in.?differences/.test(full) || /\b(did|dd|dind)\b/.test(m)) return 'DiD';
  if (/regression discontinuity|discontinuit/.test(full) || /\brdd?\b/.test(m)) return 'RDD';
  if (/instrumental variable/.test(full) || /\b(iv|2sls|tsls)\b/.test(m)) return 'IV';
  if (/synthetic control/.test(full)) return 'Synthetic';
  if (/propensity|matching|matched control/.test(full)) return 'PSM';
  if (/lab(oratory)? experiment/.test(full)) return 'LabExperiment';
  if (/field experiment/.test(full)) return 'RCT';
  if (/fixed effects?/.test(full)) return 'FixedEffects';
  if (/panel data|longitudinal panel/.test(full)) return 'Panel';
  if (/interrupted time series/.test(full)) return 'InterruptedTimeSeries';
  if (/systematic review|literature review|meta-analysis|\breview\b/.test(full)) return 'Review';
  if (/theoretical|framework|conceptual/.test(full)) return 'Theoretical';
  if (/qualitative|interview|ethnograph|focus group/.test(full)) return 'Qualitative';
  if (/predictive|machine learning|deep learning|prediction model|black-box/.test(full)) return 'Predictive';
  if (/descriptive|case study|landscape|current landscape/.test(full)) return 'Descriptive';
  if (/survey/.test(full)) return 'Survey';
  if (/observational|regression|correlational|controls?/.test(full)) return 'Observational';
  return 'Other';
}

// Canonical SMS tier for a design — used only to FLAG level/design contradictions
// for LLM re-review, never to silently rewrite the model's level.
const DESIGN_CANONICAL_LEVEL = {
  RCT: 5, Conjoint: 4, LabExperiment: 4, DiD: 4, RDD: 4, IV: 4, Synthetic: 4,
  PSM: 3, FixedEffects: 3, Panel: 3, InterruptedTimeSeries: 3,
  Observational: 2, Survey: 2,
  Descriptive: 1, Qualitative: 1, Predictive: 1, Simulation: 1,
  Review: 0, Theoretical: 0,
};

// Deterministic self-consistency check. Returns a short reason string when the
// (level, design, rationale) triple contradicts itself, else null. Flagged rows
// get a "[REVIEW]" rationale prefix + causal_strength unchanged; SMS Phase 1
// re-runs them through the LLM (query: sms_rationale ilike '[REVIEW]%').
function consistencyIssue(level, design, text) {
  const t = String(text || '').toLowerCase();
  const canonical = DESIGN_CANONICAL_LEVEL[design];
  // Causal design asserted but scored as low rigor (e.g. RDD tagged SMS 2).
  if (canonical != null && canonical >= 4 && level <= 2) {
    return `design ${design} implies SMS ~${canonical} but level=${level}`;
  }
  // High rigor asserted over a design that cannot support it (e.g. Observational
  // tagged RCT — the McLean & Whang "observational data" → RCT case).
  if (canonical != null && canonical <= 2 && level >= 4) {
    return `level=${level} but design ${design} implies SMS ~${canonical}`;
  }
  // Rationale explicitly says observational / no randomisation, yet labelled RCT.
  if (design === 'RCT' && /observational|no random|not random|cross.?section|cross.?countr/.test(t)
      && !/randomi[sz]|randomly (assigned|allocated)/.test(t)) {
    return 'rationale reads observational but design=RCT';
  }
  return null;
}

function isMandatoryLevelOne(text, design) {
  // Never force SMS:1 on papers with explicit randomisation language — they are
  // RCTs even if Qwen labelled the design as "Survey" or "Qualitative" (Jensen 2010
  // pattern: abstract opens "Using survey data..." but describes a randomised field
  // experiment). This guard fires before all other checks.
  if (/randomly assigned|randomly allocated|randomized controlled trial|randomised controlled trial|\bRCT\b|cluster.?randomized|cluster.?randomised/.test(text)) return false;

  if (['Review', 'Theoretical', 'Qualitative', 'Descriptive', 'Predictive'].includes(design)) return true;
  if (/systematic review|literature review|meta-analysis|\breview\b/.test(text)) return true;
  if (/theoretical framework|conceptual framework|expert consensus|commentary/.test(text)) return true;
  if (/qualitative|interview|ethnograph|focus group/.test(text)) return true;
  if (/descriptive|predictive modeling|prediction model|machine learning|deep learning/.test(text)) return true;
  // "survey" trap: only force SMS:1 when no quasi-experimental or experimental controls are present.
  // Added "randomized|randomly" to the exclusion guard (2026-06-29, Jensen-pattern fix).
  if (/cross-sectional survey|survey/.test(text) && !/control group|comparison group|fixed effects|panel|difference.?in.?differences|\bdid\b|regression discontinuity|\brdd\b|instrumental|randomized|randomly/.test(text)) return true;
  return false;
}

function mandatoryLevelOneDesign(text, fallback) {
  if (/systematic review|literature review|meta-analysis|\breview\b/.test(text)) return 'Review';
  if (/theoretical|conceptual/.test(text)) return 'Theoretical';
  if (/qualitative|interview|ethnograph|focus group/.test(text)) return 'Qualitative';
  if (/predictive|machine learning|deep learning|prediction model/.test(text)) return 'Predictive';
  if (/survey/.test(text)) return 'Survey';
  if (/descriptive/.test(text)) return 'Descriptive';
  return fallback;
}

function toDbRow(paper, item) {
  const normalized = normalizeClassification(item);
  if (!normalized) return null;
  let { level, design, rationale } = normalized;

  // No SMS >= 3 without an abstract — a quasi-experimental/experimental rigor
  // claim can't be made from a title alone (2026-07-15: "A natural experiment
  // on earthquakes..." tagged SMS 4 with an empty abstract). Damp to SMS 2 and
  // flag for review once an abstract is retrieved.
  const hasAbstract = !!String(paper.abstract || '').trim();
  if (!hasAbstract && level >= 3) {
    rationale = `[REVIEW] ${rationale.replace(/^\[REVIEW\]\s*/, '')} (capped: SMS ${level} claimed with no abstract)`.slice(0, 220);
    level = 2;
  }

  return {
    id: paper.id,
    source: paper.source,
    abs_rating: paper.abs_rating,
    repec_percentile: paper.repec_percentile,
    title: paper.title || '[No title]',
    sms_level: level,
    methodology_design: design,
    causal_strength: level >= 4 ? 'high' : level >= 3 ? 'moderate' : level === 0 ? 'signal' : 'limited',
    sms_method: 'qwen_llm',
    sms_rationale: rationale,
    updated_at: new Date().toISOString(),
  };
}

async function classifyBatchWithFallback(batch, depth = 0) {
  if (totalRequests >= MAX_REQUESTS_PER_RUN) {
    return { rows: [], failed: batch };
  }

  try {
    const classifications = await callQwen(batch);
    if (!Array.isArray(classifications)) {
      throw new Error('Qwen response did not contain an array');
    }

    if (classifications.length !== batch.length) {
      process.stderr.write(`m(${classifications.length}/${batch.length})`);
    }

    const byId = new Map(
      classifications
        .filter((item) => item?.id != null)
        .map((item) => [String(item.id), item])
    );
    const useIdMapping = byId.size > 0;
    const rows = [];
    const failed = [];

    for (let index = 0; index < batch.length; index++) {
      const paper = batch[index];
      const positional = classifications[index];
      const mapped = useIdMapping ? byId.get(String(paper.id)) : null;
      const item = mapped || positional;
      const row = toDbRow(paper, item);
      if (row) rows.push(row);
      else failed.push(paper);
    }

    if (!failed.length) return { rows, failed };

    const canRetryChunk = failed.length > 1 && RETRY_BATCH_SIZE > 0 && depth < 2;
    const canRetrySingleton = failed.length === 1 && SINGLETON_RETRY && depth < 3;
    if (!canRetryChunk && !canRetrySingleton) return { rows, failed };

    process.stderr.write(`r(${failed.length})`);
    const retrySize = canRetrySingleton ? 1 : Math.min(RETRY_BATCH_SIZE, failed.length);
    const retryResults = await classifyFailedPapers(failed, retrySize, depth + 1);
    return {
      rows: rows.concat(retryResults.rows),
      failed: retryResults.failed,
    };
  } catch (error) {
    process.stderr.write(`x(${String(error.message || error).slice(0, 40)}) `);
    const shouldSplit = batch.length > 1 && depth < 2;
    if (!shouldSplit && !(SINGLETON_RETRY && batch.length === 1 && depth < 3)) {
      return { rows: [], failed: batch };
    }

    process.stderr.write(`r(${batch.length})`);
    const retrySize = batch.length === 1 ? 1 : Math.min(RETRY_BATCH_SIZE, batch.length);
    return classifyFailedPapers(batch, retrySize, depth + 1);
  }
}

async function classifyFailedPapers(papers, retrySize, depth) {
  const rows = [];
  const failed = [];
  for (const retryBatch of chunk(papers, retrySize)) {
    if (totalRequests >= MAX_REQUESTS_PER_RUN) {
      failed.push(...retryBatch);
      continue;
    }
    const result = await classifyBatchWithFallback(retryBatch, depth);
    rows.push(...result.rows);
    failed.push(...result.failed);
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }
  return { rows, failed };
}

// Priority filter — high-value subset to classify first.
// Tier 1/2 ABS journals OR top-decile RePEc OR IDB / World Bank papers.
const PRIORITY_OR = 'abs_rating.in.("4*","4"),repec_percentile.lte.10,corpus_source.ilike.%idb%,corpus_source.ilike.%world_bank%,corpus_source.ilike.%world-bank%';

async function getMissingCount() {
  if (TARGET_IDS.length) {
    if (RECLASSIFY) return TARGET_IDS.length; // --reclassify skips the gap filter
    let total = 0;
    for (const ids of chunk(TARGET_IDS, 100)) {
      const { count, error } = await applyScopeFilters(
        supabase
          .from('works')
          .select('id', { count: 'exact', head: true })
          .is('sms_level', null)
          .in('id', ids)
      );
      if (error) {
        console.warn(`Missing-count query failed; continuing without exact target (${error.message || 'empty error'}).`);
        return LIMIT || TARGET_IDS.length;
      }
      total += count || 0;
    }
    return total;
  }

  const { count, error } = await applyScopeFilters(
    supabase
      .from('works')
      .select('id', { count: 'exact', head: true })
      .is('sms_level', null)
  );
  if (error) {
    console.warn(`Missing-count query failed; continuing without exact target (${error.message || 'empty error'}).`);
    return LIMIT || Number.MAX_SAFE_INTEGER;
  }
  return count || 0;
}

async function fetchBatch(offset, attempt = 1) {
  if (TARGET_IDS.length) {
    const matches = [];
    // Honour `offset` into TARGET_IDS. Normally the `.is('sms_level', null)` filter below
    // drains classified rows out of the result set, so offset 0 keeps returning fresh work.
    // Under --reclassify that filter is REMOVED, so nothing drains — without this slice the
    // same first PAGE_SIZE ids are re-fetched forever and the run never advances.
    // Only trust `offset` as a raw index under --reclassify — see the caller for why:
    // without --reclassify the `.is('sms_level', null)` filter below still drains
    // classified rows, so a raw-index offset there would double-count and skip rows.
    const pool = (RECLASSIFY && offset > 0) ? TARGET_IDS.slice(offset) : TARGET_IDS;
    for (let from = 0; from < pool.length && matches.length < PAGE_SIZE; from += 100) {
      const ids = pool.slice(from, from + 100);
      let q = supabase
        .from('works')
        .select('id,title,abstract,source,year,abs_rating,repec_percentile')
        .in('id', ids)
        .order('id', { ascending: true });
      if (!RECLASSIFY) q = q.is('sms_level', null); // --reclassify: skip gap filter
      const { data, error } = await applyScopeFilters(q);
      if (error) {
        if (attempt < 4 && isTransient(error.message || String(error))) {
          process.stderr.write(`[fetch retry ${attempt}] `);
          await sleep(5000 * attempt);
          return fetchBatch(offset, attempt + 1);
        }
        throw error;
      }
      matches.push(...(data || []));
    }
    return matches.slice(0, PAGE_SIZE);
  }

  const pageCap = 1000;
  const maxScanned = Math.max(pageCap, PAGE_SIZE * WORKERS * 20);
  const matches = [];

  for (let from = offset; from < offset + maxScanned && matches.length < PAGE_SIZE; from += pageCap) {
    let query = supabase
      .from('works')
      .select('id,title,abstract,source,year,abs_rating,repec_percentile')
      .is('sms_level', null)
      .order('id', { ascending: true });
    query = applyScopeFilters(query);

    const { data, error } = await query.range(from, from + pageCap - 1);
    if (error) {
      if (attempt < 4 && isTransient(error.message || String(error))) {
        process.stderr.write(`[fetch retry ${attempt}] `);
        await sleep(5000 * attempt);
        return fetchBatch(offset, attempt + 1);
      }
      throw error;
    }

    const rows = data || [];
    if (WORKERS === 1 || TARGET_IDS.length) return rows.slice(0, PAGE_SIZE);

    matches.push(...rows.filter((row) => shardForId(row.id) === WORKER));
    if (rows.length < pageCap) break;
  }

  // Stable sharding for parallel workers. The lane is based on work id, not
  // page position, so concurrent writes cannot move a row between workers.
  return matches.slice(0, PAGE_SIZE);
}

async function writeHeartbeat() {
  await supabase.from('worker_heartbeat').upsert({
    worker_id: WORKER_ID,
    last_seen: new Date().toISOString(),
    hostname: hostname(),
    pid: process.pid,
    metadata: {
      kind: 'sms-qwen',
      worker: WORKER,
      workers: WORKERS,
      batch_size: BATCH_SIZE,
      page_size: PAGE_SIZE,
      abstract_present: ABSTRACT_PRESENT,
      year_min: YEAR_MIN,
      min_abs_rating: MIN_ABS_RATING || null,
      corpus_source: CORPUS_SOURCE,
      venues: VENUES,
      ids_file: IDS_FILE,
      priority: PRIORITY,
      dry_run: DRY_RUN,
    },
  });
}

async function heartbeatLoop() {
  while (running) {
    try {
      await writeHeartbeat();
    } catch (error) {
      process.stderr.write(`[heartbeat ${String(error.message || error).slice(0, 60)}] `);
    }
    for (let elapsed = 0; elapsed < HEARTBEAT_MS && running; elapsed += 1000) {
      await sleep(1000);
    }
  }
}

function isTransient(message) {
  return [
    'connection pool',
    'fetch failed',
    'network',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR',
    '429',
    '503',
  ].some((needle) => String(message).includes(needle));
}

async function upsertRows(rows, attempt = 1) {
  if (!rows.length) return true;
  const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id' });
  if (error) {
    const message = error.message || String(error);
    if (attempt < 5 && isTransient(message)) {
      process.stderr.write(`[upsert retry ${attempt}: ${message.slice(0, 60)}] `);
      await sleep(5000 * attempt);
      return upsertRows(rows, attempt + 1);
    }
    console.error(`\nUpsert error: ${message}`);
    return false;
  }
  return true;
}

async function main() {
  console.log('\n=== Qwen SMS Classifier ===');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT || 'none'}`);
  console.log(`Corpus source: ${CORPUS_SOURCE || 'any'}`);
  console.log(`Venues: ${VENUES.length ? VENUES.join(', ') : 'any'}`);
  console.log(`Priority filter: ${PRIORITY ? 'YES (Tier 1/2 ABS, top-decile RePEc, IDB/World Bank)' : 'no'}`);
  console.log(`Abstract present only: ${ABSTRACT_PRESENT ? 'yes' : 'no'}`);
  console.log(`Year min: ${YEAR_MIN ?? 'none'}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || 'none'}`);
  console.log(`IDs: ${TARGET_IDS.length || 'none'}${IDS_FILE ? ` (from ${IDS_FILE})` : ''}`);
  console.log(`Worker shard: ${WORKER + 1}/${WORKERS}`);
  console.log(`Worker ID: ${WORKER_ID}`);
  console.log(`Model: ${QWEN_MODEL}`);
  console.log(`Batch: ${BATCH_SIZE}, abstract cap: ${ABSTRACT_CAP}, sleep: ${SLEEP_MS}ms, max reqs/run: ${MAX_REQUESTS_PER_RUN}\n`);
  console.log(`Fallback retry batch: ${RETRY_BATCH_SIZE}, singleton retry: ${SINGLETON_RETRY ? 'yes' : 'no'}\n`);

  await writeHeartbeat();
  heartbeatLoop();

  const total = await getMissingCount();
  const target = LIMIT ? Math.min(LIMIT, total) : total;
  console.log(`Papers needing classification: ${total.toLocaleString()}`);
  console.log(`Target this run: ${target.toLocaleString()}\n`);

  let processed = 0;
  let classified = 0;
  let errors = 0;

  while (processed < target) {
    if (totalRequests >= MAX_REQUESTS_PER_RUN) {
      console.log(`\nHit per-run request cap (${totalRequests}). Stopping cleanly.`);
      break;
    }

    // Plain gap-scan mode, and --ids-file WITHOUT --reclassify, intentionally always
    // fetch from 0: the `.is('sms_level', null)` filter (still applied in both cases —
    // see fetchBatch) drains classified rows out of the result set each round, so
    // offset 0 is both correct and cheapest. Passing a raw-index offset there while a
    // filter is still active would double-count and silently SKIP unclassified rows,
    // since fewer rows survive the filter per page than raw ids consumed.
    //
    // --ids-file WITH --reclassify has NO such filter (see fetchBatch), so nothing
    // drains: `processed` increments by exactly the raw ids consumed each round, which
    // makes it a correct raw-index offset — and it MUST be passed, or every iteration
    // re-fetches the same first PAGE_SIZE ids forever (the bug this comment replaces).
    const page = await fetchBatch((DRY_RUN || (TARGET_IDS.length && RECLASSIFY)) ? processed : 0);
    if (!page.length) break;
    const remaining = target - processed;
    const pageSlice = page.slice(0, remaining);

    for (const batch of chunk(pageSlice, BATCH_SIZE)) {
      try {
        const { rows, failed } = await classifyBatchWithFallback(batch);
        errors += failed.length;

        if (DRY_RUN) {
          classified += rows.length;
          if (processed === 0 && classified <= rows.length) {
            console.log('Sample classifications:');
            for (const row of rows.slice(0, 5)) {
              console.log(`  [${row.sms_level}/${row.methodology_design}] ${String(row.title).slice(0, 70)} - ${row.sms_rationale}`);
            }
          }
        } else {
          const wrote = await upsertRows(rows);
          if (wrote) classified += rows.length;
          else errors += rows.length;
        }

        process.stderr.write('.');
      } catch (error) {
        errors += batch.length;
        process.stderr.write(`x(${String(error.message || error).slice(0, 240)}) `);
      }

      await sleep(SLEEP_MS);
    }

    processed += pageSlice.length;
    console.log(`\nProcessed: ${processed.toLocaleString()}/${target.toLocaleString()}, classified: ${classified.toLocaleString()}, errors: ${errors}, qwen reqs: ${totalRequests}`);
  }

  console.log('\n=== Done ===');
  console.log(`Processed: ${processed.toLocaleString()}`);
  console.log(`Classified: ${classified.toLocaleString()}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total Qwen requests: ${totalRequests}\n`);
  running = false;
}

main().catch((error) => {
  running = false;
  console.error('Fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
