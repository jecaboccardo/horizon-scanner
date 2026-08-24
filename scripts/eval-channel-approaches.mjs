/**
 * scripts/eval-channel-approaches.mjs
 *
 * Compares 3 multi-channel ranking approaches on 5 test queries.
 * All 3 approaches operate on the SAME candidate pool returned by the API.
 *
 * Approach A — Current (the order already returned by the API)
 * Approach B — Allocation (floors + fill-by-max composite)
 * Approach C — Joint (AND/OR semantics: harmonic-mean for filter channels × max for time channels)
 *
 * Usage:
 *   node --env-file="D:/IADB work/Horizon-scanner-IADB/.env" scripts/eval-channel-approaches.mjs
 *
 * Optional flags:
 *   --only q-minwage-causal,q-cct-lac-causal   run a subset
 *   --top 50                                    evaluate top-N (default: use both @20 and @50)
 */

// ---------------------------------------------------------------------------
// Config & constants
// ---------------------------------------------------------------------------

const API_BASE  = process.env.PROD_API_BASE || 'http://localhost:3002';
const TENANT_ID = 'iadb-demo';

const args   = process.argv.slice(2);
const ONLY   = args.includes('--only')
  ? new Set(args[args.indexOf('--only') + 1].split(',').map(s => s.trim()))
  : null;

// ── Test queries ─────────────────────────────────────────────────────────────
const TEST_QUERIES = [
  // single channel — baseline
  {
    id: 'q-minwage-causal',
    query: 'causal impact of minimum wage increases on employment and informality',
    channels: ['causal'],
  },
  // 2 filter channels (AND semantics test)
  {
    id: 'q-cct-lac-causal',
    query: 'do cash transfer programs increase school attendance and learning outcomes',
    channels: ['causal', 'lac'],
  },
  // filter + time (AND + time-OR semantics)
  {
    id: 'q-nutrition-causal-found',
    query: 'does early childhood nutrition improve long-term earnings and health',
    channels: ['causal', 'foundational'],
  },
  // 3 channels with time tension
  {
    id: 'q-returns-edu-all',
    query: 'returns to education wages human capital labor market',
    channels: ['causal', 'foundational', 'recent'],
  },
  // rafaelde-style query (4 channels)
  {
    id: 'q-student-learning',
    query: 'impact of student learning outcomes and school performance on productivity and economic growth',
    channels: ['causal', 'foundational', 'recent', 'lac'],
  },
];

// ── Channel weight definitions (mirror of rerank.ts CHANNEL_RERANK_WEIGHTS) ──
// Source of truth: rerank.ts — do not trust these values in isolation.
const CHANNEL_WEIGHTS = {
  causal:       { similarity: 0.282, citation: 0.046, rigor: 0.400, recency: 0.021, region: 0.146, fts: 0.105 },
  foundational: { similarity: 0.213, citation: 0.633, rigor: 0.080, recency: 0.000, region: 0.023, fts: 0.071 },
  recent:       { similarity: 0.496, citation: 0.217, rigor: 0.031, recency: 0.203, region: 0.030, fts: 0.023 },
  lac:          { similarity: 0.223, citation: 0.079, rigor: 0.024, recency: 0.023, region: 0.600, fts: 0.051 },
  default:      { similarity: 0.428, citation: 0.157, rigor: 0.160, recency: 0.021, region: 0.087, fts: 0.147 },
};

