#!/usr/bin/env node
/**
 * Rule-based SMS pre-classifier.
 *
 * For papers with unambiguous methodology phrases in title or abstract,
 * assign SMS + methodology_design + causal_strength deterministically.
 * Ambiguous papers (no clear method, multiple methods, weak signals) are
 * left NULL for the Qwen classifier to handle.
 *
 * Writes:
 *   sms_level, methodology_design, causal_strength
 *   sms_method = 'keyword'  (distinguishes from 'qwen_llm', 'manual')
 *   sms_rationale = the matched phrase
 *
 * Idempotent. Only writes where sms_level IS NULL.
 *
 * Usage:
 *   node scripts/classify-sms-keywords.mjs --dry-run --limit 5000
 *   node scripts/classify-sms-keywords.mjs --venues "World Development,Econometrica,Journal of Health Economics"
 *   node scripts/classify-sms-keywords.mjs --ids-file reports/priority-missing-abstracts-wd-econometrica-jhe-2026-05-21.json
 *   node scripts/classify-sms-keywords.mjs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();
const argValue = (name, fallback = null) => {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VENUES = String(argValue('--venues', ''))
  .split(',')
  .map((venue) => venue.trim())
  .filter(Boolean);
const IDS_FILE = argValue('--ids-file', null);
const IDS = String(argValue('--ids', ''))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const ABSTRACT_PRESENT = args.includes('--abstract-present');
const TARGET_IDS = [...new Set([...IDS, ...loadIdsFile(IDS_FILE)])];

const PAGE = 1000;
const CONCURRENCY = 20;

function loadIdsFile(filePath) {
  if (!filePath) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
  return rows.map((row) => String(row?.id || '').trim()).filter(Boolean);
}

function applyScopeFilters(query) {
  if (VENUES.length) query = query.in('venue', VENUES);
  if (ABSTRACT_PRESENT) query = query.not('abstract', 'is', null);
  return query;
}

// V2 patterns — captures phrasings papers actually use, not just formal terms.
// Lesson from V1 (1.9% match rate, only 146 RCTs found): regex was too strict.
// Real economics/social science papers describe findings, not "randomized
// controlled trial" verbatim. They say "we randomly assigned," "field
// experiment," "natural experiment," "exploit policy variation," etc.
//
// V2 expands each method tier ~3-4x and softens the match rule: take the
// strongest matching tier rather than requiring exactly 1 match.
//
// Each rule: { re, sms, design, strength, label }.
const RULES = [
  // ─────── SMS 5 — Experimental / RCT ───────
  { re: /\brandomi[zs]ed\s+controlled\s+trial(s)?\b/i,                     sms: 5, design: 'RCT', strength: 'high', label: 'RCT' },
  { re: /\bcluster[\s-]?randomi[zs]ed\b/i,                                 sms: 5, design: 'RCT', strength: 'high', label: 'cluster-RCT' },
  { re: /\brandomi[zs]ed\s+(?:experiment|field\s+experiment|evaluation|trial|intervention)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'randomized-experiment' },
  { re: /\bfield\s+experiment(?:al)?\b/i,                                  sms: 5, design: 'RCT', strength: 'high', label: 'field-experiment' },
  { re: /\bwe\s+randomly\s+assign(?:ed)?\b/i,                              sms: 5, design: 'RCT', strength: 'high', label: 'we-randomly-assigned' },
  { re: /\brandomly\s+assigned\s+(?:to|treatment|subjects|participants|households|firms|villages|schools|patients|individuals)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'randomly-assigned-to' },
  { re: /\brandom\s+assignment\s+(?:of|to|design)\b/i,                     sms: 5, design: 'RCT', strength: 'high', label: 'random-assignment' },
  { re: /\b(?:we|authors?)\s+(?:conduct|conducted|ran|run|implement(?:ed)?)\s+(?:a\s+)?(?:randomi[zs]ed|field)\s+(?:experiment|trial|evaluation)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'we-conducted-experiment' },
  { re: /\bexperimental\s+(?:evaluation|design|evidence)\s+(?:of|from|in)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'experimental-evaluation' },
  { re: /\b(?:treatment|intervention)\s+(?:was|were)\s+randomi[zs]ed\b/i,   sms: 5, design: 'RCT', strength: 'high', label: 'treatment-randomized' },
  { re: /\blottery[\s-]?(?:based|design|allocation|admission|assignment)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'lottery-based' },
  { re: /\bencouragement\s+design\b/i,                                     sms: 5, design: 'RCT', strength: 'high', label: 'encouragement-design' },
  { re: /\b(?:double|single)[\s-]?blind(?:ed)?\s+(?:trial|study|experiment)\b/i, sms: 5, design: 'RCT', strength: 'high', label: 'blind-trial' },
  { re: /\bA\/B\s+test(?:ing)?\b/,                                         sms: 5, design: 'RCT', strength: 'high', label: 'AB-test' },

  // ─────── SMS 4 — Strong quasi-experimental ───────
  // DiD
  { re: /\bdifference[\s-]?in[\s-]?differences?\b/i,                       sms: 4, design: 'DiD', strength: 'high', label: 'DiD' },
  { re: /\bdiff[\s-]?in[\s-]?diff\b/i,                                     sms: 4, design: 'DiD', strength: 'high', label: 'diff-in-diff' },
  { re: /\btriple[\s-]?difference(?:s)?\b/i,                               sms: 4, design: 'DiD', strength: 'high', label: 'triple-diff' },
  { re: /\bevent[\s-]?study(?:\s+design)?\b/i,                             sms: 4, design: 'DiD', strength: 'high', label: 'event-study' },
  { re: /\bstaggered\s+(?:treatment|adoption|rollout|implementation)\b/i,  sms: 4, design: 'DiD', strength: 'high', label: 'staggered-DiD' },
  { re: /\bparallel\s+trends?\s+assumption\b/i,                            sms: 4, design: 'DiD', strength: 'high', label: 'parallel-trends' },

  // RDD
  { re: /\bregression\s+discontinuity(?:\s+design)?\b/i,                   sms: 4, design: 'RDD', strength: 'high', label: 'RDD' },
  { re: /\bsharp\s+(?:regression\s+)?discontinuity\b/i,                    sms: 4, design: 'RDD', strength: 'high', label: 'sharp-RDD' },
  { re: /\bfuzzy\s+(?:regression\s+)?discontinuity\b/i,                    sms: 4, design: 'RDD', strength: 'high', label: 'fuzzy-RDD' },
  { re: /\b(?:cutoff|threshold|eligibility)\s+(?:rule|criterion)\b/i,      sms: 4, design: 'RDD', strength: 'high', label: 'cutoff-rule' },

  // IV
  { re: /\binstrumental\s+variable(?:s)?\b/i,                              sms: 4, design: 'IV',  strength: 'high', label: 'IV' },
  { re: /\b(?:we\s+)?(?:use|using|employ|exploit)\s+\w+\s+as\s+an?\s+instrument\b/i, sms: 4, design: 'IV',  strength: 'high', label: 'X-as-instrument' },
  { re: /\b(?:we\s+)?instrument\s+(?:for|using)\b/i,                       sms: 4, design: 'IV',  strength: 'high', label: 'we-instrument' },
  { re: /\bplausibly\s+exogenous\b/i,                                      sms: 4, design: 'IV',  strength: 'high', label: 'plausibly-exogenous' },
  { re: /\bexogenous\s+(?:variation|shock|change|reform)\b/i,              sms: 4, design: 'IV',  strength: 'high', label: 'exogenous-variation' },
  { re: /\bas[\s-]?if\s+(?:random|exogenous)\b/i,                          sms: 4, design: 'IV',  strength: 'high', label: 'as-if-random' },
  { re: /\b2SLS\b|\btwo[\s-]?stage\s+least\s+squares\b/i,                  sms: 4, design: 'IV',  strength: 'high', label: '2SLS' },
  { re: /\bShift[\s-]?share\s+instrument\b/i,                              sms: 4, design: 'IV',  strength: 'high', label: 'shift-share' },
  { re: /\bBartik\s+instrument\b/i,                                        sms: 4, design: 'IV',  strength: 'high', label: 'Bartik' },

  // Natural experiment
  { re: /\bnatural\s+experiment\b/i,                                       sms: 4, design: 'NaturalExperiment',  strength: 'high', label: 'natural-experiment' },
  { re: /\bquasi[\s-]?experiment(?:al)?\s+(?:design|evidence|study|setting|approach)\b/i, sms: 4, design: 'NaturalExperiment', strength: 'high', label: 'quasi-experiment' },

  // Synthetic control
  { re: /\bsynthetic\s+control(?:\s+method)?\b/i,                          sms: 4, design: 'SyntheticControl', strength: 'high', label: 'synthetic-control' },

  // Policy/reform exploitation (often DiD/IV but ambiguous)
  { re: /\b(?:we\s+)?exploit\s+(?:a\s+|the\s+)?(?:exogenous|quasi-?random|policy|legislative|regulatory)\s+(?:shock|variation|change|reform|cutoff)\b/i, sms: 4, design: 'NaturalExperiment', strength: 'high', label: 'exploit-policy' },
  { re: /\bpolicy\s+(?:change|reform|introduction|expansion)\s+(?:as|provides|allows|enables|creates)\b/i, sms: 4, design: 'NaturalExperiment', strength: 'high', label: 'policy-change-leverage' },

  // ─────── SMS 3 — Weaker quasi-experimental ───────
  { re: /\bpropensity\s+score\s+matching\b/i,                              sms: 3, design: 'PSM', strength: 'moderate', label: 'PSM' },
  { re: /\bcoarsened\s+exact\s+matching\b/i,                               sms: 3, design: 'Matching', strength: 'moderate', label: 'CEM' },
  { re: /\bnearest[\s-]?neighbor\s+matching\b/i,                           sms: 3, design: 'Matching', strength: 'moderate', label: 'NN-matching' },
  { re: /\b(?:two[\s-]?way\s+)?fixed[\s-]?effects?\s+(?:model|regression|estimation|approach)\b/i, sms: 3, design: 'FixedEffects', strength: 'moderate', label: 'FE-model' },
  { re: /\bpanel\s+(?:data\s+)?(?:fixed[\s-]?effects?|regression\s+with\s+fixed[\s-]?effects?)\b/i, sms: 3, design: 'FixedEffects', strength: 'moderate', label: 'panel-FE' },
  { re: /\bentropy\s+balancing\b/i,                                        sms: 3, design: 'Matching', strength: 'moderate', label: 'entropy-balancing' },
  { re: /\binverse[\s-]?probability\s+(?:of\s+treatment\s+)?weighting\b/i, sms: 3, design: 'Matching', strength: 'moderate', label: 'IPW' },
  { re: /\bdifference[\s-]?in[\s-]?means\s+with\s+(?:controls|adjustment)\b/i, sms: 3, design: 'FixedEffects', strength: 'moderate', label: 'DiM-controls' },

  // ─────── SMS 2 — Multivariate regression with controls ───────
  { re: /\b(?:multivariate|multiple)\s+regression\s+(?:analysis|with\s+controls)\b/i, sms: 2, design: 'Observational', strength: 'limited', label: 'multivariate-regression' },
  { re: /\b(?:ordinary\s+least\s+squares|\bOLS)\s+regression\b/i,          sms: 2, design: 'Observational', strength: 'limited', label: 'OLS' },
  { re: /\b(?:logit|probit)\s+(?:model|regression|analysis)\b/i,           sms: 2, design: 'Observational', strength: 'limited', label: 'logit-probit' },
  { re: /\bcross[\s-]?sectional\s+(?:analysis|regression|study|data)\b/i,  sms: 2, design: 'Observational', strength: 'limited', label: 'cross-sectional' },
  { re: /\b(?:cox\s+)?proportional[\s-]?hazards?\b/i,                      sms: 2, design: 'Observational', strength: 'limited', label: 'cox-hazards' },
  { re: /\bhierarchical\s+(?:linear\s+)?model(?:ing|s)?\b/i,               sms: 2, design: 'Observational', strength: 'limited', label: 'HLM' },
  { re: /\bstructural\s+equation\s+modeling\b/i,                           sms: 2, design: 'Observational', strength: 'limited', label: 'SEM' },

  // ─────── SMS 1 — Qualitative / descriptive / theoretical / review ───────
  { re: /\b(?:qualitative|ethnographic)\s+(?:study|analysis|research|interviews?|methods?)\b/i, sms: 1, design: 'Qualitative', strength: 'signal', label: 'qualitative' },
  { re: /\bsemi[\s-]?structured\s+interviews?\b/i,                         sms: 1, design: 'Qualitative', strength: 'signal', label: 'interviews' },
  { re: /\b(?:focus\s+groups?|grounded\s+theory|case\s+study)\b/i,         sms: 1, design: 'Qualitative', strength: 'signal', label: 'case-study' },
  { re: /\bsystematic\s+(?:literature\s+)?review\b/i,                      sms: 1, design: 'Review', strength: 'signal', label: 'systematic-review' },
  { re: /\bmeta[\s-]?analysis\b/i,                                         sms: 1, design: 'Review', strength: 'signal', label: 'meta-analysis' },
  { re: /\bscoping\s+review\b/i,                                           sms: 1, design: 'Review', strength: 'signal', label: 'scoping-review' },
  { re: /\bnarrative\s+(?:literature\s+)?review\b/i,                       sms: 1, design: 'Review', strength: 'signal', label: 'narrative-review' },
  { re: /\btheoretical\s+(?:model|framework|analysis|paper|contribution)\b/i, sms: 1, design: 'Theoretical', strength: 'signal', label: 'theoretical' },
  { re: /\bsimulation\s+(?:model|study|results?|exercise)\b/i,             sms: 1, design: 'Simulation', strength: 'signal', label: 'simulation' },
  { re: /\bagent[\s-]?based\s+model(?:ing)?\b/i,                           sms: 1, design: 'Simulation', strength: 'signal', label: 'ABM' },
  { re: /\bgeneral\s+equilibrium\s+(?:model|analysis)\b/i,                 sms: 1, design: 'Theoretical', strength: 'signal', label: 'GE-model' },
  { re: /\bdescriptive\s+(?:analysis|statistics|study)\b/i,                sms: 1, design: 'Descriptive', strength: 'signal', label: 'descriptive' },
];

function classify(work) {
  const haystack = `${work.title || ''} ${work.abstract || ''}`;
  if (haystack.trim().length < 30) return null;

  // Collect ALL matches (not just the first). Then take the strongest by SMS tier.
  // Rationale: many papers describe both an experimental method and a robustness
  // check (e.g. "we conducted a field experiment ... and used a propensity score
  // matching as a robustness check"). Strongest method wins.
  const matches = [];
  for (const rule of RULES) {
    if (rule.re.test(haystack)) matches.push(rule);
  }

  if (matches.length === 0) return null;

  // Pick the strongest match: highest SMS first, then by source-order (more
  // specific rules come earlier in the RULES array).
  const best = matches.sort((a, b) => b.sms - a.sms)[0];
  const allLabels = matches.map((m) => m.label).join(', ');

  // Tag confidence: if there's only one match OR all matches agree on SMS, mark
  // as 'keyword' (high confidence). If multiple SMS tiers matched, mark as
  // 'keyword_weak' so the Qwen pass can revisit if quality is a concern.
  const sameTier = matches.every((m) => m.sms === best.sms);
  const method = matches.length === 1 || sameTier ? 'keyword' : 'keyword_weak';

  return {
    sms_level: best.sms,
    methodology_design: best.design,
    causal_strength: best.strength,
    sms_method: method,
    sms_rationale: matches.length === 1
      ? `Keyword match: ${best.label}`
      : `Keyword strongest=${best.label} (matched: ${allLabels})`,
  };
}

async function* iterateTargets() {
  if (TARGET_IDS.length) {
    let yielded = 0;
    for (let from = 0; from < TARGET_IDS.length && yielded < LIMIT; from += 100) {
      const ids = TARGET_IDS.slice(from, from + 100);
      const take = Math.min(PAGE, LIMIT - yielded);
      if (take <= 0) break;
      const { data, error } = await applyScopeFilters(
        supabase
          .from('works')
          .select('id, title, abstract')
          .is('sms_level', null)
          .in('id', ids)
          .order('id', { ascending: true })
          .range(0, take - 1),
      );
      if (error) throw new Error(`target ids fetch failed: ${error.message}`);
      if (data?.length) {
        yielded += data.length;
        yield data;
      }
    }
    return;
  }

  let offset = 0;
  let processed = 0;
  let lastSeenId = null;
  while (offset < LIMIT) {
    const remaining = LIMIT - processed;
    const pageEnd = Math.min(PAGE, remaining) - 1;
    if (pageEnd < 0) break;

    let query = supabase
      .from('works')
      .select('id, title, abstract')
      .is('sms_level', null)
      .order('id', { ascending: true });
    query = applyScopeFilters(query);

    // In apply mode, cursor by id instead of offset. Offset pagination skips
    // rows as updates remove them from the null-SMS target set; repeatedly
    // reading from offset 0 stalls if the frontier contains ambiguous rows.
    if (DRY_RUN) {
      query = query.range(offset, offset + pageEnd);
    } else {
      if (lastSeenId) query = query.gt('id', lastSeenId);
      query = query.range(0, pageEnd);
    }

    const { data, error } = await query;
    if (error) {
      if (error.message?.includes('terminated')) {
        console.error(`  [retry] page ${offset} terminated, waiting 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`targets fetch failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    lastSeenId = data[data.length - 1].id;
    yield data;
    if (data.length < PAGE) break;
    processed += data.length;
    if (DRY_RUN) offset += PAGE;
  }
}

async function applyUpdates(updates) {
  if (updates.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (u) => {
        const { id, ...fields } = u;
        try {
          const { error } = await supabase.from('works').update(fields).eq('id', id);
          if (error) {
            console.error(`  [warn] update ${id}: ${error.message}`);
            return false;
          }
          return true;
        } catch (err) {
          console.error(`  [warn] update ${id} threw: ${err.message}`);
          return false;
        }
      }),
    );
    ok += results.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('='.repeat(70));
  console.log('SMS rule-based pre-classifier');
  console.log('='.repeat(70));
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit:   ${LIMIT === Infinity ? '(unlimited)' : LIMIT.toLocaleString()}\n`);
  console.log(`Venues:  ${VENUES.length ? VENUES.join(', ') : 'any'}`);
  console.log(`IDs:     ${TARGET_IDS.length || 'none'}${IDS_FILE ? ` (from ${IDS_FILE})` : ''}`);
  console.log(`Abstract present only: ${ABSTRACT_PRESENT ? 'yes' : 'no'}\n`);

  let processed = 0;
  let classified = 0;
  let writtenTotal = 0;
  const designCounts = new Map();

  for await (const page of iterateTargets()) {
    const updates = [];
    for (const w of page) {
      processed += 1;
      const result = classify(w);
      if (result) {
        classified += 1;
        designCounts.set(result.methodology_design, (designCounts.get(result.methodology_design) || 0) + 1);
        updates.push({ id: w.id, ...result });
      }
    }
    if (!DRY_RUN && updates.length > 0) {
      const ok = await applyUpdates(updates);
      writtenTotal += ok;
    }
    console.log(`  ${processed.toLocaleString()} scanned · ${classified.toLocaleString()} classified (${((classified / processed) * 100).toFixed(1)}%) · ${writtenTotal.toLocaleString()} written`);
  }

  console.log('\nDistribution by design:');
  const sorted = [...designCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [d, c] of sorted) {
    console.log(`  ${d.padEnd(20)} ${c.toLocaleString()}`);
  }
  console.log(`\nClassified: ${classified.toLocaleString()} of ${processed.toLocaleString()} scanned`);
  console.log(`Remaining for Qwen: ${(processed - classified).toLocaleString()}`);
}

main().catch((err) => {
  console.error('[classify-sms-keywords] failed:', err.message);
  process.exit(1);
});
