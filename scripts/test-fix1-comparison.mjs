/**
 * Fix-1 test: compare old vs new violence facet expansion on q02.
 *
 * Configs tested:
 *   A — baseline: single query vector, original query_text (no FTS expansion)
 *   B — single query vector + FTS synonym expansion on query_text
 *   C — multi-vector with OLD violence facet (pure synonyms) + labor facet
 *   D — multi-vector with NEW violence facet (+ outcome-linked phrases) + labor facet
 *
 * Scores against q02 gold labels. Reports Rel/Part/Irr/canary + latency.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const evals = JSON.parse(readFileSync(join(__dir,'../evals/queries.json'),'utf8'));
const q02 = evals.queries.find(q => q.id === 'q02-gender-violence-labor');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE = process.env.LLM_BASE_URL;
const KEY  = process.env.LLM_API_KEY;
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

const THRESHOLD   = 0.40;
const MATCH_COUNT = 50;
const RUNS        = 3;

async function embed(text) {
  const r = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, input: 'search_query: ' + text }),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed error: ' + JSON.stringify(j).slice(0,200));
  return j.data[0].embedding;
}

// Facet texts
const QUERY = q02.query;

const OLD_VIOLENCE = [
  'gender violence', 'domestic violence', 'intimate partner violence', 'ipv',
  'spousal abuse', 'spousal violence', 'violence against women', 'vaw',
  'violencia domestica', 'violencia de pareja', 'violencia de genero',
  'sexual assault', 'battering', 'abuse', 'harassment',
].join(' ');

const NEW_VIOLENCE = OLD_VIOLENCE + ' ' + [
  'domestic violence labor', 'domestic violence employment', 'domestic violence wages',
  'domestic violence economic', 'intimate partner violence labor',
  'intimate partner violence employment', 'intimate partner violence female labor',
  'intimate partner violence wages', 'violence against women labor supply',
  'violence against women employment', 'violence against women economic consequences',
  'gender violence female labor', 'abuse female labor force participation',
  'harassment labor market', 'harassment employment women',
].join(' ');

const LABOR = [
  'labor outcomes', 'employment status', 'wages', 'earnings', 'job security', 'work hours',
  'unemployment', 'labor market', 'labor force participation', 'female employment',
  'women employment', 'female labor supply', 'occupational outcomes',
].join(' ');

// FTS expansion (mirrors synonymExpander.ts for gender violence)
const EXPANDED_QT = QUERY + ' domestic violence intimate partner violence IPV violence against women employment wages female labor supply';

// Scoring
function normDoi(d) { return d?.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//,'') ?? ''; }
function normTitle(t) { return (t??'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim(); }

function scoreResults(papers) {
  const doiToLabel = {};
  for (const e of Object.values(q02.labels ?? {})) {
    if (e.doi) doiToLabel[normDoi(e.doi)] = e.label;
  }
  const canaries = q02.canary_papers ?? [];
  const canaryByDoi   = new Map(canaries.filter(c=>c.doi_hint).map(c=>[normDoi(c.doi_hint),c]));
  const canaryByTitle = new Map(canaries.filter(c=>c.title).map(c=>[normTitle(c.title),c]));

  const top20 = papers.slice(0,20);
  const dist  = { relevant:0, partial:0, irrelevant:0, unlabeled:0 };
  const ranked = [];
  for (const p of top20) {
    const key = normDoi(p.canonical_doi);
    const label = key ? doiToLabel[key] : undefined;
    const tag = label === 'relevant' ? 'R' : label === 'partial' ? 'P' : label === 'irrelevant' ? 'I' : '?';
    if (tag === 'R') dist.relevant++;
    else if (tag === 'P') dist.partial++;
    else if (tag === 'I') dist.irrelevant++;
    else dist.unlabeled++;
    ranked.push({ tag, title: p.title?.slice(0,60), sim: p.similarity?.toFixed(3) });
  }

  const top50 = papers.slice(0,50);
  const hits = new Set();
  for (const p of top50) {
    const doi = normDoi(p.canonical_doi);
    const ttl = normTitle(p.title);
    if (doi && canaryByDoi.has(doi)) hits.add(canaryByDoi.get(doi).id);
    if (ttl && canaryByTitle.has(ttl)) hits.add(canaryByTitle.get(ttl).id);
  }

  return { dist, canaryHits: hits.size, canaryTotal: canaries.length, ranked };
}

async function runRPC(vec, queryText) {
  const t0 = Date.now();
  const { data, error } = await sb.rpc('match_works_v2', {
    query_embedding: vec, query_text: queryText,
    match_threshold: THRESHOLD, match_count: MATCH_COUNT,
  });
  return { papers: data ?? [], ms: Date.now() - t0, error };
}

async function runConfig(label, violenceVec, laborVec, queryText) {
  const lats = [];
  let papers = [];

  for (let r = 0; r < RUNS; r++) {
    const t0 = Date.now();
    if (laborVec) {
      // Multi-vector: union of violence + labor facet results, sorted by max similarity
      const [r1, r2] = await Promise.all([
        sb.rpc('match_works_v2', { query_embedding: violenceVec, query_text: queryText, match_threshold: THRESHOLD, match_count: MATCH_COUNT }),
        sb.rpc('match_works_v2', { query_embedding: laborVec,    query_text: queryText, match_threshold: THRESHOLD, match_count: MATCH_COUNT }),
      ]);
      const map = new Map();
      for (const p of [...(r1.data??[]), ...(r2.data??[])]) {
        const ex = map.get(p.id);
        if (!ex || p.similarity > ex.similarity) map.set(p.id, { ...p });
      }
      papers = [...map.values()].sort((a,b) => b.similarity - a.similarity);
    } else {
      const res = await sb.rpc('match_works_v2', { query_embedding: violenceVec, query_text: queryText, match_threshold: THRESHOLD, match_count: MATCH_COUNT });
      papers = res.data ?? [];
    }
    lats.push(Date.now() - t0);
  }

  const sorted = lats.slice().sort((a,b)=>a-b);
  const s = scoreResults(papers);
  return { label, ...s, p50: sorted[Math.floor(sorted.length/2)], p95: sorted[sorted.length-1], returned: papers.length };
}

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`FIX-1 COMPARISON — q02: "${QUERY}"`);
  console.log(`threshold=${THRESHOLD}  match_count=${MATCH_COUNT}  runs=${RUNS}`);
  console.log('='.repeat(80)+'\n');

  process.stdout.write('Embedding (4 vectors)... ');
  const [qVec, oldVVec, newVVec, lVec] = await Promise.all([
    embed(QUERY), embed(OLD_VIOLENCE), embed(NEW_VIOLENCE), embed(LABOR),
  ]);
  console.log('done\n');

  const configs = [
    { label: 'A  baseline (single vec, no FTS expand)',       fn: () => runConfig('A', qVec,    null, QUERY) },
    { label: 'B  single vec + FTS synonyms',                  fn: () => runConfig('B', qVec,    null, EXPANDED_QT) },
    { label: 'C  multi-vec OLD violence + labor facets',      fn: () => runConfig('C', oldVVec, lVec, EXPANDED_QT) },
    { label: 'D  multi-vec NEW violence + labor facets (Fix1)',fn: () => runConfig('D', newVVec, lVec, EXPANDED_QT) },
  ];

  const results = [];
  for (const cfg of configs) {
    process.stdout.write(`  ${cfg.label.split(' ')[0]}... `);
    const r = await cfg.fn();
    results.push(r);
    console.log(`R=${r.dist.relevant} P=${r.dist.partial} I=${r.dist.irrelevant} ?=${r.dist.unlabeled} | canary=${r.canaryHits}/${r.canaryTotal} | p50=${r.p50}ms p95=${r.p95}ms | returned=${r.returned}`);
  }

  const baseRP = results[0].dist.relevant + results[0].dist.partial;
  console.log('\n'+'-'.repeat(80));
  console.log('Config'.padEnd(46) + '| R+P  | Irr | Canary | p50ms | vs A');
  console.log('-'.repeat(80));
  for (const r of results) {
    const rp = r.dist.relevant + r.dist.partial;
    const delta = rp - baseRP;
    const dstr = delta === 0 ? ' —  ' : (delta > 0 ? '+'+delta+'   ' : delta+'  ');
    console.log(r.label.padEnd(46) + `| ${String(rp).padEnd(5)}| ${String(r.dist.irrelevant).padEnd(4)}| ${r.canaryHits}/${r.canaryTotal}    | ${String(r.p50).padEnd(6)}| ${dstr}`);
  }

  // Show D's top-20 labeled
  const d = results[3];
  console.log('\nConfig D top-20 (first 12):');
  for (const { tag, title, sim } of d.ranked.slice(0,12)) {
    console.log(`  [${tag}] ${title} (sim=${sim})`);
  }

  // Save
  writeFileSync(join(__dir,'../reports/fix1-comparison-q02.json'), JSON.stringify({ results, date: new Date().toISOString() }, null, 2));
  console.log('\n✓ Saved to reports/fix1-comparison-q02.json');
}

main().catch(e => { console.error(e); process.exit(1); });