// LAC keywords (subset matching rerank.ts — keep in sync)
const LAC_KEYWORDS = [
  'latin america', 'lac', 'caribbean', 'mexico', 'brazil', 'colombia', 'peru',
  'chile', 'argentina', 'bolivia', 'ecuador', 'venezuela', 'guatemala', 'honduras',
  'el salvador', 'nicaragua', 'costa rica', 'panama', 'dominican republic',
  'paraguay', 'uruguay', 'andean', 'latam', 'brasil', 'américa latina',
  'latin american', 'central america', 'south america',
];
const LAC_REGEX = new RegExp(
  `\\b(${LAC_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

// ── Time-channel vs filter-channel classification for Approach C ─────────────
// time channels:   rank by era (foundational=pre-2020, recent=2020+) → combine with MAX (OR)
// filter channels: rank by quality/geography → combine with HARMONIC MEAN (AND)
const TIME_CHANNELS   = new Set(['foundational', 'recent']);
const FILTER_CHANNELS = new Set(['causal', 'lac']);

// ── Allocation params (Approach B) ──────────────────────────────────────────
const ALLOC_TARGET   = 44;  // papers to allocate via floor slots
const ALLOC_TOTAL    = 50;  // final set size

// ---------------------------------------------------------------------------
// Scoring functions (replicate rerank.ts logic in plain JS)
// ---------------------------------------------------------------------------

const CURRENT_YEAR = new Date().getUTCFullYear();
const CIT_RATE_CEILING = 500;
const CIT_LOG_CEILING  = Math.log(1 + CIT_RATE_CEILING);

function citationScore(p) {
  const cit  = Number(p.citation_count ?? p.citationCount ?? 0);
  if (!Number.isFinite(cit) || cit <= 0) return 0;
  const year = Number(p.year ?? p.publication_year ?? 0);
  if (!Number.isFinite(year) || year < 1900) return 0;
  const age  = Math.max(1, CURRENT_YEAR - year + 1);
  const rate = cit / age;
  return Math.max(0, Math.min(1, Math.log(1 + rate) / CIT_LOG_CEILING));
}

function smsScore(p) {
  const sms = Number(p.sms_level ?? p.smsLevel ?? 0);
  if (!Number.isFinite(sms) || sms < 1) return 0;
  return Math.min(sms, 5) / 5;
}

function recencyScore(p) {
  const year = Number(p.year ?? p.publication_year ?? 0);
  if (!Number.isFinite(year) || year < 1900) return 0;
  return Math.max(0, Math.min(1, (year - 2000) / 25));
}

function lacText(p) {
  return [
    p.title ?? '',
    typeof p.abstract === 'string' ? p.abstract.slice(0, 300) : '',
    Array.isArray(p.geography) ? p.geography.join(' ') : '',
  ].join(' ');
}

function regionScore(p) {
  return LAC_REGEX.test(lacText(p)) ? 1 : 0;
}

function ftsScore(p) {
  const raw = Number(p.fts_rank ?? p.ftsRank ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

function similarityScore(p) {
  const sim = Number(p.similarity ?? 0);
  if (Number.isFinite(sim) && sim > 0) return Math.min(1, sim);
  // BM25-only: synthetic similarity capped at 0.45
  const fts = ftsScore(p);
  let base = fts > 0 ? Math.min(0.45, fts * 1.8) : 0;
  // Layer-2 floor for high-rigor BM25 papers
  if (base > 0 && base <= 0.46) {
    const sms = Number(p.sms_level ?? 0);
    if (sms >= 4) base = Math.max(base, 0.60);
  }
  return base;
}

/**
 * Composite score for a paper under a given channel's weights.
 * Does NOT apply the P0 gate / age-preference / directness bonus —
 * those are retrieval-time effects that have already shaped the pool.
 * For comparative ranking within the same pool they are constant.
 */
function compositeScore(p, weights) {
  const w = weights;
  return (
    w.similarity * similarityScore(p) +
    w.citation   * citationScore(p) +
    w.rigor      * smsScore(p) +
    w.recency    * recencyScore(p) +
    w.region     * regionScore(p) +
    w.fts        * ftsScore(p)
  );
}

// ---------------------------------------------------------------------------
// Approach B — Allocation (floors + fill-by-max)
// ---------------------------------------------------------------------------

function approachB(pool, channels, n = 50) {
  if (channels.length === 0 || pool.length === 0) return pool.slice(0, n);
  if (channels.length === 1) {
    const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[channels[0]] ?? {}) };
    return [...pool]
      .sort((a, b) => compositeScore(b, w) - compositeScore(a, w))
      .slice(0, n);
  }

  const N = channels.length;
  const floorPerChannel = Math.floor(ALLOC_TARGET / N);     // e.g. 2ch→22, 4ch→11
  const fillSlots = n - floorPerChannel * N;                 // remaining fill budget

  // Score each paper under every channel's weights
  const scores = pool.map(p => {
    const byChannel = {};
    for (const ch of channels) {
      const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[ch] ?? {}) };
      byChannel[ch] = compositeScore(p, w);
    }
    return { paper: p, byChannel, maxScore: Math.max(...Object.values(byChannel)) };
  });

  const selected = new Set();
  const result   = [];

  // Phase 1: for each channel, take its top floor_per_channel unique papers
  for (const ch of channels) {
    const ranked = [...scores].sort((a, b) => b.byChannel[ch] - a.byChannel[ch]);
    let added = 0;
    for (const item of ranked) {
      if (added >= floorPerChannel) break;
      const key = item.paper.id ?? item.paper.canonical_doi ?? '';
      if (!key || selected.has(key)) continue;
      selected.add(key);
      result.push(item.paper);
      added++;
    }
  }

  // Phase 2: fill remaining slots by max composite score across any channel
  const remaining = scores
    .filter(item => {
      const key = item.paper.id ?? item.paper.canonical_doi ?? '';
      return key && !selected.has(key);
    })
    .sort((a, b) => b.maxScore - a.maxScore);

  for (const item of remaining) {
    if (result.length >= n) break;
    const key = item.paper.id ?? item.paper.canonical_doi ?? '';
    if (!key || selected.has(key)) continue;
    selected.add(key);
    result.push(item.paper);
  }

  return result.slice(0, n);
}

// ---------------------------------------------------------------------------
// Approach C — Joint (AND/OR semantics)
// ---------------------------------------------------------------------------

function harmonicMean(values) {
  if (values.length === 0) return 0;
  if (values.some(v => v === 0)) return 0;
  return values.length / values.reduce((acc, v) => acc + 1 / v, 0);
}

function jointScore(p, channels) {
  if (channels.length === 1) {
    const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[channels[0]] ?? {}) };
    return compositeScore(p, w);
  }

  const activeFilter = channels.filter(ch => FILTER_CHANNELS.has(ch));
  const activeTime   = channels.filter(ch => TIME_CHANNELS.has(ch));

  const filterScores = activeFilter.map(ch => {
    const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[ch] ?? {}) };
    return compositeScore(p, w);
  });

  const timeScores = activeTime.map(ch => {
    const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[ch] ?? {}) };
    return compositeScore(p, w);
  });

  const timeComponent   = timeScores.length > 0 ? Math.max(...timeScores) : 1;
  const filterComponent = filterScores.length > 0 ? harmonicMean(filterScores) : 1;

  return filterComponent * timeComponent;
}

// approachC = rerankHybrid: pure joint when no time tension,
// floor+fill when both foundational+recent are active.
function approachC(pool, channels, n = 50) {
  if (channels.length === 0 || pool.length === 0) return pool.slice(0, n);

  const filterChs = channels.filter(c => FILTER_CHANNELS.has(c));
  const timeChs   = channels.filter(c => TIME_CHANNELS.has(c));
  const timeTension = timeChs.includes('foundational') && timeChs.includes('recent');

  const filterScore = p => {
    if (filterChs.length === 0) return 1;
    const scores = filterChs.map(ch => compositeScore(p, { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[ch] ?? {}) }));
    return filterChs.length === 1 ? scores[0] : harmonicMean(scores);
  };

  if (!timeTension) {
    // Pure joint: harmonic(filter) × max(time)
    return [...pool]
      .map(p => ({ p, s: jointScore(p, channels) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.p)
      .slice(0, n);
  }

  // Hybrid mode: floor 20% of n per time channel, fill rest with joint
  const FLOOR = Math.max(5, Math.round(n * 0.20)); // 10 at n=50
  const seen = new Set();
  const result = [];

  for (const tCh of timeChs) {
    const tW = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[tCh] ?? {}) };
    [...pool]
      .filter(p => !seen.has(p.id))
      .map(p => ({ p, s: compositeScore(p, tW) * filterScore(p) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, FLOOR)
      .forEach(({ p }) => { seen.add(p.id); result.push(p); });
  }

  // Fill remaining with joint score
  [...pool]
    .filter(p => !seen.has(p.id))
    .map(p => ({ p, s: jointScore(p, channels) }))
    .sort((a, b) => b.s - a.s)
    .forEach(({ p }) => result.push(p));

  return result.slice(0, n);
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

function getYear(p) { return Number(p.year ?? p.publication_year ?? 0) || null; }
function getSms(p)  { return p.sms_level ?? p.smsLevel ?? null; }

function hasLAC(p) { return LAC_REGEX.test(lacText(p)); }

/**
 * For each paper, find which channel gives it the highest composite score.
 * Returns a map: paperId → dominantChannel
 */
function computeDominance(papers, channels) {
  const dom = new Map();
  for (const p of papers) {
    const key = p.id ?? p.canonical_doi ?? '';
    if (!key) continue;
    let best = null, bestScore = -Infinity;
    for (const ch of channels) {
      const w = { ...CHANNEL_WEIGHTS.default, ...(CHANNEL_WEIGHTS[ch] ?? {}) };
      const s = compositeScore(p, w);
      if (s > bestScore) { bestScore = s; best = ch; }
    }
    dom.set(key, best);
  }
  return dom;
}

function pct(num, den) {
  if (!den) return 'n/a';
  return (100 * num / den).toFixed(0) + '%';
}

function computeMetrics(papers, channels, topK, pool, label) {
  const set = papers.slice(0, topK);
  const n   = set.length;
  if (n === 0) return { label, topK, n: 0 };

  // 1. mean_cosine
  const meanCosine = (set.reduce((s, p) => s + (Number(p.similarity ?? 0) || 0), 0) / n).toFixed(3);

  // 2. per_channel_cosine: papers dominated by each channel
  const domMap = computeDominance(set, channels);
  const perChannelCosine = {};
  for (const ch of channels) {
    const dominated = set.filter(p => domMap.get(p.id ?? p.canonical_doi ?? '') === ch);
    if (dominated.length === 0) { perChannelCosine[ch] = 'n/a'; continue; }
    const avg = dominated.reduce((s, p) => s + (Number(p.similarity ?? 0) || 0), 0) / dominated.length;
    perChannelCosine[ch] = avg.toFixed(3);
  }

  // 3. channel_dominance
  const dominanceCounts = {};
  for (const ch of channels) dominanceCounts[ch] = 0;
  for (const p of set) {
    const ch = domMap.get(p.id ?? p.canonical_doi ?? '');
    if (ch && dominanceCounts[ch] !== undefined) dominanceCounts[ch]++;
  }

  // 4. intersection (causal + lac)
  let intersectionPct = null;
  if (channels.includes('causal') && channels.includes('lac')) {
    const cnt = set.filter(p => {
      const sms = Number(getSms(p) ?? 0);
      return sms >= 3 && hasLAC(p);
    }).length;
    intersectionPct = pct(cnt, n);
  }

  // 5. causal_precision: SMS >= 3
  const causalPrecision = channels.includes('causal')
    ? pct(set.filter(p => Number(getSms(p) ?? 0) >= 3).length, n)
    : null;

  // 6. lac_precision
  const lacPrecision = channels.includes('lac')
    ? pct(set.filter(p => hasLAC(p)).length, n)
    : null;

  // 7. recent_precision: year >= 2020
  const recentPrecision = channels.includes('recent')
    ? pct(set.filter(p => { const y = getYear(p); return y !== null && y >= 2020; }).length, n)
    : null;

  // 8. foundational_precision: year < 2020 AND citation_count >= 75
  const foundationalPrecision = channels.includes('foundational')
    ? pct(set.filter(p => {
        const y = getYear(p);
        const cit = Number(p.citation_count ?? 0);
        return y !== null && y < 2020 && cit >= 75;
      }).length, n)
    : null;

  // 9. cosine_above_068
  const cosineAbove068 = pct(set.filter(p => (Number(p.similarity ?? 0) || 0) > 0.68).length, n);

  // 10. zero_joint_score (Approach C diagnostic): count in full pool
  const zeroJointScore = label === 'Joint-C'
    ? pool.filter(p => jointScore(p, channels) === 0).length
    : null;

  return {
    label, topK, n,
    meanCosine,
    perChannelCosine,
    dominanceCounts,
    intersectionPct,
    causalPrecision,
    lacPrecision,
    recentPrecision,
    foundationalPrecision,
    cosineAbove068,
    zeroJointScore,
  };
}

// ---------------------------------------------------------------------------
// Top-5 paper summary
// ---------------------------------------------------------------------------

function topPaperSummary(papers, channels, topN = 5) {
  const dom = computeDominance(papers, channels);
  return papers.slice(0, topN).map((p, i) => {
    const id    = p.id ?? p.canonical_doi ?? '?';
    const title = (p.title ?? '(no title)').slice(0, 60).padEnd(60);
    const sms   = getSms(p) ?? '—';
    const year  = getYear(p) ?? '—';
    const geo   = Array.isArray(p.geography) && p.geography.length > 0
      ? p.geography[0].slice(0, 15)
      : '—';
    const domCh = dom.get(p.id ?? p.canonical_doi ?? '') ?? '—';
    return `  ${String(i + 1).padStart(2)}. [${id.slice(0, 20).padEnd(20)}] ${title} | SMS=${sms} yr=${year} geo=${geo} dom=${domCh}`;
  });
}

// ---------------------------------------------------------------------------
// Formatted table output
// ---------------------------------------------------------------------------

const COL = 12; // column width for metric values

function rpad(s, w) { return String(s ?? '—').slice(0, w).padEnd(w); }
function lpad(s, w) { return String(s ?? '—').padStart(w); }

function printComparisonTable(tq, metricsA20, metricsB20, metricsC20, metricsA50, metricsB50, metricsC50) {
  const border = '═'.repeat(70);
  console.log(`\n${border}`);
  console.log(`  ${tq.id}: "${tq.query.slice(0, 55)}..."`);
  console.log(`  channels=[${tq.channels.join(', ')}]`);
  console.log(border);

  function row(label, fn, isKey = false) {
    const a20 = fn(metricsA20); const b20 = fn(metricsB20); const c20 = fn(metricsC20);
    const a50 = fn(metricsA50); const b50 = fn(metricsB50); const c50 = fn(metricsC50);
    const star = isKey ? ' ←KEY' : '';
    console.log(
      `  ${label.padEnd(32)} ` +
      `${rpad(a20, COL)}  ${rpad(b20, COL)}  ${rpad(c20, COL)}` +
      `  │  ` +
      `${rpad(a50, COL)}  ${rpad(b50, COL)}  ${rpad(c50, COL)}` +
      star,
    );
  }

  const header20 = 'Current-A   Alloc-B     Joint-C';
  const header50 = 'Current-A   Alloc-B     Joint-C';
  console.log(`\n  ${'METRIC'.padEnd(32)} ──── @20 ────────────────────────────  │  ──── @50 ────────────────────────────`);
  console.log(`  ${''.padEnd(32)} ${header20}  │  ${header50}`);
  console.log(`  ${'-'.repeat(32)} ${'-'.repeat(38)}  │  ${'-'.repeat(38)}`);

  row('mean_cosine',               m => m.meanCosine);

  // per-channel cosine rows
  for (const ch of tq.channels) {
    row(`  per_ch_cos [${ch}]`,     m => m.perChannelCosine?.[ch] ?? '—');
  }

  // dominance rows (top-20 only)
  for (const ch of tq.channels) {
    const fn = m => {
      const cnt = m.dominanceCounts?.[ch] ?? 0;
      return `${cnt}/${m.topK}`;
    };
    row(`  dom[${ch}]@20`,           fn);
  }

  if (tq.channels.includes('causal') && tq.channels.includes('lac')) {
    row('intersection SMS≥3+LAC',   m => m.intersectionPct, true);
  }
  if (tq.channels.includes('causal')) {
    row('causal_precision SMS≥3',   m => m.causalPrecision, true);
  }
  if (tq.channels.includes('lac')) {
    row('lac_precision',            m => m.lacPrecision, true);
  }
  if (tq.channels.includes('recent')) {
    row('recent_precision yr≥2020', m => m.recentPrecision, true);
  }
  if (tq.channels.includes('foundational')) {
    row('found_precision yr<20&c≥75', m => m.foundationalPrecision, true);
  }
  row('cosine > 0.68',             m => m.cosineAbove068);
  row('zero_joint_score (pool)',   m => m.zeroJointScore !== null ? String(m.zeroJointScore) : '—');

  console.log('');
}

function printTop5(label, papers, channels) {
  console.log(`  ${label} top-5:`);
  for (const line of topPaperSummary(papers, channels)) {
    console.log(line);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Direct DB retrieval (bypasses HTTP API auth — uses service role + LLM key)
// ---------------------------------------------------------------------------
import { createClient } from '@supabase/supabase-js';

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_URL = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!LLM_KEY) { console.error('Missing LLM_API_KEY'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY);

async function embedQuery(text) {
  const resp = await fetch(`${LLM_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: `search_query: ${text}` }),
  });
  if (!resp.ok) throw new Error(`Embed failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

async function callSearchRun(tq) {
  console.log(`  Embedding query...`);
  const embedding = await embedQuery(tq.query);

  // Call match_works_v2 directly — same RPC the production handler uses
  console.log(`  Calling match_works_v2 (match_count=200)...`);
  // match_works_v2 already includes all metadata + similarity + fts_rank
  const { data: matches, error } = await sb.rpc('match_works_v2', {
    query_embedding: embedding,
    query_text: tq.query.split(/\s+/).slice(0, 5).join(' & '),
    match_count: 300,
  });
  if (error) throw new Error(`match_works_v2: ${error.message}`);
  if (!matches?.length) throw new Error('match_works_v2 returned 0 results');

  const pool = matches.filter(w => (w.similarity ?? 0) > 0.40); // rough relevance gate

  // Approach A = top-100 by current DEFAULT composite weights (no channel interleaving)
  const approachAWorks = [...pool]
    .sort((a, b) => compositeScore(b, CHANNEL_WEIGHTS.default) - compositeScore(a, CHANNEL_WEIGHTS.default))
    .slice(0, 100);

  return { pool, approachAWorks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const queries = ONLY
    ? TEST_QUERIES.filter(q => ONLY.has(q.id))
    : TEST_QUERIES;

  if (queries.length === 0) {
    console.error('No queries matched --only filter. Valid ids:', TEST_QUERIES.map(q => q.id).join(', '));
    process.exit(1);
  }

  console.log(`\nHorizon Scanner — Channel Approach Eval`);
  console.log(`API: ${API_BASE}  tenant: ${TENANT_ID}`);
  console.log(`Queries: ${queries.map(q => q.id).join(', ')}\n`);

  for (const tq of queries) {
    console.log(`\nFetching: ${tq.id} (channels=[${tq.channels.join(', ')}])...`);
    const t0 = Date.now();

    let runData;
    try {
      runData = await callSearchRun(tq);
    } catch (err) {
      console.error(`  SKIP ${tq.id}: ${err.message}`);
      continue;
    }

    const ms = Date.now() - t0;
    console.log(`  Retrieved in ${ms}ms — pool=${runData.pool.length} papers`);

    const candidatePool  = runData.pool;
    const approachAWorks = runData.approachAWorks;

    if (candidatePool.length === 0) {
      console.error(`  SKIP ${tq.id}: no works in response`);
      continue;
    }

    console.log(`  Pool size: ${candidatePool.length}  Evidence (A): ${approachAWorks.length}`);

    // Generate B and C rankings over the same candidate pool
    const approachBWorks = approachB(candidatePool, tq.channels, 50);
    const approachCWorks = approachC(candidatePool, tq.channels, 50);

    // Compute metrics at both cutoffs
    const mA20 = computeMetrics(approachAWorks, tq.channels, 20, candidatePool, 'Current-A');
    const mB20 = computeMetrics(approachBWorks, tq.channels, 20, candidatePool, 'Alloc-B');
    const mC20 = computeMetrics(approachCWorks, tq.channels, 20, candidatePool, 'Joint-C');
    const mA50 = computeMetrics(approachAWorks, tq.channels, 50, candidatePool, 'Current-A');
    const mB50 = computeMetrics(approachBWorks, tq.channels, 50, candidatePool, 'Alloc-B');
    const mC50 = computeMetrics(approachCWorks, tq.channels, 50, candidatePool, 'Joint-C');

    printComparisonTable(tq, mA20, mB20, mC20, mA50, mB50, mC50);

    // Top-5 summaries
    console.log(`  ── Top-5 paper summaries [id (20 chars) | title (60) | SMS | year | geo[0] | dom-channel] ──`);
    printTop5('Current-A', approachAWorks, tq.channels);
    printTop5('Alloc-B',   approachBWorks, tq.channels);
    printTop5('Joint-C',   approachCWorks, tq.channels);

    // Brief diagnostics for Approach C sparse-intersection
    const zeroJoint = candidatePool.filter(p => jointScore(p, tq.channels) === 0).length;
    if (zeroJoint > 0) {
      console.log(`  [Joint-C] ${zeroJoint}/${candidatePool.length} pool papers have joint_score=0 (${pct(zeroJoint, candidatePool.length)} sparse intersection)`);
    }
  }

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
