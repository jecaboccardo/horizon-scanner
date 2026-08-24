/**
 * Eval harness: compare 4 retrieval configs against gold-labeled queries.
 *
 * Configs:
 *   A — match_works (current baseline, no filters)
 *   B — match_works_v2, no filters (sanity: should match A minus HNSW forcing)
 *   C — match_works_v2, default quality/venue/year filters
 *   D — match_works_v2, default filters + query-derived topics/regions
 *
 * Metrics per config × query:
 *   - recall@20 / precision@20 / irrelevant@20
 *   - canary recall (top-50, by DOI or title match)
 *   - candidate universe size + % reduction from full corpus
 *   - papers passing venue/year pre-filter
 *   - papers DROPPED by venue filter that are labeled relevant or canary (CRITICAL)
 *   - latency p50 / p95 (3 runs)
 *
 * Usage:
 *   node scripts/eval-prefilter-comparison.mjs
 *   node scripts/eval-prefilter-comparison.mjs --config A,C
 *   node scripts/eval-prefilter-comparison.mjs --query q01
 *
 * Requires: match_works_v2 RPC deployed (migration 20260513000002).
 * Configs B/C/D report NOT_DEPLOYED until migrations are applied.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RUNS_PER_QUERY = 3;
const MATCH_COUNT    = 50;
const THRESHOLD      = 0.45;

const __dir = dirname(fileURLToPath(import.meta.url));
const EVALS_PATH = join(__dir, '../evals/queries.json');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ---------------------------------------------------------------------------
// Venue constants (mirrors retrieval.ts TIER_VENUES tier 1+2)
// ---------------------------------------------------------------------------

const TIER1_2_VENUES = [
  "American Economic Review", "The Quarterly Journal of Economics", "Econometrica",
  "Journal of Political Economy", "The Review of Economic Studies",
  "Journal of Economic Literature", "The Journal of Economic Perspectives",
  "The Review of Economics and Statistics", "The Economic Journal",
  "Journal of the European Economic Association", "American Economic Journal Applied Economics",
  "American Economic J.: Economic Policy", "American Economic Journal Economic Policy",
  "American Economic Journal Macroeconomics", "American Economic Journal Microeconomics",
  "Journal of Econometrics", "Journal of International Economics", "International Economic Review",
  "Journal of Labor Economics", "Journal of Public Economics", "Journal of Development Economics",
  "The Journal of Human Resources", "Journal of Health Economics",
  "Brookings Papers on Economic Activity", "Journal of Monetary Economics", "Journal of Economic Theory",
  "Games and Economic Behavior", "RAND Journal of Economics", "Journal of Industrial Economics",
  "Journal of Urban Economics", "European Economic Review", "Journal of Financial Economics",
  "The Journal of Finance", "Review of Financial Studies", "Journal of Accounting and Economics",
  "Journal of Accounting Research", "American Political Science Review",
  "American Journal of Political Science", "World Politics", "International Organization",
  "The Journal of Politics",
];

const VENUE_PATTERNS = [
  '%iadb%', '%inter-american development bank%', '%idb working paper%', '%idb publication%',
  '%world bank%', '%open knowledge repository%', '%worldbank.org%',
  '%oecd%', '%cepal%', '%eclac%',
  '%nber%', '%national bureau of economic research%',
  '%ssrn%', '%iza%', '%cepr%', '%j-pal%', '%3ie%',
  '%unicef%', '%ilo %', '%undp%', '%imf %', '%unesco%',
];

// Config C: year + SMS soft only. NO venue pre-filter.
// Venue quality is a post-retrieval boost, not a hard gate.
// User-explicit venue selections (Config D) are the only place venue enters SQL.
// sms_min=2: eval showed sms>=3 drops AER paper (sms=2) + World Development papers.
// sms=1 (weak association) and sms=0 (non-empirical) are excluded by default.
const DEFAULT_FILTERS = {
  filter_min_year: 2010,
  filter_sms_min:  2,      // soft inside v2 SQL: sms >= 2 OR sms IS NULL
};

// Config D: simulates a user who explicitly selected venues/institutions in the UI.
// This is the only scenario where venue becomes a hard SQL pre-filter.
const QUERY_DERIVED_FILTERS = {
  'q01-teacher-incentives-hard-staff': {
    ...DEFAULT_FILTERS,
    // User explicitly picked "Tier 1+2 + IADB + WB + NBER/SSRN" in the source panel
    filter_venue_exact:    TIER1_2_VENUES,
    filter_source_families: ['IADB', 'World Bank', 'NBER', 'SSRN', 'IZA', 'CEPR', 'RePEc'],
  },
  'q02-gender-violence-labor': {
    ...DEFAULT_FILTERS,
    filter_venue_exact:    TIER1_2_VENUES,
    filter_source_families: ['IADB', 'World Bank', 'NBER', 'SSRN', 'IZA', 'CEPR', 'RePEc'],
  },
  'q03-digital-health-edu-labor': {
    ...DEFAULT_FILTERS,
    filter_min_year:       2015,
    filter_venue_exact:    TIER1_2_VENUES,
    filter_source_families: ['IADB', 'World Bank', 'NBER', 'SSRN', 'IZA', 'CEPR', 'RePEc'],
  },
};

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embedQuery(text) {
  const model = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
  const base  = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
  const key   = process.env.LLM_API_KEY;
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, input: 'search_query: ' + text }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data[0].embedding;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

async function runRpc(rpcFn, embedding, queryText, filterParams = {}) {
  const t0 = Date.now();
  const { data, error } = await sb.rpc(rpcFn, {
    query_embedding: embedding,
    query_text:      queryText,
    match_threshold: THRESHOLD,
    match_count:     MATCH_COUNT,
    ...filterParams,
  });
  const latency = Date.now() - t0;
  if (error) {
    const isNotDeployed = error.message.includes('does not exist') || error.message.includes('schema cache');
    return { papers: null, latency, error: isNotDeployed ? 'NOT_DEPLOYED' : error.message };
  }
  return { papers: data ?? [], latency, error: null };
}

// ---------------------------------------------------------------------------
// Universe size analysis (multiple variants for the filter harm analysis)
// ---------------------------------------------------------------------------

async function universeAnalysis(filterParams) {
  const total = 621391; // from prior probe (works with embedding IS NOT NULL)

  // 1. No filter baseline
  const { count: noFilter } = await sb.from('works')
    .select('id', { count: 'exact', head: true })
    .not('embedding', 'is', null);

  // 2. Year filter only
  let yearQ = sb.from('works').select('id', { count: 'exact', head: true }).not('embedding', 'is', null);
  if (filterParams.filter_min_year) yearQ = yearQ.gte('year', filterParams.filter_min_year);
  if (filterParams.filter_max_year) yearQ = yearQ.lte('year', filterParams.filter_max_year);
  const { count: afterYear } = await yearQ;

  // 3. SMS soft (>= X, excl. NULL — PostgREST limitation; v2 SQL includes NULL)
  let smsQ = yearQ;
  if (filterParams.filter_sms_min != null) {
    smsQ = sb.from('works').select('id', { count: 'exact', head: true })
      .not('embedding', 'is', null)
      .gte('year', filterParams.filter_min_year ?? 0)
      .gte('sms_level', filterParams.filter_sms_min);
  }
  const { count: afterSmsCounts, error: smsErr } = await smsQ;
  const afterSmsHard = smsErr ? null : afterSmsCounts;

  return {
    noFilter: noFilter ?? total,
    afterYear: afterYear ?? '—',
    afterSmsHard,   // note: SQL v2 is softer (includes NULL) — this under-counts
    yearReduction: afterYear ? `${(100 * (1 - afterYear / (noFilter ?? total))).toFixed(0)}%` : '—',
  };
}

// ---------------------------------------------------------------------------
// CRITICAL: filter harm analysis
//
// For Config C/D — find labeled relevant + canary papers that would be DROPPED
// by the venue/year filters. Run via PostgREST to fetch their actual venue/year.
// ---------------------------------------------------------------------------

async function filterHarmAnalysis(goldQuery, filterParams) {
  if (!filterParams.filter_venue_exact && !filterParams.filter_venue_patterns && !filterParams.filter_source_families && !filterParams.filter_min_year) {
    return null;
  }

  const labels = goldQuery.labels ?? {};
  const canaries = goldQuery.canary_papers ?? [];

  // Collect all DOIs from labeled relevant/partial + canaries with doi_hint
  const relevantDois = Object.values(labels)
    .filter(e => (e.label === 'relevant' || e.label === 'partial') && e.doi)
    .map(e => e.doi);
  const canaryDois = canaries.filter(c => c.doi_hint).map(c => c.doi_hint);
  const allDois = [...new Set([...relevantDois, ...canaryDois])];

  if (allDois.length === 0) return null;

  // Fetch actual venue + year for these papers from DB
  const { data: rows, error } = await sb
    .from('works')
    .select('canonical_doi, title, venue, source_family, year, sms_level, abs_rating')
    .in('canonical_doi', allDois);

  if (error || !rows?.length) return { fetched: 0, dropped: [], notInCorpus: allDois.length };

  const venueExactSet = new Set((filterParams.filter_venue_exact ?? []).map(v => v.toLowerCase()));
  const patterns = (filterParams.filter_venue_patterns ?? []).map(p =>
    p.replace(/%/g, '').toLowerCase()
  );
  const sourceFamilySet = new Set(filterParams.filter_source_families ?? []);

  const dropped = [];
  const passed = [];

  for (const row of rows) {
    const venueLow = (row.venue ?? '').toLowerCase();
    const yearOk = !filterParams.filter_min_year || (row.year ?? 0) >= filterParams.filter_min_year;
    const venueExactOk = venueExactSet.has(venueLow);
    const venuePattOk  = patterns.some(p => venueLow.includes(p));
    const sourceFamilyOk = sourceFamilySet.has(row.source_family ?? '');
    const venueOk = !filterParams.filter_venue_exact && !filterParams.filter_venue_patterns && !filterParams.filter_source_families
      ? true
      : venueExactOk || venuePattOk || sourceFamilyOk;

    // Note: SMS in v2 is soft (OR NULL) so unclassified papers pass
    const smsOk = !filterParams.filter_sms_min
      || (row.sms_level == null)  // soft: NULL passes
      || (row.sms_level >= filterParams.filter_sms_min);

    const passes = yearOk && venueOk && smsOk;
    const doi = row.canonical_doi;
    const isCanary = canaryDois.includes(doi);
    const labelEntry = Object.values(labels).find(e => e.doi === doi);
    const goldLabel = labelEntry?.label ?? (isCanary ? 'canary' : '?');

    (passes ? passed : dropped).push({
      doi, title: (row.title ?? '').slice(0, 60),
      venue: row.venue ?? '<null>', sourceFamily: row.source_family ?? '<null>', year: row.year,
      sms: row.sms_level ?? 'null',
      goldLabel, isCanary,
      dropReason: !yearOk ? `year ${row.year} < ${filterParams.filter_min_year}` : !venueOk ? `venue/source "${row.venue}" / "${row.source_family}" not in selected source universe` : `sms ${row.sms_level} < ${filterParams.filter_sms_min}`,
    });
  }

  return {
    fetched:    rows.length,
    passCount:  passed.length,
    dropCount:  dropped.length,
    notInCorpus: allDois.length - rows.length,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normalizeDoi(doi) {
  if (!doi) return null;
  return doi.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

function normalizeTitle(title) {
  if (!title) return null;
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function scoreResults(papers, goldQuery) {
  const { labels, canary_papers = [] } = goldQuery;

  // DOI → label from gold top-20
  const doiToLabel = {};
  for (const entry of Object.values(labels ?? {})) {
    if (entry.doi) doiToLabel[normalizeDoi(entry.doi)] = entry.label;
  }

  // Canary lookup: by doi_hint (primary) or normalized title (fallback)
  const canaryByDoi   = new Map(canary_papers.filter(c => c.doi_hint).map(c => [normalizeDoi(c.doi_hint), c]));
  const canaryByTitle = new Map(canary_papers.filter(c => c.title).map(c => [normalizeTitle(c.title), c]));

  // Score top-20
  const top20 = (papers ?? []).slice(0, 20);
  const dist = { relevant: 0, partial: 0, irrelevant: 0, unlabeled: 0 };
  for (const p of top20) {
    const key = normalizeDoi(p.canonical_doi);
    const label = key ? doiToLabel[key] : undefined;
    if      (label === 'relevant')   dist.relevant++;
    else if (label === 'partial')    dist.partial++;
    else if (label === 'irrelevant') dist.irrelevant++;
    else                             dist.unlabeled++;
  }

  // Canary recall in top-50 (DOI or title match)
  const top50 = (papers ?? []).slice(0, 50);
  const canaryHitIds = new Set();
  for (const p of top50) {
    const doi = normalizeDoi(p.canonical_doi);
    const title = normalizeTitle(p.title);
    if (doi && canaryByDoi.has(doi))     canaryHitIds.add(canaryByDoi.get(doi).id);
    if (title && canaryByTitle.has(title)) canaryHitIds.add(canaryByTitle.get(title).id);
  }

  return {
    dist,
    precision20: dist.relevant / 20,
    recall20:    (dist.relevant + dist.partial) / 20,
    canaryHits:  canaryHitIds.size,
    canaryTotal: canary_papers.length,
    top20Count:  top20.length,
  };
}

function pctile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((p / 100) * (sorted.length - 1))] ?? sorted[sorted.length - 1];
}

// ---------------------------------------------------------------------------
// Config definitions
// ---------------------------------------------------------------------------

const CONFIGS = [
  {
    id: 'A',
    label: 'match_works baseline (no filters)',
    fn: (emb, qt) => runRpc('match_works', emb, qt, {}),
    filters: null,
  },
  {
    id: 'B',
    label: 'match_works_v2 no filters (sanity — should equal A)',
    fn: (emb, qt) => runRpc('match_works_v2', emb, qt, {}),
    filters: null,
  },
  {
    id: 'C',
    label: 'match_works_v2 default (year>=2010 + sms>=3 soft, NO venue)',
    fn: (emb, qt) => runRpc('match_works_v2', emb, qt, DEFAULT_FILTERS),
    filters: DEFAULT_FILTERS,
  },
  {
    id: 'D',
    label: 'match_works_v2 user-explicit venue (year+sms+tier1/2+institutions)',
    fn: (emb, qt, qid) => runRpc('match_works_v2', emb, qt, QUERY_DERIVED_FILTERS[qid] ?? DEFAULT_FILTERS),
    filters: (qid) => QUERY_DERIVED_FILTERS[qid] ?? DEFAULT_FILTERS,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const configFilter = args.find(a => a.startsWith('--config='))?.split('=')[1]?.split(',');
  const queryFilter  = args.find(a => a.startsWith('--query='))?.split('=')[1];

  const evals = JSON.parse(readFileSync(EVALS_PATH, 'utf8'));
  const queries = evals.queries.filter(q => !queryFilter || q.id === queryFilter);
  const configs = CONFIGS.filter(c => !configFilter || configFilter.includes(c.id));

  const TOTAL_CORPUS = 621391;

  console.log(`\n${'='.repeat(90)}`);
  console.log(`eval-prefilter-comparison  |  ${queries.length} queries × ${configs.length} configs × ${RUNS_PER_QUERY} runs`);
  console.log(`threshold=${THRESHOLD}  match_count=${MATCH_COUNT}  corpus=${TOTAL_CORPUS}  ${new Date().toISOString().slice(0,19)}Z`);
  console.log('='.repeat(90));

  const results = {};

  for (const query of queries) {
    console.log(`\n▸ Query: ${query.id}`);
    console.log(`  "${query.query}"`);

    let embedding;
    try {
      process.stdout.write('  Embedding... ');
      const t0 = Date.now();
      embedding = await embedQuery(query.query);
      console.log(`done (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`  EMBED ERROR: ${e.message}`);
      continue;
    }

    results[query.id] = {};

    for (const cfg of configs) {
      process.stdout.write(`  Config ${cfg.id}... `);
      const latencies = [];
      let lastResult = null;

      for (let run = 0; run < RUNS_PER_QUERY; run++) {
        lastResult = await cfg.fn(embedding, query.query, query.id);
        latencies.push(lastResult.latency);
        if (lastResult.error === 'NOT_DEPLOYED') break;
      }

      const p50 = pctile(latencies, 50);
      const p95 = pctile(latencies, 95);

      if (lastResult.error) {
        console.log(`${lastResult.error}`);
        results[query.id][cfg.id] = { error: lastResult.error, p50, p95 };
        continue;
      }

      const score = scoreResults(lastResult.papers, query);

      // Universe analysis (only for configs with filters, once per config per query)
      const filterParams = typeof cfg.filters === 'function' ? cfg.filters(query.id) : cfg.filters;
      const universe = filterParams
        ? await universeAnalysis(filterParams)
        : { noFilter: TOTAL_CORPUS, afterYear: TOTAL_CORPUS, afterSmsHard: null, yearReduction: '0%' };

      console.log(`p50=${p50}ms p95=${p95}ms returned=${lastResult.papers.length} canary=${score.canaryHits}/${score.canaryTotal}`);
      results[query.id][cfg.id] = { score, latencies, p50, p95, universe, paperCount: lastResult.papers.length, filterParams };
    }

    // Filter harm analysis — run once for Config C filters (most impactful to check)
    const cfgCResult = results[query.id]['C'];
    if (cfgCResult && !cfgCResult.error && cfgCResult.filterParams) {
      process.stdout.write('  Filter harm analysis... ');
      const harm = await filterHarmAnalysis(query, cfgCResult.filterParams);
      if (harm) {
        results[query.id].__harm = harm;
        console.log(`${harm.dropCount} gold/canary papers DROPPED by venue filter (${harm.passCount} pass)`);
      } else {
        console.log('skipped (no filters or no DOIs)');
      }
    } else if (!results[query.id]['C']?.error) {
      // Config C not run but we still want harm analysis with default filters
      process.stdout.write('  Filter harm analysis (default filters, no RPC)... ');
      const harm = await filterHarmAnalysis(query, DEFAULT_FILTERS);
      if (harm) {
        results[query.id].__harm = harm;
        console.log(`${harm.dropCount} gold/canary papers dropped, ${harm.notInCorpus} not in corpus`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Results tables
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(90)}`);
  console.log('RESULTS');
  console.log('='.repeat(90));

  for (const query of queries) {
    const qr = results[query.id] ?? {};
    console.log(`\n## ${query.id}`);
    console.log(`   Query: "${query.query}"`);
    console.log(`   Gold labels: ${Object.keys(query.labels ?? {}).length} | Canaries: ${(query.canary_papers ?? []).length}`);

    // Main metrics table
    const header = ['Cfg', 'Rel@20', 'Part@20', 'Irr@20', 'Unlbl', 'Prec@20', 'Rec@20', 'Canary@50', 'p50ms', 'p95ms', 'Returned'];
    const rows = [];
    for (const cfg of configs) {
      const r = qr[cfg.id];
      if (!r) { rows.push([cfg.id, ...Array(10).fill('—')]); continue; }
      if (r.error) { rows.push([cfg.id, r.error.slice(0, 20), ...Array(9).fill('')]); continue; }
      const s = r.score;
      rows.push([
        cfg.id,
        s.dist.relevant, s.dist.partial, s.dist.irrelevant, s.dist.unlabeled,
        `${(s.precision20*100).toFixed(0)}%`,
        `${(s.recall20*100).toFixed(0)}%`,
        `${s.canaryHits}/${s.canaryTotal}`,
        r.p50, r.p95, r.paperCount,
      ]);
    }
    printTable(header, rows);

    // Universe shrink table (filtered configs only)
    const filteredRows = configs
      .filter(c => qr[c.id] && !qr[c.id].error && qr[c.id].universe?.afterYear !== TOTAL_CORPUS)
      .map(c => {
        const u = qr[c.id].universe;
        return [
          c.id,
          u.noFilter,
          u.afterYear,
          u.yearReduction,
          u.afterSmsHard ?? '(soft—incl.null)',
          u.afterSmsHard ? `${(100*(1-u.afterSmsHard/u.noFilter)).toFixed(0)}%` : '—',
        ];
      });
    if (filteredRows.length > 0) {
      console.log('\n  Universe shrink:');
      printTable(
        ['Cfg', 'Full corpus', 'After year', 'Year reduction', 'After sms>=X (hard)', 'SMS reduction'],
        filteredRows,
        '  ',
      );
    }

    // Filter harm report
    const harm = qr.__harm;
    if (harm) {
      console.log(`\n  Filter harm (Config C venue+year defaults vs gold/canary papers):`);
      console.log(`    Papers checked: ${harm.fetched} | Passed: ${harm.passCount} | DROPPED: ${harm.dropCount} | Not in corpus: ${harm.notInCorpus}`);
      if (harm.dropped.length > 0) {
        console.log('    Dropped gold/canary papers:');
        for (const d of harm.dropped) {
          const tag = d.isCanary ? '[CANARY]' : `[${d.goldLabel}]`;
          console.log(`      ${tag} ${d.title} (venue="${d.venue}" year=${d.year} sms=${d.sms})`);
          console.log(`             Drop reason: ${d.dropReason}`);
        }
      } else {
        console.log('    ✓ No gold/canary papers dropped by default venue filter.');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-query summary
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(90)}`);
  console.log('CROSS-QUERY SUMMARY');
  console.log('='.repeat(90));

  const summaryRows = configs.map(cfg => {
    let totRel = 0, totPart = 0, totIrr = 0, totCanaryHit = 0, totCanaryMax = 0;
    let latencies = [], errors = 0;
    for (const q of queries) {
      const r = results[q.id]?.[cfg.id];
      if (!r || r.error) { errors++; continue; }
      totRel += r.score.dist.relevant;
      totPart += r.score.dist.partial;
      totIrr += r.score.dist.irrelevant;
      totCanaryHit += r.score.canaryHits;
      totCanaryMax += r.score.canaryTotal;
      latencies.push(r.p50);
    }
    const avgP50 = latencies.length ? Math.round(latencies.reduce((a,b)=>a+b)/latencies.length) : '—';
    return [
      `${cfg.id} (${cfg.label.slice(0,35)})`,
      errors > 0 ? `${errors}err` : totRel,
      errors > 0 ? '' : totPart,
      errors > 0 ? '' : totIrr,
      errors > 0 ? '—' : `${totCanaryHit}/${totCanaryMax}`,
      errors > 0 ? '—' : avgP50,
    ];
  });
  printTable(['Config', 'Rel@20 (Σ)', 'Part@20 (Σ)', 'Irr@20 (Σ)', 'Canary (Σ)', 'Avg p50ms'], summaryRows);

  // ---------------------------------------------------------------------------
  // EXPLAIN ANALYZE commands
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(90)}`);
  console.log('EXPLAIN ANALYZE — paste these in psql after migrations are applied');
  console.log('='.repeat(90));
  console.log('\n-- Config A baseline:');
  console.log(`EXPLAIN ANALYZE SELECT * FROM match_works(NULL::extensions.vector(768), 'test', 0.45, 50);`);
  console.log('\n-- Config C (default pre-filters):');
  console.log(`EXPLAIN ANALYZE SELECT * FROM match_works_v2(NULL::extensions.vector(768), 'test', 0.45, 50,`);
  console.log(`  2010, NULL,`);
  console.log(`  ARRAY['American Economic Review', 'The Quarterly Journal of Economics']::text[],  -- (add full tier list)`);
  console.log(`  ARRAY['%iadb%','%world bank%','%nber%','%ssrn%','%iza%']::text[],`);
  console.log(`  NULL, NULL, NULL, 3, NULL, NULL);`);
  console.log('\n-- Universe counts:');
  console.log(`SELECT 'full' AS scope, count(*) FROM works WHERE embedding IS NOT NULL`);
  console.log(`UNION ALL SELECT 'year>=2010', count(*) FROM works WHERE embedding IS NOT NULL AND year >= 2010`);
  console.log(`UNION ALL SELECT 'year+sms>=3(soft)', count(*) FROM works WHERE embedding IS NOT NULL AND year >= 2010 AND (sms_level >= 3 OR sms_level IS NULL)`);
  console.log(`UNION ALL SELECT 'year+sms+venue(approx)', count(*) FROM works`);
  console.log(`  WHERE embedding IS NOT NULL AND year >= 2010 AND (sms_level >= 3 OR sms_level IS NULL)`);
  console.log(`  AND (venue ILIKE ANY(ARRAY['%iadb%','%world bank%','%nber%','%ssrn%','%iza%','%oecd%']) OR venue = ANY(ARRAY['American Economic Review','Journal of Labor Economics' /*, ...add tier list */]));`);

  console.log('\n✓ Eval complete.\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function printTable(header, rows, indent = '') {
  const widths = header.map((h, i) =>
    Math.max(String(h).length, ...rows.map(r => String(r[i] ?? '').length)) + 2
  );
  const fmt = row => indent + row.map((v, i) => String(v ?? '').padEnd(widths[i])).join('| ');
  const sep = indent + widths.map(w => '-'.repeat(w)).join('+-');
  console.log(fmt(header));
  console.log(sep);
  for (const row of rows) console.log(fmt(row));
}

main().catch(e => { console.error(e); process.exit(1); });
