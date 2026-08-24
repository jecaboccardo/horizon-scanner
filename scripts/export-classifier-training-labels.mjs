/**
 * scripts/export-classifier-training-labels.mjs
 *
 * Export classifier training labels for retraining the Tier-2 trained
 * classifier. Pulls auto-collected verdicts from `classifier_training_labels`
 * (populated by llmJudgeClassifier.ts when CLASSIFIER_LABEL_LOGGING=true),
 * optionally merges them with the original ~459 human labels in
 * `evals/queries.json`, and writes a queries.json-shaped output file that
 * the existing build-classifier-training-set.mjs feature builder can consume.
 *
 * Workflow once enough rows are collected:
 *   1. node scripts/export-classifier-training-labels.mjs --merge-with-human
 *        # → writes evals/classifier-training-labels-merged-YYYY-MM-DD.json
 *   2. node scripts/build-classifier-training-set.mjs \
 *        --labels evals/classifier-training-labels-merged-YYYY-MM-DD.json
 *        # → writes evals/classifier-training-set-YYYY-MM-DD.csv with the
 *        #   18-feature vectors + label columns
 *   3. python scripts/train-classifier.py \
 *        --csv evals/classifier-training-set-YYYY-MM-DD.csv
 *        # → writes evals/classifier-trained-YYYY-MM-DD.pkl + reports/...md
 *   4. Paste the new model JSON into supabase/functions/_shared/trainedClassifier.ts
 *      (or load it via the existing ensureLoaded() path).
 *
 * Flags:
 *   --merge-with-human      Combine auto-labels with the human-labeled set in
 *                           evals/queries.json. Human label always wins on conflict.
 *   --auto-only             Use ONLY auto-collected labels, no humans.
 *   --since YYYY-MM-DD      Only include auto-labels created on/after this date.
 *   --min-per-query N       Drop queries with fewer than N labels (default 3).
 *   --max-per-query N       Cap labels per query (default unbounded; helps
 *                           prevent any single query from dominating training).
 *   --dedup keep-newest|keep-oldest
 *                           When the same (paper, query) has multiple auto-labels
 *                           (e.g. user re-ran the same search), keep newest by
 *                           default.
 *   --out PATH              Output file (default: evals/classifier-training-
 *                           labels-merged-YYYY-MM-DD.json).
 *   --dry-run               Print stats only, don't write the file.
 *   --stats-only            Print stats without fetching paper details from
 *                           works table (very fast — useful to check coverage
 *                           before committing to a full export).
 *
 * Auto-label → human-label mapping:
 *   direct-lac | direct-global  →  relevant     (label_int=2)
 *   indirect                    →  partial      (label_int=1)
 *   excluded                    →  irrelevant   (label_int=0)
 *
 * Quality filters:
 *   - Only pulls rows with label_source='llm_judge' by default (skip cosine
 *     seed loops, skip trained-classifier self-labels — those would create
 *     a feedback loop). Override with --include-sources=...
 *   - Drops rows missing canonical_doi (can't join to works table later).
 *   - Drops rows with classification not in the four expected values.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '..', 'evals', 'queries.json');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
const ARGS = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = ARGS.indexOf(k);
  return i >= 0 && i < ARGS.length - 1 ? ARGS[i + 1] : d;
};
const hasArg = (k) => ARGS.includes(k);

const MERGE_HUMAN = hasArg('--merge-with-human');
const AUTO_ONLY   = hasArg('--auto-only');
const SINCE       = arg('--since');
const MIN_PER_Q   = Number(arg('--min-per-query', '3'));
const MAX_PER_Q   = arg('--max-per-query') ? Number(arg('--max-per-query')) : null;
const DEDUP       = arg('--dedup', 'keep-newest');
const OUT_PATH    = arg('--out',
  join(__dir, '..', 'evals', `classifier-training-labels-merged-${new Date().toISOString().slice(0, 10)}.json`));
const DRY_RUN     = hasArg('--dry-run');
const STATS_ONLY  = hasArg('--stats-only');
const INCLUDE_SOURCES = (arg('--include-sources', 'llm_judge,human') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (MERGE_HUMAN && AUTO_ONLY) {
  console.error('Cannot use --merge-with-human and --auto-only together');
  process.exit(1);
}
if (!MERGE_HUMAN && !AUTO_ONLY) {
  console.error('Specify one of: --merge-with-human  |  --auto-only');
  console.error('(--merge-with-human is usually what you want — humans are a small set but ground truth)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normDoi(d) {
  return String(d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

// Map classifier classification → human-style label
function autoToHumanLabel(cls) {
  if (cls === 'direct-lac' || cls === 'direct-global') return 'relevant';
  if (cls === 'indirect') return 'partial';
  if (cls === 'excluded') return 'irrelevant';
  return null;
}

// ---------------------------------------------------------------------------
// Fetch auto-labels from DB
// ---------------------------------------------------------------------------
console.log('Fetching classifier_training_labels rows...');
let rowsAll = [];
let pageStart = 0;
const PAGE = 1000;
while (true) {
  let q = SB.from('classifier_training_labels')
    .select('id, paper_id, canonical_doi, query, classification, label_source, llm_rationale, llm_model, paper_title, paper_year, search_run_id, tenant_id, created_at')
    .order('created_at', { ascending: false })
    .range(pageStart, pageStart + PAGE - 1);
  if (SINCE) q = q.gte('created_at', SINCE);
  if (INCLUDE_SOURCES.length) q = q.in('label_source', INCLUDE_SOURCES);
  const { data, error } = await q;
  if (error) {
    // Table may not exist on a fresh deploy yet — handle gracefully.
    if (/relation .* does not exist/i.test(error.message)) {
      console.warn('Table classifier_training_labels does not exist yet — apply migration 20260519000004 first.');
      rowsAll = [];
      break;
    }
    console.error('DB error:', error.message);
    process.exit(1);
  }
  rowsAll.push(...(data ?? []));
  if (!data || data.length < PAGE) break;
  pageStart += PAGE;
}
console.log(`Pulled ${rowsAll.length} auto-label rows`);

// Filter to rows we can actually use
const validAuto = rowsAll.filter((r) =>
  r.canonical_doi &&
  ['direct-lac', 'direct-global', 'indirect', 'excluded'].includes(r.classification)
);
console.log(`${validAuto.length} usable (have canonical_doi + valid classification)`);

// ---------------------------------------------------------------------------
// Load human labels
// ---------------------------------------------------------------------------
const humanQueries = (() => {
  if (AUTO_ONLY) return null;
  if (!existsSync(QUERIES_PATH)) {
    console.warn(`evals/queries.json not found — using auto-only despite --merge-with-human`);
    return null;
  }
  const j = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  return j.queries.filter((q) => q.labels && Object.keys(q.labels).length > 0);
})();
const humanCount = humanQueries ? humanQueries.reduce((s, q) => s + Object.keys(q.labels).length, 0) : 0;
console.log(`Human labels available: ${humanCount} across ${humanQueries?.length ?? 0} queries`);

// ---------------------------------------------------------------------------
// Merge — human always wins on (canonical_doi, query) conflict
// ---------------------------------------------------------------------------
const merged = new Map();

// Step 1: seed with human labels keyed by (qid, doi). Use the query.id as key
// so multiple queries about the same paper produce different rows.
if (humanQueries) {
  for (const q of humanQueries) {
    for (const [idx, l] of Object.entries(q.labels)) {
      const doi = normDoi(l.doi);
      if (!doi) continue;
      const key = `${q.id}|${doi}`;
      merged.set(key, {
        query_id: q.id,
        query_text: q.query,
        doi,
        label: l.label,
        source: 'human',
        title: l.title ?? null,
        design_rank: l.design_rank ?? null,
        original_idx: idx,
      });
    }
  }
}

// Step 2: layer in auto-labels, skipping any key already set by a human.
// For multiple auto-labels with the same key, keep newest (or oldest per flag).
// rowsAll is already sorted by created_at desc.
const autoByKey = new Map();
for (const r of validAuto) {
  // We need a query_id. The classifier_training_labels table stores the
  // query *text* but not a stable id. Derive a synthetic id from the query
  // hash so the same query gets the same id across runs.
  const qid = `auto-${hashStr(r.query)}`;
  const doi = normDoi(r.canonical_doi);
  const key = `${qid}|${doi}`;
  if (autoByKey.has(key) && DEDUP === 'keep-newest') continue; // skip — already kept the newest
  if (!autoByKey.has(key) || DEDUP === 'keep-oldest') {
    autoByKey.set(key, r);
  }
}
function hashStr(s) {
  // 32-bit FNV-1a; short stable id
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16);
}

for (const [key, r] of autoByKey.entries()) {
  if (merged.has(key)) continue;  // human wins
  const lbl = autoToHumanLabel(r.classification);
  if (!lbl) continue;
  merged.set(key, {
    query_id: key.split('|')[0],
    query_text: r.query,
    doi: normDoi(r.canonical_doi),
    label: lbl,
    source: 'llm_judge',
    title: r.paper_title ?? null,
    classification: r.classification,
    llm_rationale: r.llm_rationale ?? null,
    llm_model: r.llm_model ?? null,
    created_at: r.created_at,
  });
}

console.log(`\nMerged label set: ${merged.size} unique (paper, query) tuples`);

// ---------------------------------------------------------------------------
// Group by query, apply min/max-per-query
// ---------------------------------------------------------------------------
const byQuery = new Map();
for (const row of merged.values()) {
  if (!byQuery.has(row.query_id)) {
    byQuery.set(row.query_id, { query_id: row.query_id, query_text: row.query_text, labels: [] });
  }
  byQuery.get(row.query_id).labels.push(row);
}

// Filter / cap
let dropSmall = 0, cappedRows = 0;
for (const [qid, q] of [...byQuery.entries()]) {
  if (q.labels.length < MIN_PER_Q) {
    byQuery.delete(qid);
    dropSmall += q.labels.length;
    continue;
  }
  if (MAX_PER_Q && q.labels.length > MAX_PER_Q) {
    // Keep humans + most-recent autos up to cap
    const humans = q.labels.filter((l) => l.source === 'human');
    const autos = q.labels.filter((l) => l.source !== 'human')
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const keep = [...humans, ...autos].slice(0, MAX_PER_Q);
    cappedRows += q.labels.length - keep.length;
    q.labels = keep;
  }
}

// ---------------------------------------------------------------------------
// Print stats
// ---------------------------------------------------------------------------
const allRows = [...byQuery.values()].flatMap((q) => q.labels);
const dist = { relevant: 0, partial: 0, irrelevant: 0 };
const bySource = { human: 0, llm_judge: 0 };
for (const r of allRows) {
  dist[r.label] = (dist[r.label] ?? 0) + 1;
  bySource[r.source] = (bySource[r.source] ?? 0) + 1;
}
console.log(`\n=== EXPORT STATS ===`);
console.log(`Queries (after min-per-query=${MIN_PER_Q} filter): ${byQuery.size}`);
console.log(`Total labels: ${allRows.length}`);
console.log(`By label: relevant=${dist.relevant}, partial=${dist.partial}, irrelevant=${dist.irrelevant}`);
console.log(`By source: human=${bySource.human}, llm_judge=${bySource.llm_judge}`);
console.log(`Dropped (queries below min): ${dropSmall} labels`);
if (MAX_PER_Q) console.log(`Capped (per-query max=${MAX_PER_Q}): ${cappedRows} labels`);

if (STATS_ONLY || DRY_RUN) {
  console.log('\n--stats-only / --dry-run, not writing file');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Write queries.json-shaped output so build-classifier-training-set.mjs can
// consume it directly via the --labels arg.
// ---------------------------------------------------------------------------
const out = {
  generatedAt: new Date().toISOString(),
  source: {
    humanLabels: bySource.human,
    autoLabels: bySource.llm_judge,
    autoSince: SINCE || null,
    autoSourcesIncluded: INCLUDE_SOURCES,
    dedupStrategy: DEDUP,
    minPerQuery: MIN_PER_Q,
    maxPerQuery: MAX_PER_Q,
  },
  queries: [...byQuery.values()].map((q) => ({
    id: q.query_id,
    query: q.query_text,
    labels: Object.fromEntries(q.labels.map((l, i) => [
      String(i + 1),
      {
        label: l.label,
        doi: l.doi,
        title: l.title,
        source: l.source,
        // pass through extra fields the trainer may want to inspect or
        // up-weight (e.g. weight humans 2x in a future refit)
        ...(l.design_rank ? { design_rank: l.design_rank } : {}),
        ...(l.classification ? { auto_classification: l.classification } : {}),
        ...(l.llm_rationale ? { auto_rationale: l.llm_rationale } : {}),
      },
    ])),
  })),
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`\nWrote ${OUT_PATH} (${allRows.length} labels × ${byQuery.size} queries)`);
console.log(`\nNext: node scripts/build-classifier-training-set.mjs --labels ${OUT_PATH.replace(/\\/g, '/')}`);
