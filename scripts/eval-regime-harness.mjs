/**
 * eval-regime-harness.mjs
 *
 * Measures which retrieval strategy wins for each query class.
 *
 * Compares three configurations for each of the 23 gold queries:
 *   current_prod  — match_works_v2 with year>=2010 + sms>=2 soft (live today)
 *   regime_opt    — strategy derived from each query's retrieval_class:
 *     dense_causal:  single-vector, NO year floor (foundational papers pre-2010 needed)
 *     sparse_multi:  multi-vector (2 facets derived from query), geometric mean sort
 *     constrained:   single-vector + year>=2010 + geographic pre-filter when query implies LAC
 *   no_filter     — match_works_v2 with no filters (ceiling reference)
 *
 * Primary metric: canary hit rate (do the canonical papers surface in top-50?).
 * Secondary: if labeled (q01-q03), also reports Rel/Part/Irr@20.
 *
 * Usage:
 *   node scripts/eval-regime-harness.mjs
 *   node scripts/eval-regime-harness.mjs --class dense_causal
 *   node scripts/eval-regime-harness.mjs --query q05
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const evals = JSON.parse(readFileSync(join(__dir,'../evals/queries.json'),'utf8'));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE = process.env.LLM_BASE_URL;
const KEY  = process.env.LLM_API_KEY;
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

const THRESHOLD   = 0.40;
const MATCH_COUNT = 50;
const RUNS        = 2;

// LAC geography filter terms (for constrained class with LAC queries)
const LAC_REGIONS = [
  "Latin America", "Latin america", "Latinoamérica", "LAC", "Caribbean",
  "Mexico", "Brazil", "Brasil", "Colombia", "Peru", "Argentina", "Chile",
  "Ecuador", "Venezuela", "Bolivia", "Paraguay", "Uruguay", "Costa Rica",
  "Panama", "Guatemala", "Honduras", "El Salvador", "Nicaragua",
  "Dominican Republic", "Haiti", "Jamaica",
];

// Facet decomposition for sparse_multi queries (hardcoded — calling Qwen adds latency)
const SPARSE_FACETS = {
  'q03-digital-health-edu-labor': [
    'digital health mhealth telemedicine mobile health digital interventions eHealth',
    'education schooling learning students enrollment literacy school outcomes',
    'labor employment wages earnings productivity labor market outcomes',
  ],
  'q14-cct-poverty-reduction-mechanisms': [
    'conditional cash transfers CCT social protection mechanisms channels pathways',
    'poverty reduction consumption investment human capital behavior change graduation',
  ],
  'q16-automation-labor-polarization-developing': [
    'automation robots technology routine task displacement technological change',
    'labor polarization wage inequality developing countries middle skill jobs',
  ],
  'q20-school-vs-household-learning': [
    'school quality teacher effectiveness school resources infrastructure',
    'household socioeconomic conditions family income parental education poverty',
  ],
  'q23-informality-productivity-bidirectional': [
    'informality informal sector self-employment informal firms productivity',
    'aggregate productivity TFP growth formal sector regulation tax compliance',
  ],
};

// Queries that have a LAC geography constraint (for constrained class)
const LAC_CONSTRAINED_QUERIES = new Set([
  'q04-minwage-informality-lac',
  'q19-inequality-social-mobility-lac',
]);

async function embed(text) {
  const r = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, input: 'search_query: ' + text }),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed error: ' + JSON.stringify(j).slice(0,150));
  return j.data[0].embedding;
}

async function runSingleVector(vec, queryText, params = {}) {
  const t0 = Date.now();
  const { data, error } = await sb.rpc('match_works_v2', {
    query_embedding: vec, query_text: queryText,
    match_threshold: THRESHOLD, match_count: MATCH_COUNT,
    ...params,
  });
  return { papers: data ?? [], ms: Date.now() - t0, error: error?.message };
}

async function runMultiVector(facetVecs, facetTexts, gmSort = true) {
  const t0 = Date.now();
  const results = await Promise.all(
    facetVecs.map((v, i) => sb.rpc('match_works_v2', {
      query_embedding: v, query_text: facetTexts[i],
      match_threshold: THRESHOLD, match_count: MATCH_COUNT,
    }))
  );
  const map = new Map();
  for (let i = 0; i < results.length; i++) {
    for (const p of results[i].data ?? []) {
      const ex = map.get(p.id);
      if (!ex) {
        map.set(p.id, { ...p, _facetSims: [p.similarity] });
      } else {
        ex._facetSims.push(p.similarity);
        ex.similarity = Math.max(ex.similarity, p.similarity);
      }
    }
  }
  let papers = [...map.values()];
  if (gmSort) {
    // Geometric mean of per-facet similarities
    papers.sort((a, b) => {
      const gmA = Math.exp(a._facetSims.reduce((s,v) => s + Math.log(Math.max(v,0.01)), 0) / a._facetSims.length);
      const gmB = Math.exp(b._facetSims.reduce((s,v) => s + Math.log(Math.max(v,0.01)), 0) / b._facetSims.length);
      return gmB - gmA;
    });
  } else {
    papers.sort((a, b) => b.similarity - a.similarity);
  }
  return { papers, ms: Date.now() - t0 };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function normDoi(d) { return d?.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//,'') ?? ''; }
function normTitle(t) { return (t??'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim(); }

function scoreQuery(papers, query) {
  const labels = query.labels ?? {};
  const doiToLabel = {};
  for (const e of Object.values(labels)) { if (e.doi) doiToLabel[normDoi(e.doi)] = e.label; }

  const canaries = query.canary_papers ?? [];
  const canaryByDoi   = new Map(canaries.filter(c=>c.doi_hint).map(c=>[normDoi(c.doi_hint),c]));
  const canaryByTitle = new Map(canaries.filter(c=>c.title).map(c=>[normTitle(c.title),c]));

  const hasLabels = Object.keys(labels).length > 0;
  const top20 = papers.slice(0,20);
  const dist = hasLabels ? { relevant:0, partial:0, irrelevant:0, unlabeled:0 } : null;
  if (hasLabels) {
    for (const p of top20) {
      const key = normDoi(p.canonical_doi);
      const label = key ? doiToLabel[key] : undefined;
      if      (label==='relevant')   dist.relevant++;
      else if (label==='partial')    dist.partial++;
      else if (label==='irrelevant') dist.irrelevant++;
      else                           dist.unlabeled++;
    }
  }

  const top50 = papers.slice(0,50);
  const hits = new Set();
  for (const p of top50) {
    const doi = normDoi(p.canonical_doi);
    const ttl = normTitle(p.title);
    if (doi && canaryByDoi.has(doi)) hits.add(canaryByDoi.get(doi).id);
    if (ttl && canaryByTitle.has(ttl)) hits.add(canaryByTitle.get(ttl).id);
  }

  return { dist, canaryHits: hits.size, canaryTotal: canaries.length, hasLabels };
}

// ── Per-config strategy ───────────────────────────────────────────────────────

async function runConfig(configName, query, queryVec) {
  const lats = [];
  let papers = [];

  for (let r = 0; r < RUNS; r++) {
    let result;
    if (configName === 'no_filter') {
      result = await runSingleVector(queryVec, query.query);
    } else if (configName === 'current_prod') {
      result = await runSingleVector(queryVec, query.query, { filter_min_year: 2010, filter_sms_min: 2 });
    } else if (configName === 'regime_opt') {
      const cls = query.retrieval_class;
      if (cls === 'dense_causal') {
        // No year floor — foundational papers pre-2010 needed; sms>=2 soft
        result = await runSingleVector(queryVec, query.query, { filter_sms_min: 2 });
      } else if (cls === 'sparse_multi') {
        const facetTexts = SPARSE_FACETS[query.id];
        if (!facetTexts) {
          result = await runSingleVector(queryVec, query.query);
        } else {
          const facetVecs = await Promise.all(facetTexts.map(t => embed(t)));
          const r2 = await runMultiVector(facetVecs, facetTexts, true);
          lats.push(r2.ms);
          papers = r2.papers;
          continue;
        }
      } else { // constrained
        const params = { filter_min_year: 2010, filter_sms_min: 2 };
        if (LAC_CONSTRAINED_QUERIES.has(query.id)) {
          params.filter_regions = LAC_REGIONS;
        }
        result = await runSingleVector(queryVec, query.query, params);
      }
    }
    if (result?.error) { console.error(`    ${configName} error:`, result.error); break; }
    lats.push(result.ms);
    papers = result?.papers ?? [];
  }

  const sorted = lats.slice().sort((a,b)=>a-b);
  const s = scoreQuery(papers, query);
  return { configName, ...s, p50: sorted[Math.floor(sorted.length/2)] ?? 0, returned: papers.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const classFilter = args.find(a => a.startsWith('--class='))?.split('=')[1];
  const queryFilter  = args.find(a => a.startsWith('--query='))?.split('=')[1];

  const queries = evals.queries.filter(q => {
    if (queryFilter) return q.id === queryFilter;
    if (classFilter) return q.retrieval_class === classFilter;
    return true;
  });

  const configs = ['no_filter', 'current_prod', 'regime_opt'];

  console.log(`\n${'='.repeat(90)}`);
  console.log(`REGIME MEASUREMENT HARNESS  |  ${queries.length} queries × ${configs.length} configs`);
  console.log(`threshold=${THRESHOLD}  match_count=${MATCH_COUNT}  runs=${RUNS}`);
  console.log('='.repeat(90)+'\n');

  const allResults = [];

  for (const q of queries) {
    const cls = q.retrieval_class ?? 'unknown';
    console.log(`▸ [${cls}] ${q.id}`);
    console.log(`  "${q.query.slice(0,70)}"`);

    let queryVec;
    try {
      process.stdout.write('  Embedding query... ');
      queryVec = await embed(q.query);
      console.log('done');
    } catch (e) {
      console.error('  EMBED ERROR:', e.message);
      continue;
    }

    const queryResults = { id: q.id, class: cls };
    for (const cfg of configs) {
      process.stdout.write(`  ${cfg}... `);
      const r = await runConfig(cfg, q, queryVec);
      queryResults[cfg] = r;
      const canaryStr = `${r.canaryHits}/${r.canaryTotal}`;
      const labelStr = r.hasLabels ? ` R=${r.dist?.relevant} P=${r.dist?.partial} I=${r.dist?.irrelevant}` : '';
      console.log(`canary=${canaryStr}${labelStr} p50=${r.p50}ms ret=${r.returned}`);
    }

    // Delta summary
    const base = queryResults.current_prod.canaryHits;
    const opt  = queryResults.regime_opt.canaryHits;
    const delta = opt - base;
    if (delta !== 0) {
      console.log(`  ⟹  regime_opt vs current_prod: canary ${delta > 0 ? '+'+delta : delta} (${base}→${opt})`);
    }
    console.log();
    allResults.push(queryResults);
  }

  // ── Summary by class ────────────────────────────────────────────────────────
  console.log('='.repeat(90));
  console.log('SUMMARY BY CLASS');
  console.log('='.repeat(90));

  const classes = ['dense_causal', 'sparse_multi', 'constrained'];
  for (const cls of classes) {
    const clsResults = allResults.filter(r => r.class === cls);
    if (!clsResults.length) continue;

    let prodCanary=0, optCanary=0, noFiltCanary=0, total=0;
    let prodLat=[], optLat=[];
    for (const r of clsResults) {
      prodCanary   += r.current_prod?.canaryHits ?? 0;
      optCanary    += r.regime_opt?.canaryHits   ?? 0;
      noFiltCanary += r.no_filter?.canaryHits    ?? 0;
      total        += r.current_prod?.canaryTotal ?? 0;
      if (r.current_prod?.p50) prodLat.push(r.current_prod.p50);
      if (r.regime_opt?.p50)   optLat.push(r.regime_opt.p50);
    }
    const avgProdLat = prodLat.length ? Math.round(prodLat.reduce((a,b)=>a+b)/prodLat.length) : '—';
    const avgOptLat  = optLat.length  ? Math.round(optLat.reduce((a,b)=>a+b)/optLat.length)  : '—';
    const delta = optCanary - prodCanary;
    const winner = delta > 0 ? 'regime_opt WINS' : delta < 0 ? 'current_prod WINS' : 'TIE';

    console.log(`\n${cls} (${clsResults.length} queries, ${total} canaries):`);
    console.log(`  no_filter:    canary ${noFiltCanary}/${total}`);
    console.log(`  current_prod: canary ${prodCanary}/${total}  avg_p50=${avgProdLat}ms`);
    console.log(`  regime_opt:   canary ${optCanary}/${total}  avg_p50=${avgOptLat}ms  → ${winner} (Δ${delta >= 0 ? '+' : ''}${delta})`);
  }

  // ── Overall ─────────────────────────────────────────────────────────────────
  let grandProd=0, grandOpt=0, grandTotal=0;
  for (const r of allResults) {
    grandProd  += r.current_prod?.canaryHits ?? 0;
    grandOpt   += r.regime_opt?.canaryHits   ?? 0;
    grandTotal += r.current_prod?.canaryTotal ?? 0;
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TOTAL  current_prod: ${grandProd}/${grandTotal}  regime_opt: ${grandOpt}/${grandTotal}  Δ${grandOpt-grandProd >= 0 ? '+' : ''}${grandOpt-grandProd}`);

  const outPath = join(__dir,'../reports/regime-harness-results.json');
  writeFileSync(outPath, JSON.stringify({ results: allResults, date: new Date().toISOString() }, null, 2));
  console.log(`\n✓ Saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
