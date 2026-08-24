#!/usr/bin/env node
/**
 * LLM-based SMS (Strength of Method/Study) classifier.
 * Re-classifies papers where the regex-based smsClassifier returned null,
 * using Groq Llama 3.3 70B for batched, cheap, semantic classification.
 *
 * Output for each paper:
 *   - sms_level: 1-5 (1=qualitative, 5=RCT)
 *   - methodology_design: e.g., RCT, DiD, IV, RDD, Synthetic Control,
 *                              PSM, Observational, Qualitative, Theoretical, Review
 *   - sms_method: 'groq_llm'
 *   - sms_rationale: short LLM justification
 *   - raw_data.sms_llm_classified: true
 *
 * Cost: Free under Groq free tier (~14.4k requests/day). 188k papers / 20 per
 * batch = 9.4k requests — fits in a single day's quota.
 *
 * Usage:
 *   node scripts/classify-sms-llm.mjs                # all unclassified
 *   node scripts/classify-sms-llm.mjs --dry-run     # show sample, no write
 *   node scripts/classify-sms-llm.mjs --limit 100   # cap at N papers
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const flagValue = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt(flagValue('--limit', '0')) || null;
const CANDIDATES_PATH = flagValue('--candidates', null);
const CANDIDATE_BUCKET = flagValue('--candidate-bucket', 'all');
const VENUES = String(flagValue('--venues', ''))
  .split(',')
  .map((venue) => venue.trim())
  .filter(Boolean);
const ABSTRACT_PRESENT = args.includes('--abstract-present');

// Groq pricing: free tier — track requests instead of dollars
const MAX_COST_USD = parseFloat(process.env.MAX_COST_USD || '20'); // unused for Groq free tier
const CHARS_PER_TOKEN = 4;

// Tuned for Groq free tier. The bottleneck is tokens-per-minute (~8k TPM for
// gpt-oss-20b), not RPM. Small batches + short abstracts + long sleeps keep
// us under TPM while still making steady progress. Override via env vars.
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '3');
const PAGE_SIZE  = 30;
const ABSTRACT_CAP = parseInt(process.env.ABSTRACT_CAP || '800');
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// 12s sleep = 5 RPM. With BATCH_SIZE=5 and 800-char abstracts that's
// ~3k tokens/req × 5/min = 15k TPM — slightly over 8k cap so 429s expected,
// but the long backoff in callGroq() handles it gracefully.
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '12000');
// Stop before exhausting daily TPD + connection pool (run frequently to avoid pool exhaustion)
const MAX_REQUESTS_PER_RUN = parseInt(process.env.MAX_REQUESTS || '1500');

let totalInputChars = 0;
let totalOutputChars = 0;
let totalRequests = 0;
let targetPapers = null;

function estimatedCostUSD() {
  return 0; // Groq free tier
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SYSTEM_PROMPT = `You classify research papers by methodological rigor for causal evidence.

For each paper, return a JSON object with:
  level: integer 1-5 where:
    5 = Randomized controlled trial (RCT) — random assignment to treatment
    4 = Quasi-experimental with strong identification (DiD, IV, RDD, Synthetic Control, regression discontinuity)
    3 = Matched comparison (propensity score matching, exact matching, coarsened exact matching)
    2 = Observational with controls (panel data, fixed effects, cross-sectional regression, before-after)
    1 = Qualitative, descriptive, theoretical, review, or unclassifiable
  design: short label, one of: RCT, DiD, IV, RDD, Synthetic, PSM, Observational, Qualitative, Theoretical, Review, Other
  rationale: one sentence (max 100 chars) explaining the classification

Rules:
- If the abstract mentions multiple methods, pick the strongest one used for the main causal claim.
- If methodology is unclear or absent, default to level=1, design=Other.
- Reviews and meta-analyses get design=Review, level varies by what they synthesize (RCTs → 4, mixed → 2).
- Theoretical/model papers get design=Theoretical, level=1.

Return strictly a JSON object with one key "classifications" containing an array of result objects, one per paper, in the same order as input. No prose, no markdown.`;

function buildBatchPrompt(papers) {
  const items = papers.map((p, i) => {
    const text = `${p.title || '(no title)'}\n${(p.abstract || '').slice(0, ABSTRACT_CAP)}`;
    return `### Paper ${i + 1}\n${text}`;
  }).join('\n\n');
  return `${SYSTEM_PROMPT}\n\nClassify these ${papers.length} papers:\n\n${items}\n\nReturn the JSON object now.`;
}

async function callGroq(prompt) {
  const body = {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      totalRequests++;
      if (!res.ok) {
        process.stderr.write(`G${res.status} `);
        if (res.status === 429 || res.status === 503) {
          // Free-tier TPM bucket resets every ~60s. Wait long enough for it
          // to refill rather than hammering with small backoffs.
          await sleep(60_000);
          continue;
        }
        if (res.status >= 500) { await sleep(attempt * 3000); continue; }
        return null;
      }
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content;
      if (!out) { process.stderr.write('!empty '); return null; }
      try {
        const parsed = JSON.parse(out);
        // We asked for a JSON array but Groq response_format=json_object wraps
        // arrays under a key. Handle both shapes.
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.classifications)) return parsed.classifications;
        if (Array.isArray(parsed.results)) return parsed.results;
        if (Array.isArray(parsed.papers)) return parsed.papers;
        // Fall back: take first array-valued key
        for (const k of Object.keys(parsed)) {
          if (Array.isArray(parsed[k])) return parsed[k];
        }
        process.stderr.write('!shape ');
        return null;
      } catch {
        process.stderr.write('!parse ');
        return null;
      }
    } catch (err) {
      process.stderr.write(`!(${err.message?.slice(0, 20)}) `);
      await sleep(attempt * 3000);
    }
  }
  return null;
}

function classToRow(p, c) {
  if (!c || typeof c.level !== 'number') return null;
  const level = Math.max(1, Math.min(5, parseInt(c.level)));
  const design = String(c.design || 'Other').slice(0, 30);
  return {
    id: p.id,
    source: p.source,
    abs_rating: p.abs_rating,
    repec_percentile: p.repec_percentile,
    title: p.title || '[No title]',
    sms_level: level,
    methodology_design: design,
    causal_strength: level >= 4 ? 'high' : level >= 3 ? 'moderate' : 'limited',
    sms_method: 'groq_llm',
    sms_rationale: String(c.rationale || '').slice(0, 200),
    updated_at: new Date().toISOString(),
  };
}

async function getMissingCount() {
  if (targetPapers) return targetPapers.length;
  let query = supabase
    .from('works').select('id', { count: 'exact', head: true })
    .is('sms_level', null);
  if (VENUES.length) query = query.in('venue', VENUES);
  if (ABSTRACT_PRESENT) query = query.not('abstract', 'is', null).neq('abstract', '');
  const { count } = await query;
  return count || 0;
}

function loadCandidateIds() {
  if (!CANDIDATES_PATH) return null;
  if (!['all', 'canary', 'econ'].includes(CANDIDATE_BUCKET)) {
    console.error(`Invalid --candidate-bucket: ${CANDIDATE_BUCKET} (expected all, canary, or econ)`);
    process.exit(1);
  }
  const candidates = JSON.parse(readFileSync(CANDIDATES_PATH, 'utf8'));
  const ids = [];
  if (CANDIDATE_BUCKET === 'all' || CANDIDATE_BUCKET === 'canary') {
    ids.push(...(candidates.canary_missing_metadata ?? []).map((paper) => paper.id));
  }
  if (CANDIDATE_BUCKET === 'all' || CANDIDATE_BUCKET === 'econ') {
    ids.push(...(candidates.econ_venue_tier ?? []).map((paper) => paper.id));
  }
  return [...new Set(ids)].filter(Boolean);
}

async function loadTargetPapers(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    let query = supabase
      .from('works')
      .select('id, title, abstract, source, abs_rating, repec_percentile, sms_level')
      .in('id', chunk)
      .is('sms_level', null);
    if (VENUES.length) query = query.in('venue', VENUES);
    if (ABSTRACT_PRESENT) query = query.not('abstract', 'is', null).neq('abstract', '');
    const { data, error } = await query;
    if (error) throw new Error(`target fetch chunk=${i}: ${error.message}`);
    out.push(...(data ?? []));
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

async function fetchBatch(offset, attempt = 1) {
  if (targetPapers) {
    return targetPapers.slice(offset, offset + PAGE_SIZE);
  }
  let query = supabase
    .from('works').select('id, title, abstract, source, abs_rating, repec_percentile')
    .is('sms_level', null);
  if (VENUES.length) query = query.in('venue', VENUES);
  if (ABSTRACT_PRESENT) query = query.not('abstract', 'is', null).neq('abstract', '');
  const { data, error } = await query
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) {
    if (attempt < 3 && error.message?.includes('connection pool')) {
      process.stderr.write(`[retry fetch ${attempt}] `);
      await sleep(5000 * attempt);
      return fetchBatch(offset, attempt + 1);
    }
    console.error('Fetch error:', error.message);
    return [];
  }
  return data || [];
}

async function upsertClassified(rows, attempt = 1) {
  if (!rows.length) return;
  const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id' });
  if (error) {
    if (attempt < 3 && error.message?.includes('connection pool')) {
      process.stderr.write(`[upsert retry ${attempt}] `);
      await sleep(3000 * attempt);
      return upsertClassified(rows, attempt + 1);
    }
    console.error('\n  Upsert error:', error.message);
  }
}

async function main() {
  console.log(`\n=== LLM SMS Classifier (Groq) ===`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT || 'none'}`);
  console.log(`Venues: ${VENUES.length ? VENUES.join(', ') : 'any'}`);
  console.log(`Abstract present only: ${ABSTRACT_PRESENT ? 'yes' : 'no'}`);
  if (CANDIDATES_PATH) {
    console.log(`Candidates: ${CANDIDATES_PATH} (${CANDIDATE_BUCKET})`);
  }
  console.log(`Model: ${GROQ_MODEL}`);
  console.log(`Batch: ${BATCH_SIZE}, sleep: ${SLEEP_MS}ms, max reqs/run: ${MAX_REQUESTS_PER_RUN}\n`);
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY not set in .env. Add it and try again.');
    process.exit(1);
  }

  const candidateIds = loadCandidateIds();
  if (candidateIds) {
    targetPapers = await loadTargetPapers(candidateIds);
    console.log(`Candidate ids: ${candidateIds.length.toLocaleString()}`);
    console.log(`Candidates still needing classification: ${targetPapers.length.toLocaleString()}\n`);
  }

  const total = await getMissingCount();
  console.log(`Papers needing classification: ${total.toLocaleString()}\n`);

  let processed = 0;
  let classified = 0;
  let errors = 0;
  const target = LIMIT ? Math.min(LIMIT, total) : total;

  while (processed < target) {
    // Daily budget guard — stop and let user resume tomorrow on a new TPD bucket
    if (totalRequests >= MAX_REQUESTS_PER_RUN) {
      console.log(`\n⚠ Hit per-run request cap (${totalRequests}). Stopping cleanly — re-run script to resume from current sms_level=null cursor.`);
      break;
    }

    const batchOffset = DRY_RUN || targetPapers ? processed : 0;
    const batch = (await fetchBatch(batchOffset)).slice(0, target - processed);
    if (!batch.length) break;

    // Process in BATCH_SIZE chunks within the page
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const slice = batch.slice(i, i + BATCH_SIZE);
      const prompt = buildBatchPrompt(slice);
      totalInputChars += prompt.length;

      const result = await callGroq(prompt);
      if (!Array.isArray(result) || result.length !== slice.length) {
        errors += slice.length;
        process.stderr.write('x');
        await sleep(SLEEP_MS);
        continue;
      }

      const rows = slice.map((p, j) => classToRow(p, result[j])).filter(Boolean);
      classified += rows.length;
      errors += slice.length - rows.length;

      if (DRY_RUN) {
        if (i === 0 && processed === 0) {
          console.log('Sample classifications:');
          for (let k = 0; k < Math.min(5, rows.length); k++) {
            const p = slice[k]; const r = rows[k];
            console.log(`  [${r.sms_level}/${r.methodology_design}] ${p.title?.slice(0, 60)} — ${r.sms_rationale?.slice(0, 60)}`);
          }
        }
      } else {
        await upsertClassified(rows);
      }

      process.stderr.write('.');
      await sleep(SLEEP_MS);
    }

    processed += batch.length;
    console.log(`\nProcessed: ${processed.toLocaleString()}/${target.toLocaleString()}, classified: ${classified.toLocaleString()}, errors: ${errors} | ${totalRequests} Groq reqs`);
  }

  console.log(`\n=== Done ===`);
  console.log(`  Processed: ${processed.toLocaleString()}`);
  console.log(`  Classified: ${classified.toLocaleString()}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total Groq requests: ${totalRequests}\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
