/**
 * eval-weight-combinations.mjs
 *
 * Tests multiple composite rerank weight sets against the 23 gold queries.
 * For each query: embed + retrieve candidates ONCE, then re-rank in memory
 * with every weight set. No extra API calls per weight set.
 *
 * Key metric: canary_top20 — fraction of gold canary papers that appear in
 * the reranked top-20. Higher is better. Baseline (default weights): 0.246
 * (16/65, re-pinned 2026-07-06 after fixing 11 wrong canary doi_hints in
 * evals/queries.json — see $canary_repin_2026_07_06 there; gate ≥ 0.231).
 *
 * Usage:
 *   node --env-file="D:/IADB work/Horizon-scanner-IADB/.env" \
 *     scripts/eval-weight-combinations.mjs
 *
 *   node ... eval-weight-combinations.mjs --only q01,q05  # subset of queries
 *   node ... eval-weight-combinations.mjs --top 30        # check top-30 not top-20
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');

const args      = process.argv.slice(2);
const ONLY      = args.includes('--only') ? new Set(args[args.indexOf('--only')+1].split(',').map(s=>s.trim())) : null;
const TOP_K     = args.includes('--top')  ? Number(args[args.indexOf('--top')+1]) : 20;
const HYDE_MODE = args.includes('--hyde');
const QWEN_MODEL = process.env.OLLAMA_GENERATION_MODEL ?? process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';

const SB         = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE   = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY    = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

// ── Weight combinations to test ──────────────────────────────────────────────
// Each must sum to 1.0. sim+cit+rig+rec+reg+fts = 1.00
// Naming: what the set is optimising for.

const WEIGHT_SETS = [
  // ── Baseline ──
  { name: 'default (current baseline)',
    sim: 0.50, cit: 0.20, rig: 0.15, rec: 0.05, reg: 0.05, fts: 0.05 },

  // ── Single-channel channel sets (from channelsToRerankWeights in App.tsx) ──
  { name: 'causal-only  [rig↑0.22 sim↓0.44]',
    sim: 0.44, cit: 0.18, rig: 0.22, rec: 0.05, reg: 0.03, fts: 0.08 },
  { name: 'found-only   [cit↑0.32 rig↓0.03]',
    sim: 0.49, cit: 0.32, rig: 0.03, rec: 0.05, reg: 0.03, fts: 0.08 },
  { name: 'recent-BUG   [rec↑0.18 cit↓0.12] was in code',
    sim: 0.47, cit: 0.12, rig: 0.12, rec: 0.18, reg: 0.03, fts: 0.08 },
  { name: 'recent-CODE  [rec=0.12 cit=0.20 rig=0.12] current fix',
    sim: 0.45, cit: 0.20, rig: 0.12, rec: 0.12, reg: 0.03, fts: 0.08 },
  { name: 'recent-FIX   [rec=0.12 cit=0.20 rig=0.10]',
    sim: 0.47, cit: 0.20, rig: 0.10, rec: 0.12, reg: 0.03, fts: 0.08 },
  { name: 'recent-MOD   [rec=0.15 cit=0.18 rig=0.10]',
    sim: 0.44, cit: 0.18, rig: 0.10, rec: 0.15, reg: 0.05, fts: 0.08 },
  { name: 'lac-only     [reg↑0.10]',
    sim: 0.47, cit: 0.18, rig: 0.12, rec: 0.05, reg: 0.10, fts: 0.08 },

  // ── Multi-channel combinations ──
  { name: 'causal+found [rig↓0.03 cit↑0.32]',  // foundational wins rigor
    sim: 0.49, cit: 0.32, rig: 0.03, rec: 0.05, reg: 0.03, fts: 0.08 },
  { name: 'causal+recent [rig↑0.22 rec↑0.18]',  // both boost → sim crashes to 0.31
    sim: 0.31, cit: 0.18, rig: 0.22, rec: 0.18, reg: 0.03, fts: 0.08 },
  { name: 'found+recent [cit↑0.28 rec↑0.15]',
    sim: 0.44, cit: 0.28, rig: 0.03, rec: 0.15, reg: 0.03, fts: 0.07 },
  { name: 'causal+lac   [rig↑0.22 reg↑0.10]',
    sim: 0.41, cit: 0.18, rig: 0.22, rec: 0.03, reg: 0.10, fts: 0.06 },
  { name: 'all-channels [cit0.32 rec0.18 reg0.10]',  // sim=0.29
    sim: 0.29, cit: 0.32, rig: 0.03, rec: 0.18, reg: 0.10, fts: 0.08 },

  // ── FTS experiments ──
  { name: 'fts-bump      [fts↑0.08 sim↓0.47]',
    sim: 0.47, cit: 0.20, rig: 0.15, rec: 0.05, reg: 0.05, fts: 0.08 },
  { name: 'fts-heavy     [fts↑0.12 sim↓0.43]',
    sim: 0.43, cit: 0.20, rig: 0.15, rec: 0.05, reg: 0.05, fts: 0.12 },

  // ── Citation variants ──
  { name: 'cit-boost     [cit↑0.25 sim↓0.45]',
    sim: 0.45, cit: 0.25, rig: 0.13, rec: 0.05, reg: 0.05, fts: 0.07 },
  { name: 'cit+fts boost [cit0.25 fts0.10]',
    sim: 0.43, cit: 0.25, rig: 0.12, rec: 0.05, reg: 0.05, fts: 0.10 },

  // ── Rigor variants ──
  { name: 'rig-boost     [rig↑0.20 sim↓0.45]',
    sim: 0.45, cit: 0.20, rig: 0.20, rec: 0.05, reg: 0.05, fts: 0.05 },
  { name: 'rig-heavy     [rig↑0.25 cit↓0.17]',
    sim: 0.45, cit: 0.17, rig: 0.25, rec: 0.05, reg: 0.05, fts: 0.03 },

  // ── Balanced variants (compromise across channels) ──
  { name: 'balanced-v1   [all signals moderate]',
    sim: 0.42, cit: 0.22, rig: 0.18, rec: 0.08, reg: 0.05, fts: 0.05 },
  { name: 'balanced-v2   [sim↓, cit+rig+rec up]',
    sim: 0.38, cit: 0.24, rig: 0.18, rec: 0.10, reg: 0.05, fts: 0.05 },

  // ── Quality-adjusted synthetic sim approach (alt to weight shifts) ──
  { name: 'sim-heavy     [sim↑0.60 others↓]',
    sim: 0.60, cit: 0.17, rig: 0.10, rec: 0.04, reg: 0.04, fts: 0.05 },

  // ── BO-optimised (base, HyDE off) — 2026-05-29 ──
  // Constrained: sim≥0.25 for default (causal%≥55), sim≥0.20 causal, sim≥0.15 others.
  { name: 'BO-base-default     [fts↑0.311 cit0.171]',
    sim: 0.3265969804055812, cit: 0.17065279144989512, rig: 0.06109999590766932,
    rec: 0.06554696709194457, reg: 0.06543426028223065, fts: 0.3106690048626791 },
  { name: 'BO-base-causal      [rig0.250 sim0.282]',
    sim: 0.28237539124248173, cit: 0.1957552620130085, rig: 0.250097154397725,
    rec: 0.02126712431589503, reg: 0.1462376394414177, fts: 0.10426742858947192 },
  { name: 'BO-base-foundational[cit↑0.633 sim0.213]',
    sim: 0.21277722840042507, cit: 0.633327838542718, rig: 0.03817085792511982,
    rec: 0.021629085320307696, reg: 0.022602402307383765, fts: 0.0714925875040457 },
  { name: 'BO-base-recent      [sim0.496 rec0.203]',
    sim: 0.49562622214037344, cit: 0.21743432437174465, rig: 0.030984495799667465,
    rec: 0.20300741002114753, reg: 0.03, fts: 0.022947547667066977 },
  { name: 'BO-base-lac         [reg↑0.600]',
    sim: 0.22308806129759898, cit: 0.07864488470494055, rig: 0.023701677839089975,
    rec: 0.02345768098585426, reg: 0.5998141590892496, fts: 0.05129353608326673 },

  // ── BO-optimised (HyDE on) — 2026-05-29 ──
  // Trained on document-style HyDE embeddings. Hypothesis: sim↑, fts↓ vs base.
  { name: 'BO-hyde-default     [sim↑0.428 fts0.147]',
    sim: 0.42803708353343595, cit: 0.15735496675576566, rig: 0.15954057820316914,
    rec: 0.02100634507634727, reg: 0.08681840052900837, fts: 0.14724262590227355 },
  { name: 'BO-hyde-causal      [sim↑0.466 rig0.243]',
    sim: 0.46568874624977996, cit: 0.1914715398833996, rig: 0.24318073381790253,
    rec: 0.025056773353645655, reg: 0.04370897619699289, fts: 0.030893230498279328 },
  { name: 'BO-hyde-foundational[cit0.582 fts↑0.186]',
    sim: 0.150943732001652, cit: 0.5821356664745357, rig: 0.03465028981783422,
    rec: 0.020204351815785983, reg: 0.026559485138639823, fts: 0.18550647475155232 },
  { name: 'BO-hyde-recent      [sim0.287 rec0.250]',
    sim: 0.2873138000139566, cit: 0.2696272041705034, rig: 0.031223212582927515,
    rec: 0.24977659429211202, reg: 0.03, fts: 0.13205918894050045 },
  { name: 'BO-hyde-lac         [reg0.211 cit0.285]',
    sim: 0.2557159217305275, cit: 0.28525516056639966, rig: 0.18923157088845424,
    rec: 0.03075248102564401, reg: 0.2112818553547812, fts: 0.027763010434193443 },
];

// Verify all sums to 1.0
for (const w of WEIGHT_SETS) {
  const s = w.sim + w.cit + w.rig + w.rec + w.reg + w.fts;
  if (Math.abs(s - 1.0) > 0.001) {
    console.error(`WEIGHT ERROR: "${w.name}" sums to ${s.toFixed(4)}`);
    process.exit(1);
  }
}

// ── Helpers (mirrored from eval-gold.mjs) ──────────────────────────────────

const LAC_KEYWORDS = [
  'latin america','latin american','latam','lac','caribbean','south america',
  'central america','argentina','bolivia','brazil','brasil','chile','colombia',
  'costa rica','cuba','dominican republic','ecuador','el salvador','guatemala',
  'haiti','honduras','jamaica','mexico','méxico','nicaragua','panama','paraguay',
  'peru','perú','uruguay','venezuela',
];
const LAC_REGEX = new RegExp(`\\b(${LAC_KEYWORDS.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`,'i');

function normDoi(d) {
  if (!d) return null;
  return String(d).toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//,'');
}
function normDoiKey(d) { const n=normDoi(d); return n?`doi:${n}`:''; }
function normTitleKey(t) {
  if (!t) return '';
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
    .replace(/\bnber\s+working\s+paper[^,]*/g,'').replace(/\[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function keyOf(p) {
  const d=normDoiKey(p.canonical_doi); if(d) return d;
  const t=normTitleKey(p.title); return t?`t:${t}`:`id:${p.id}`;
}

async function generateHydeAbstract(query) {
  const prompt = `Write a 120-180 word hypothetical abstract for an economics or social science paper that would directly answer this research query:\n\n${query}\n\nUse natural academic terminology, likely variables, outcomes, mechanisms, and empirical framing. Do not invent author names, citations, journal names, or specific findings.`;
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim() ?? '';
  if (text.length < 50) { console.warn(`  [hyde] short output (${text.length} chars), falling back to raw query`); return query; }
  return text;
}

// qwen3-embedding:8b is an MRL model — MUST request dimensions=768 or it returns
// 4096-dim vectors and match_works_v2 fails with "different vector dimensions
// 4096 and 768" (the corpus column is 768). Mirrors eval-gold.mjs EVAL_EMBED_DIMS.
const WC_EMBED_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;
async function embedBatch(texts) {
  const body = { model: EMBED_MODEL, input: texts.map(t=>`search_query: ${t}`) };
  if (WC_EMBED_DIMS) body.dimensions = WC_EMBED_DIMS;
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed fail: ' + JSON.stringify(j).slice(0,200));
  return j.data.map(d=>d.embedding);
}

function rrSimilarity(p) { const s=Number(p.similarity??0); return isFinite(s)?Math.max(0,Math.min(1,s)):0; }
function rrRigor(p)      { const s=Number(p.sms_level??p.smsLevel??0); return (isFinite(s)&&s>=1)?Math.min(s,5)/5:0; }
function rrRecency(p)    { const y=Number(p.year??0); return (isFinite(y)&&y>=1900)?Math.max(0,1-Math.max(0,new Date().getUTCFullYear()-y)/25):0; }
function rrRegion(p,re)  { if(!re)return 0; return re.test([p.title??'',p.abstract??'',(p.geography??[]).join(' ')].join(' '))?1:0; }
const CIT_LOG_CAP = Math.log(1+500);
function rrCitation(p)   {
  const c=Number(p.citation_count??p.citationCount??0); if(!isFinite(c)||c<=0)return 0;
  const y=Number(p.year??0); if(!isFinite(y)||y<1900)return 0;
  const age=Math.max(1,new Date().getUTCFullYear()-y+1);
  return Math.max(0,Math.min(1,Math.log(1+c/age)/CIT_LOG_CAP));
}
function rrFts(p)        { const r=Number(p.ftsRank??p.fts_rank??0); return (isFinite(r)&&r>0)?Math.min(1,r):0; }

function rerankWith(papers, queryStr, W) {
  const useLac = LAC_REGEX.test(queryStr);
  const re     = useLac ? LAC_REGEX : null;
  const regW   = useLac ? W.reg : 0;
  const simW   = regW === 0 ? W.sim + W.reg : W.sim;

  return papers.map(p => ({
    paper: p,
    score: simW*rrSimilarity(p) + W.rig*rrRigor(p) + W.rec*rrRecency(p)
         + regW*rrRegion(p,re) + W.cit*rrCitation(p) + W.fts*rrFts(p),
  })).sort((a,b)=>b.score-a.score).map(s=>s.paper);
}

// ── Load queries ──────────────────────────────────────────────────────────────

const { queries: ALL_QUERIES } = JSON.parse(readFileSync(QUERIES_PATH,'utf8'));
const queries = ONLY ? ALL_QUERIES.filter(q=>ONLY.has(q.id)) : ALL_QUERIES;

console.log(`\nWeight combination eval — ${queries.length} queries × ${WEIGHT_SETS.length} weight sets`);
console.log(`HyDE: ${HYDE_MODE ? `ON  (Qwen ${QWEN_MODEL} → synthetic abstract → embed)` : 'OFF (raw query → embed)'}`);
console.log(`Checking canary hits in top-${TOP_K}. LLM: ${LLM_BASE}\n`);

// ── Channel-objective metric helpers ─────────────────────────────────────────

const LAC_GEO_TERMS = new Set([
  'latin america','lac','caribbean','south america','central america',
  'mexico','brazil','colombia','peru','chile','argentina','ecuador','bolivia',
  'costa rica','panama','venezuela','paraguay','uruguay','honduras','guatemala',
  'el salvador','nicaragua','dominican republic','haiti','jamaica',
]);

function isLacPaper(p) {
  const geo = (p.geography ?? []).map(g => String(g).toLowerCase());
  return geo.some(g => LAC_GEO_TERMS.has(g) || [...LAC_GEO_TERMS].some(t => g.includes(t)));
}

function isFoundational(p) {
  const year = Number(p.year ?? 0);
  const cit  = Number(p.citation_count ?? 0);
  // Aligned with tagChannels pill: pre-2020, cit >= 75 (no gap year with Recent=2020+)
  return year > 0 && year < 2020 && cit >= 75;
}

function isRecent(p)  { return Number(p.year ?? 0) >= 2020; }
function isCausal(p)  { return Number(p.sms_level ?? 0) >= 4; }

/** Channel-objective metrics for a top-K result set. */
function channelMetrics(topK) {
  const n = topK.length || 1;
  return {
    pct_causal:      topK.filter(isCausal).length      / n,
    pct_foundational:topK.filter(isFoundational).length / n,
    pct_recent:      topK.filter(isRecent).length       / n,
    pct_lac:         topK.filter(isLacPaper).length     / n,
    avg_sms:         topK.reduce((s,p)=>s+Number(p.sms_level??0),0) / n,
  };
}

// ── Per-query: embed + retrieve once, then sweep weights ──────────────────────

// Accumulators: found[weightIdx] / total
const found       = WEIGHT_SETS.map(()=>0);
const pre2010found  = WEIGHT_SETS.map(()=>0);
const post2010found = WEIGHT_SETS.map(()=>0);
let total=0, pre2010total=0, post2010total=0;

// Channel-objective accumulators (summed across all queries, averaged at end)
const objSums = WEIGHT_SETS.map(()=>({ causal:0, foundational:0, recent:0, lac:0, avg_sms:0 }));
let objQueries = 0; // how many queries contributed to objective metrics

// Embed queries (or HyDE abstracts)
let embedInputs;
if (HYDE_MODE) {
  console.log(`Generating HyDE abstracts for ${queries.length} queries (sequential)...`);
  embedInputs = [];
  for (let i = 0; i < queries.length; i++) {
    process.stdout.write(`  [${i+1}/${queries.length}] ${queries[i].id.padEnd(36)} `);
    const t = Date.now();
    const ab = await generateHydeAbstract(queries[i].query);
    console.log(`${Date.now()-t}ms  ${ab.length}chars`);
    embedInputs.push(ab);
  }
  process.stdout.write('Embedding HyDE abstracts...');
} else {
  process.stdout.write('Embedding queries...');
  embedInputs = queries.map(q => q.query);
}
const embeddings = await embedBatch(embedInputs);
console.log(` done (${queries.length})`);

for (let qi=0; qi<queries.length; qi++) {
  const q = queries[qi];
  const canaries = (q.canary_papers ?? []).filter(c=>c.doi_hint);
  if (!canaries.length) continue;

  process.stdout.write(`  ${q.id.padEnd(40)} retrieving...`);

  // Single RPC call
  const { data, error } = await SB.rpc('match_works_v2', {
    query_embedding: embeddings[qi],
    query_text: q.query,
    match_threshold: 0.40,
    match_count: 100,
  });
  if (error || !data) {
    console.log(` ERROR: ${error?.message}`);
    continue;
  }

  const pool = [...data];

  // Dedup by DOI/title
  const seen = new Set();
  const deduped = pool.filter(p=>{const k=keyOf(p); if(seen.has(k))return false; seen.add(k); return true;});

  // Build canary DOI set
  const canaryDois = new Set(canaries.map(c=>normDoi(c.doi_hint)));

  total        += canaries.length;
  pre2010total += canaries.filter(c=>(c.year??9999)<=2010).length;
  post2010total+= canaries.filter(c=>(c.year??0)>2010).length;

  objQueries++;

  // Apply each weight set
  const hitsByWeight = WEIGHT_SETS.map((W, wi)=>{
    const ranked  = rerankWith(deduped, q.query, W);
    const topK    = ranked.slice(0, TOP_K);
    // Match canaries by works.id AND canonical_doi: canonical_doi is often NULL,
    // but works.id is frequently the bare DOI (per memory gotcha — matching by
    // canonical_doi alone zeroed every weight set). Include both, normalized.
    const topDois = new Set(topK.flatMap(p=>[normDoi(p.id), normDoi(p.canonical_doi)]).filter(Boolean));

    // Canary recall
    const hits = canaries.filter(c=>canaryDois.has(normDoi(c.doi_hint)) && topDois.has(normDoi(c.doi_hint))).length;
    found[wi]        += hits;
    pre2010found[wi] += canaries.filter(c=>(c.year??9999)<=2010 && topDois.has(normDoi(c.doi_hint))).length;
    post2010found[wi]+= canaries.filter(c=>(c.year??0)>2010     && topDois.has(normDoi(c.doi_hint))).length;

    // Channel-objective metrics
    const obj = channelMetrics(topK);
    objSums[wi].causal       += obj.pct_causal;
    objSums[wi].foundational += obj.pct_foundational;
    objSums[wi].recent       += obj.pct_recent;
    objSums[wi].lac          += obj.pct_lac;
    objSums[wi].avg_sms      += obj.avg_sms;

    return hits;
  });

  const defaultHits = hitsByWeight[0];
  const bestHits    = Math.max(...hitsByWeight);
  const marks = hitsByWeight.map(h => h > defaultHits ? '↑' : h < defaultHits ? '↓' : '·');
  console.log(` [${canaries.length} canaries] default=${defaultHits} best=${bestHits} [${marks.join('')}]`);
}

// ── Results table ──────────────────────────────────────────────────────────────

const baseline = found[0] / total;
const N = objQueries || 1;

const rows = WEIGHT_SETS.map((W,i)=>({
  name:        W.name,
  overall:     found[i]/total,
  pre2010:     pre2010total>0 ? pre2010found[i]/pre2010total : 0,
  post2010:    post2010total>0 ? post2010found[i]/post2010total : 0,
  delta:       found[i]/total - baseline,
  // Channel objectives (avg across queries)
  pct_causal:  objSums[i].causal/N,
  pct_found:   objSums[i].foundational/N,
  pct_recent:  objSums[i].recent/N,
  pct_lac:     objSums[i].lac/N,
  avg_sms:     objSums[i].avg_sms/N,
}));

// ── Table 1: General canary recall (sorted by overall) ──────────────────────
console.log('\n' + '═'.repeat(90));
console.log(`TABLE 1 — GENERAL CANARY RECALL  (top-${TOP_K}, ${queries.length} queries, ${total} canaries)`);
console.log('Δ vs default weights. Regression guard: stay above baseline.');
console.log('═'.repeat(90));
console.log(`${'Weight set'.padEnd(48)} ${'overall'.padStart(8)} ${'pre-2010'.padStart(9)} ${'post-2010'.padStart(10)} ${'Δdefault'.padStart(9)}`);
console.log('─'.repeat(90));
for (const r of [...rows].sort((a,b)=>b.overall-a.overall)) {
  const flag = r.delta > 0.01 ? '🟢' : r.delta < -0.01 ? '🔴' : '⚪';
  console.log(`${flag} ${r.name.padEnd(46)} ${r.overall.toFixed(3).padStart(8)} ${r.pre2010.toFixed(3).padStart(9)} ${r.post2010.toFixed(3).padStart(10)} ${(r.delta>=0?'+':'')+r.delta.toFixed(3).padStart(9)}`);
}
console.log('─'.repeat(90));
console.log(`Baseline: overall=${baseline.toFixed(3)} pre2010=${(pre2010found[0]/pre2010total).toFixed(3)} post2010=${(post2010found[0]/post2010total).toFixed(3)}`);

// ── Table 2: Channel objectives (sorted per column) ──────────────────────────
console.log('\n' + '═'.repeat(90));
console.log(`TABLE 2 — CHANNEL OBJECTIVES  (avg % of top-${TOP_K} matching each channel's goal)`);
console.log('Causal=SMS≥4 · Foundational=cit≥75+year<2020 · Recent=year≥2020 · LAC=LAC geography');
console.log('Goal: channel weights should score HIGHER on their own objective than the default.');
console.log('═'.repeat(90));
console.log(`${'Weight set'.padEnd(48)} ${'causal%'.padStart(8)} ${'found%'.padStart(8)} ${'recent%'.padStart(8)} ${'lac%'.padStart(6)} ${'avgSMS'.padStart(7)}`);
console.log('─'.repeat(90));
const defRow = rows[0]; // default is first weight set
for (const r of rows) {
  const cFlag = r.pct_causal  > defRow.pct_causal+0.01  ? '↑' : r.pct_causal  < defRow.pct_causal-0.01  ? '↓' : ' ';
  const fFlag = r.pct_found   > defRow.pct_found+0.01   ? '↑' : r.pct_found   < defRow.pct_found-0.01   ? '↓' : ' ';
  const rFlag = r.pct_recent  > defRow.pct_recent+0.01  ? '↑' : r.pct_recent  < defRow.pct_recent-0.01  ? '↓' : ' ';
  const lFlag = r.pct_lac     > defRow.pct_lac+0.01     ? '↑' : r.pct_lac     < defRow.pct_lac-0.01     ? '↓' : ' ';
  console.log(`  ${r.name.padEnd(46)} ${(r.pct_causal*100).toFixed(1).padStart(6)}%${cFlag} ${(r.pct_found*100).toFixed(1).padStart(6)}%${fFlag} ${(r.pct_recent*100).toFixed(1).padStart(6)}%${rFlag} ${(r.pct_lac*100).toFixed(1).padStart(4)}%${lFlag} ${r.avg_sms.toFixed(2).padStart(7)}`);
}
console.log('─'.repeat(90));
console.log(`\nObjective leaders:`);
const byC = [...rows].sort((a,b)=>b.pct_causal-a.pct_causal)[0];
const byF = [...rows].sort((a,b)=>b.pct_found-a.pct_found)[0];
const byR = [...rows].sort((a,b)=>b.pct_recent-a.pct_recent)[0];
const byL = [...rows].sort((a,b)=>b.pct_lac-a.pct_lac)[0];
console.log(`  Causal:       ${byC.name} (${(byC.pct_causal*100).toFixed(1)}% SMS≥4 in top-${TOP_K})`);
console.log(`  Foundational: ${byF.name} (${(byF.pct_found*100).toFixed(1)}% foundational in top-${TOP_K})`);
console.log(`  Recent:       ${byR.name} (${(byR.pct_recent*100).toFixed(1)}% 2020+ in top-${TOP_K})`);
console.log(`  LAC:          ${byL.name} (${(byL.pct_lac*100).toFixed(1)}% LAC in top-${TOP_K})`);
console.log('═'.repeat(90));
