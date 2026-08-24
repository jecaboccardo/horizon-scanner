/**
 * eval-direct-indirect-classifier.mjs
 *
 * How well does the direct/indirect classifier agree with human labels?
 *
 * Ground truth: q01-q03 have 20 labeled papers each (relevant / partial /
 * irrelevant). The classifier outputs direct-lac / direct-global / indirect /
 * excluded. Expected mapping:
 *   relevant   → direct-*       (right topic, right direction)
 *   partial    → indirect       (adjacent topic, reverse causality, etc.)
 *   irrelevant → excluded       (off-topic)
 *
 * For each labeled paper, compute per-facet cosine sim against the query's
 * Qwen-decomposed facets, then replicate the classifyOne logic in JS under
 * BOTH threshold configs (current prod 0.50/0.55 and proposed 0.40/0.45) so
 * we can decide whether the proposed tuning actually helps.
 *
 * Also run a distribution check on all 23 gold queries — for the top-50
 * returned by match_works_v2, what fraction goes into each bucket? Helps
 * sanity-check whether direct/indirect/excluded are reasonable shapes for
 * the typical query.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL,
 * LLM_API_KEY, OLLAMA_EMBEDDING_MODEL, LLM_MODEL.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL  = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';

const THRESHOLDS = {
  prod_current:  { floor: 0.50, gm: 0.55, label: 'prod (current)' },
  prod_proposed: { floor: 0.40, gm: 0.45, label: 'proposed' },
};

const MATCH_THRESHOLD = 0.40;
const MATCH_COUNT_DIST = 50;
// Production multi-vector applies a 0.45 floor per facet — papers below get
// facetSimilarities[label] = 0 (per searchLocalCorpusMulti). Match that here
// so probe results are faithful to what the live classifier sees.
const PER_FACET_FLOOR = 0.45;

// LAC regex — for geography hit detection, mirrors directIndirectClassifier.ts
const LAC_TERMS = [
  'latin america', 'latin american', 'america latina', 'américa latina', 'latam', 'lac',
  'caribbean', 'caribe', 'south america', 'central america', 'mesoamerica',
  'argentina', 'bolivia', 'brazil', 'brasil', 'chile', 'colombia', 'costa rica',
  'cuba', 'dominican republic', 'ecuador', 'el salvador', 'guatemala', 'haiti',
  'honduras', 'jamaica', 'mexico', 'méxico', 'nicaragua', 'panama', 'paraguay',
  'peru', 'perú', 'uruguay', 'venezuela',
];
function foldAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const LAC_REGEX = new RegExp(`\\b(${LAC_TERMS.map(t => foldAccents(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

// ----------------------------------------------------------------------------
// System prompt — mirror of supabase/functions/_shared/queryFacets.ts
// ----------------------------------------------------------------------------
const DECOMPOSE_SYSTEM_PROMPT = `You decompose policy/economics research queries into 2–4 conceptual FACETS for a faceted retrieval system.

Each facet represents one independent thing the user is asking about. ORDER MATTERS — the FIRST facet must be the user's primary subject (the intervention, technology, or core topic). Geography is almost never primary and should appear LAST.

For each facet output 10–22 synonyms / near-synonyms / lay terms / sub-types that academic papers in that subfield use. Include literature vocabulary, not just rephrasings of the user's words.

When the query mentions LAC, include Spanish (and Portuguese for Brazil) terms. Extract a "geography" facet ONLY when the query mentions a region/country.

Output strict JSON:
{
  "facets": [
    { "label": "<short label>", "expansion": ["term1", "term2", ...] }
  ]
}

Labels lowercase. Terms lowercase. No duplicates.`;

// ----------------------------------------------------------------------------
// LLM calls
// ----------------------------------------------------------------------------

async function qwenJson(query) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
        { role: 'user',   content: query },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content ?? '';
  try { return JSON.parse(txt); }
  catch { console.warn('  qwen JSON parse failed:', txt.slice(0, 150)); return { facets: [] }; }
}

async function embedBatch(texts, prefix = 'search_query: ') {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map(t => prefix + t) }),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed fail: ' + JSON.stringify(j).slice(0, 150));
  return j.data.map(d => d.embedding);
}

// ----------------------------------------------------------------------------
// Geometry
// ----------------------------------------------------------------------------

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
}

function geometricMean(values) {
  if (!values.length) return 0;
  const safe = values.map(v => Math.max(v, 1e-6));
  const sumLog = safe.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(sumLog / safe.length);
}

// Mirror of classifyOne. Inputs: per-facet sims map, geography hit bool,
// required topic facets list, thresholds.
function classify(facetSims, requiredFacets, geographyMatched, thresholds) {
  const requiredScores = requiredFacets.map(f => facetSims[f] ?? 0);
  if (requiredScores.length === 0) {
    // Fallback path: use top sim as proxy
    return { classification: 'excluded', gmRequired: 0 };
  }
  const gm = geometricMean(requiredScores);
  const allClear = requiredScores.every(s => s >= thresholds.floor);
  const anyClear = requiredScores.some(s => s >= thresholds.floor);
  let cls;
  if (allClear && gm >= thresholds.gm) cls = geographyMatched ? 'direct-lac' : 'direct-global';
  else if (anyClear)                    cls = 'indirect';
  else                                  cls = 'excluded';
  return { classification: cls, gmRequired: gm };
}

function geographyHit(title, abstract) {
  const hay = foldAccents(`${title ?? ''} ${abstract ?? ''}`.toLowerCase());
  return LAC_REGEX.test(hay);
}

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }

// ----------------------------------------------------------------------------
// Labeled-paper classifier-vs-label test (q01-q03)
// ----------------------------------------------------------------------------

async function classifyLabeledPapers(query) {
  const labels = query.labels ?? {};
  const labeledDois = Object.values(labels).filter(e => e.doi).map(e => ({ doi: normDoi(e.doi), label: e.label, design: e.design_rank, title: e.title }));
  if (labeledDois.length === 0) return null;

  console.log(`▸ ${query.id} — ${labeledDois.length} labeled papers`);

  const facets = await qwenJson(query.query);
  const topicFacets = (facets.facets ?? []).filter(f => !/^(geo|geography|region|location|country|countries|place)$/i.test(f.label));
  if (topicFacets.length === 0) { console.warn('  no topic facets'); return null; }
  console.log(`  facets: ${topicFacets.map(f => `${f.label}(${f.expansion?.length ?? 0}t)`).join(', ')}`);

  // Embed each topic facet exactly the way production does:
  //   text = "<label> <first-12-expansion-terms joined by space>"
  // (see retrieval.ts:580 — facetInputs.text format)
  const facetTexts = topicFacets.map(f => `${f.label} ${(f.expansion ?? []).slice(0, 12).join(' ')}`);
  const facetVecs = await embedBatch(facetTexts);

  // Fetch the labeled papers' rows + embeddings
  const { data: rows } = await SB.from('works')
    .select('id, canonical_doi, title, abstract, year, embedding')
    .in('canonical_doi', labeledDois.map(l => l.doi));
  const rowByDoi = new Map((rows ?? []).map(r => [normDoi(r.canonical_doi), r]));

  // For each labeled paper, compute per-facet sim and classify
  const results = [];
  for (const lp of labeledDois) {
    const row = rowByDoi.get(lp.doi);
    if (!row) { results.push({ ...lp, found: false }); continue; }
    const emb = parseEmbedding(row.embedding);
    if (!emb) { results.push({ ...lp, found: true, reason: 'no_embedding' }); continue; }

    const simsRaw = {};
    const sims = {};   // production-faithful: clipped to 0 below PER_FACET_FLOOR
    for (let i = 0; i < topicFacets.length; i++) {
      const c = cosine(facetVecs[i], emb);
      simsRaw[topicFacets[i].label] = c;
      sims[topicFacets[i].label] = (c == null || c < PER_FACET_FLOOR) ? 0 : c;
    }
    const geo = geographyHit(row.title, row.abstract);
    const requiredFacetLabels = topicFacets.map(f => f.label);

    const cls_cur  = classify(sims, requiredFacetLabels, geo, THRESHOLDS.prod_current);
    const cls_prop = classify(sims, requiredFacetLabels, geo, THRESHOLDS.prod_proposed);

    results.push({
      ...lp, found: true, year: row.year, title: row.title ?? lp.title,
      facetSimsRaw: simsRaw, facetSims: sims, geographyHit: geo,
      classification_current: cls_cur.classification,
      gm_current: cls_cur.gmRequired,
      classification_proposed: cls_prop.classification,
      gm_proposed: cls_prop.gmRequired,
    });
  }
  return { query, topicFacets, results };
}

// ----------------------------------------------------------------------------
// Distribution test (all 23 queries — top-50 from match_works_v2)
// ----------------------------------------------------------------------------

async function distributionOnTopN(query, vec, expanded) {
  const { data, error } = await SB.rpc('match_works_v2', {
    query_embedding: vec, query_text: expanded,
    match_threshold: MATCH_THRESHOLD, match_count: MATCH_COUNT_DIST,
    filter_min_year: 2010, filter_sms_min: 2,
  });
  if (error) return { error: error.message };

  const papers = data ?? [];
  if (papers.length === 0) return { dist_current: {}, dist_proposed: {}, n: 0 };

  // Decompose + embed facets for this query
  const facets = await qwenJson(query.query);
  const topicFacets = (facets.facets ?? []).filter(f => !/^(geo|geography|region|location|country|countries|place)$/i.test(f.label));
  if (topicFacets.length === 0) return { dist_current: {}, dist_proposed: {}, n: papers.length, reason: 'no_facets' };

  const facetTexts = topicFacets.map(f => `${f.label} ${(f.expansion ?? []).slice(0, 12).join(' ')}`);
  const facetVecs = await embedBatch(facetTexts);

  // For each paper, fetch its stored embedding and compute per-facet sim
  const ids = papers.map(p => p.id);
  const { data: rows } = await SB.from('works').select('id, embedding').in('id', ids);
  const embByPaperId = new Map((rows ?? []).map(r => [r.id, parseEmbedding(r.embedding)]));

  const requiredFacetLabels = topicFacets.map(f => f.label);
  const dist_current = { 'direct-lac': 0, 'direct-global': 0, indirect: 0, excluded: 0, no_embed: 0 };
  const dist_proposed = { 'direct-lac': 0, 'direct-global': 0, indirect: 0, excluded: 0, no_embed: 0 };

  for (const p of papers) {
    const emb = embByPaperId.get(p.id);
    if (!emb) { dist_current.no_embed++; dist_proposed.no_embed++; continue; }
    const sims = {};
    for (let i = 0; i < topicFacets.length; i++) {
      const c = cosine(facetVecs[i], emb);
      sims[topicFacets[i].label] = (c == null || c < PER_FACET_FLOOR) ? 0 : c;
    }
    const geo = geographyHit(p.title, p.abstract);
    const c1 = classify(sims, requiredFacetLabels, geo, THRESHOLDS.prod_current);
    const c2 = classify(sims, requiredFacetLabels, geo, THRESHOLDS.prod_proposed);
    dist_current[c1.classification]++;
    dist_proposed[c2.classification]++;
  }
  return { dist_current, dist_proposed, n: papers.length, facets: topicFacets.map(f => f.label) };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function fmt(n) { return n == null ? '—' : (Number.isInteger(n) ? `${n}` : n.toFixed(3)); }
function trimTitle(t, n = 50) { return !t ? '—' : (t.length > n ? t.slice(0, n - 1) + '…' : t); }

async function main() {
  if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

  // PART 1: Labeled-paper test (q01-q03)
  console.log(`\n=== Part 1: Labeled-paper classifier vs human label (q01-q03) ===\n`);
  const labeledQueries = evals.queries.filter(q => Object.keys(q.labels ?? {}).length > 0);
  const labeledResults = [];
  for (const q of labeledQueries) {
    const r = await classifyLabeledPapers(q);
    if (r) labeledResults.push(r);
  }

  // Cross-tab per threshold config
  const crosstab = (results, key) => {
    const xtab = {};
    for (const lr of results) {
      for (const r of lr.results) {
        if (!r.found || !r[key]) continue;
        const label = r.label;
        const cls = r[key];
        xtab[label] = xtab[label] ?? {};
        xtab[label][cls] = (xtab[label][cls] ?? 0) + 1;
      }
    }
    return xtab;
  };
  const xtab_current  = crosstab(labeledResults, 'classification_current');
  const xtab_proposed = crosstab(labeledResults, 'classification_proposed');

  // PART 2: Distribution test (all 23 queries)
  console.log(`\n=== Part 2: Distribution sanity check on all 23 queries top-50 ===\n`);
  const distResults = [];
  for (const q of evals.queries) {
    process.stdout.write(`▸ ${q.id.padEnd(48)} `);
    const [vec] = await embedBatch([q.query]);
    const dist = await distributionOnTopN(q, vec, q.query);
    if (dist.error) { console.log(`err: ${dist.error}`); continue; }
    const c = dist.dist_current;
    const p = dist.dist_proposed;
    console.log(`cur direct=${(c['direct-lac']??0)+(c['direct-global']??0)} ind=${c.indirect??0} exc=${c.excluded??0}  |  prop direct=${(p['direct-lac']??0)+(p['direct-global']??0)} ind=${p.indirect??0} exc=${p.excluded??0}`);
    distResults.push({ id: q.id, class: q.retrieval_class ?? null, ...dist });
  }

  // ----------------------------------------------------------------------------
  // Report
  // ----------------------------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  const md = [];
  md.push(`# Direct/Indirect classifier evaluation — ${date}`);
  md.push('');
  md.push(`Two tests:`);
  md.push(`1. **Labeled agreement** (q01-q03): does the classifier agree with human labels (relevant→direct, partial→indirect, irrelevant→excluded)?`);
  md.push(`2. **Distribution sanity** (all 23): for top-50 papers from match_works_v2 with prod filters, what's the direct/indirect/excluded split?`);
  md.push('');
  md.push(`Thresholds compared:`);
  md.push(`- **prod current**: floor 0.50, gm 0.55`);
  md.push(`- **proposed** (per fix/classifier-thresholds-tuning branch): floor 0.40, gm 0.45`);
  md.push('');

  // Part 1 cross-tabs
  md.push(`## Part 1 — Labeled agreement`);
  md.push('');
  for (const [name, xtab] of [['Current (0.50/0.55)', xtab_current], ['Proposed (0.40/0.45)', xtab_proposed]]) {
    md.push(`### Threshold config: ${name}`);
    md.push('');
    md.push(`| Human label \\ Classifier | direct-lac | direct-global | indirect | excluded | Σ |`);
    md.push(`|---|---:|---:|---:|---:|---:|`);
    for (const lbl of ['relevant', 'partial', 'irrelevant']) {
      const row = xtab[lbl] ?? {};
      const sum = (row['direct-lac']??0) + (row['direct-global']??0) + (row.indirect??0) + (row.excluded??0);
      md.push(`| ${lbl} | ${row['direct-lac']??0} | ${row['direct-global']??0} | ${row.indirect??0} | ${row.excluded??0} | ${sum} |`);
    }
    md.push('');
    // Agreement scores: rough "did classifier put it in the bucket we expected?"
    const dCount = (row, target) => target === 'direct'
      ? (row['direct-lac']??0) + (row['direct-global']??0)
      : (row[target] ?? 0);
    const acc = ['relevant', 'partial', 'irrelevant'].map(lbl => {
      const row = xtab[lbl] ?? {};
      const expected = lbl === 'relevant' ? 'direct' : (lbl === 'partial' ? 'indirect' : 'excluded');
      const hit = dCount(row, expected);
      const total = (row['direct-lac']??0)+(row['direct-global']??0)+(row.indirect??0)+(row.excluded??0);
      return { lbl, expected, hit, total, acc: total ? hit / total : null };
    });
    md.push(`Per-label agreement (label → expected bucket):`);
    for (const a of acc) {
      md.push(`- ${a.lbl} → ${a.expected}: **${a.hit}/${a.total}** (${a.acc != null ? (a.acc*100).toFixed(0)+'%' : '—'})`);
    }
    md.push('');
  }

  // Per-paper detail for the labeled set (so we can see misclassifications)
  md.push(`### Per-paper detail`);
  md.push('');
  for (const lr of labeledResults) {
    md.push(`#### ${lr.query.id} — facets: ${lr.topicFacets.map(f => f.label).join(', ')}`);
    md.push('');
    md.push(`| Title | Label | sim/facet | geo | gm cur | class cur | gm prop | class prop |`);
    md.push(`|---|---|---|---:|---:|---|---:|---|`);
    for (const r of lr.results) {
      if (!r.found) { md.push(`| ${trimTitle(r.title)} | ${r.label} | — | — | — | not_in_corpus | — | — |`); continue; }
      if (r.reason) { md.push(`| ${trimTitle(r.title)} | ${r.label} | — | — | — | ${r.reason} | — | — |`); continue; }
      const sims = Object.entries(r.facetSims).map(([k, v]) => `${k}:${fmt(v)}`).join(' ');
      md.push(`| ${trimTitle(r.title)} | ${r.label} | ${sims} | ${r.geographyHit ? '✓' : '·'} | ${fmt(r.gm_current)} | ${r.classification_current} | ${fmt(r.gm_proposed)} | ${r.classification_proposed} |`);
    }
    md.push('');
  }

  // Part 2: distribution
  md.push(`## Part 2 — Distribution across top-50 (all 23 queries)`);
  md.push('');
  md.push(`| Query | Class | Facets | n | cur: D-lac/D-glob/Ind/Exc | prop: D-lac/D-glob/Ind/Exc |`);
  md.push(`|---|---|---|---:|---|---|`);
  for (const r of distResults) {
    const c = r.dist_current;
    const p = r.dist_proposed;
    const cs = `${c['direct-lac']??0}/${c['direct-global']??0}/${c.indirect??0}/${c.excluded??0}`;
    const ps = `${p['direct-lac']??0}/${p['direct-global']??0}/${p.indirect??0}/${p.excluded??0}`;
    md.push(`| ${r.id} | ${r.class ?? '—'} | ${(r.facets ?? []).join(',')} | ${r.n ?? 0} | ${cs} | ${ps} |`);
  }
  md.push('');

  // Aggregate counts
  const totals = { cur: { dlac:0, dgb:0, ind:0, exc:0, ne:0 }, prop: { dlac:0, dgb:0, ind:0, exc:0, ne:0 } };
  for (const r of distResults) {
    totals.cur.dlac += r.dist_current['direct-lac']??0;
    totals.cur.dgb  += r.dist_current['direct-global']??0;
    totals.cur.ind  += r.dist_current.indirect??0;
    totals.cur.exc  += r.dist_current.excluded??0;
    totals.cur.ne   += r.dist_current.no_embed??0;
    totals.prop.dlac += r.dist_proposed['direct-lac']??0;
    totals.prop.dgb  += r.dist_proposed['direct-global']??0;
    totals.prop.ind  += r.dist_proposed.indirect??0;
    totals.prop.exc  += r.dist_proposed.excluded??0;
    totals.prop.ne   += r.dist_proposed.no_embed??0;
  }
  const sumCur = totals.cur.dlac+totals.cur.dgb+totals.cur.ind+totals.cur.exc;
  const sumProp = totals.prop.dlac+totals.prop.dgb+totals.prop.ind+totals.prop.exc;
  md.push(`### Aggregate across all 23 queries (totals)`);
  md.push('');
  md.push(`| Config | direct-lac | direct-global | indirect | excluded | no_embed | Σ |`);
  md.push(`|---|---:|---:|---:|---:|---:|---:|`);
  md.push(`| current  | ${totals.cur.dlac} (${(totals.cur.dlac/sumCur*100).toFixed(0)}%) | ${totals.cur.dgb} (${(totals.cur.dgb/sumCur*100).toFixed(0)}%) | ${totals.cur.ind} (${(totals.cur.ind/sumCur*100).toFixed(0)}%) | ${totals.cur.exc} (${(totals.cur.exc/sumCur*100).toFixed(0)}%) | ${totals.cur.ne} | ${sumCur} |`);
  md.push(`| proposed | ${totals.prop.dlac} (${(totals.prop.dlac/sumProp*100).toFixed(0)}%) | ${totals.prop.dgb} (${(totals.prop.dgb/sumProp*100).toFixed(0)}%) | ${totals.prop.ind} (${(totals.prop.ind/sumProp*100).toFixed(0)}%) | ${totals.prop.exc} (${(totals.prop.exc/sumProp*100).toFixed(0)}%) | ${totals.prop.ne} | ${sumProp} |`);
  md.push('');

  writeFileSync(join(__dir, `../reports/direct-indirect-eval-${date}.md`), md.join('\n') + '\n');
  writeFileSync(join(__dir, `../reports/direct-indirect-eval-${date}.json`),
                JSON.stringify({ runAt: new Date().toISOString(), thresholds: THRESHOLDS, labeledResults, distResults, totals }, null, 2));

  console.log(`\n\nWrote reports/direct-indirect-eval-${date}.md\n`);
  console.log(`Aggregate distribution (all 23 queries × top-50):`);
  console.log(`  current  : D-lac=${totals.cur.dlac}  D-glob=${totals.cur.dgb}  Indirect=${totals.cur.ind}  Excluded=${totals.cur.exc}`);
  console.log(`  proposed : D-lac=${totals.prop.dlac}  D-glob=${totals.prop.dgb}  Indirect=${totals.prop.ind}  Excluded=${totals.prop.exc}`);
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });
