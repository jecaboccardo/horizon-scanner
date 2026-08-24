/**
 * build-classifier-training-set.mjs
 *
 * Build feature × label training data for a small ML classifier that can
 * approximate the LLM-judge at <1ms per paper. Used as either a fallback for
 * LLM-judge timeouts or a cheaper pre-filter.
 *
 * For each labeled paper in evals/queries.json (459 papers across 23 queries),
 * compute:
 *
 *   Per-facet semantic sims (3 facets max, padded with 0 if fewer)
 *     - cosine(query_facet_embedding, paper_embedding)
 *     - clipped to 0 below the 0.45 prod per-facet floor (production-faithful)
 *   geographyHit (0/1) — literal LAC regex on title+abstract
 *   single_vector_sim (cosine of full query vs paper)
 *   year, citation_count, age_years, citation_rate (= citations / max(1, age))
 *   sms_level (0..5, null → 0)
 *   has_abstract (0/1), abstract_length
 *   abs_rating_numeric (1, 2, 3, 4, 4* → 1,2,3,4,5; null → 0)
 *   repec_percentile (0..1, null → 0.5)
 *
 * Target columns:
 *   label_human    — relevant / partial / irrelevant (Jess's labels)
 *   label_human_3  — int 2 / 1 / 0 (for sklearn)
 *
 * Output: evals/classifier-training-set-YYYY-MM-DD.csv
 * Plus: evals/classifier-features-meta-YYYY-MM-DD.json (feature column order
 * and any per-query facet metadata, so the Python trainer reproduces).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
// --labels path overrides evals/queries.json. Used after running
// scripts/export-classifier-training-labels.mjs to feed the trainer with
// the merged human + auto-collected label set.
function resolveLabelsPath() {
  const i = process.argv.indexOf('--labels');
  if (i >= 0 && i < process.argv.length - 1) return process.argv[i + 1];
  return join(__dir, '..', 'evals', 'queries.json');
}
const QUERIES_PATH = resolveLabelsPath();

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';

const PER_FACET_FLOOR = 0.35; // qwen-768: facet cosines ~0.15 below nomic (was 0.45). Must match trainedClassifier.featureVector at inference.
const MAX_FACETS = 3;             // pad shorter sets with 0s for fixed feature shape
const CURRENT_YEAR = new Date().getUTCFullYear();

const LAC_TERMS = [
  'latin america', 'latin american', 'america latina', 'latinoamerica', 'latam', 'lac',
  'caribbean', 'caribe', 'south america', 'central america', 'mesoamerica',
  'argentina', 'bolivia', 'brazil', 'brasil', 'chile', 'colombia', 'costa rica', 'cuba',
  'dominican republic', 'ecuador', 'el salvador', 'guatemala', 'haiti', 'honduras',
  'jamaica', 'mexico', 'nicaragua', 'panama', 'paraguay', 'peru', 'uruguay', 'venezuela',
];
function foldAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const LAC_REGEX = new RegExp(`\\b(${LAC_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

// Decompose system prompt — same as queryFacets.ts
const DECOMPOSE_SYSTEM_PROMPT = `You decompose policy/economics research queries into 2–4 conceptual FACETS for a faceted retrieval system.

Each facet represents one independent thing the user is asking about. ORDER MATTERS — the FIRST facet must be the user's primary subject. Geography is almost never primary and should appear LAST.

For each facet output 10–22 synonyms / near-synonyms / lay terms / sub-types that academic papers in that subfield use. Include literature vocabulary, not just rephrasings of the user's words.

Output strict JSON: {"facets": [{"label": "<short label>", "expansion": ["term1", ...]}]}`;

async function qwenJson(query) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'system', content: DECOMPOSE_SYSTEM_PROMPT }, { role: 'user', content: query }],
      temperature: 0.1, response_format: { type: 'json_object' },
    }),
  });
  const j = await r.json();
  try { return JSON.parse(j.choices?.[0]?.message?.content ?? '{}'); }
  catch { return { facets: [] }; }
}

// Match the PROD embed path (ollamaClient): task prefixes are nomic-only — qwen
// needs none, and qwen (MRL) MUST request dimensions=768 to match the 768-d
// `embedding` column (else 4096-dim → cosine length-mismatch → null sims). Without
// this the qwen features are wrong and the retrained RF learns garbage.
const FEAT_IS_NOMIC = /nomic/i.test(EMBED_MODEL);
const FEAT_EMBED_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;
async function embedBatch(texts, prefix = 'search_query: ') {
  const pfx = FEAT_IS_NOMIC ? prefix : '';
  const body = { model: EMBED_MODEL, input: texts.map(t => pfx + t) };
  if (FEAT_EMBED_DIMS) body.dimensions = FEAT_EMBED_DIMS;
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed fail: ' + JSON.stringify(j).slice(0, 150));
  return j.data.map(d => d.embedding);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
}
function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }

function absRatingNumeric(r) {
  if (!r) return 0;
  const s = String(r).trim();
  if (s === '4*' || s === '4S' || s === '4s') return 5;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 4) : 0;
}

function labelToInt(lbl) { return lbl === 'relevant' ? 2 : lbl === 'partial' ? 1 : 0; }

async function main() {
  if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const labeledQueries = evals.queries.filter(q => Object.keys(q.labels ?? {}).length > 0);
  console.log(`\nBuilding training set: ${labeledQueries.length} queries, ` +
              `${labeledQueries.reduce((s, q) => s + Object.keys(q.labels).length, 0)} total labels\n`);

  // Embed each query (single vector) AND decompose into facets + embed
  const queryFeatures = new Map();
  for (const q of labeledQueries) {
    process.stdout.write(`  ${q.id.padEnd(45)} `);
    const [qVec] = await embedBatch([q.query]);
    const facets = await qwenJson(q.query);
    const topicFacets = (facets.facets ?? [])
      .filter(f => !/^(geo|geography|region|location|country|countries|place)$/i.test(f.label))
      .slice(0, MAX_FACETS);
    const facetTexts = topicFacets.map(f => `${f.label} ${(f.expansion ?? []).slice(0, 12).join(' ')}`);
    const facetVecs = facetTexts.length ? await embedBatch(facetTexts) : [];
    queryFeatures.set(q.id, { queryVec: qVec, facets: topicFacets, facetVecs });
    console.log(`facets=${topicFacets.length}  (${topicFacets.map(f => f.label).join(', ')})`);
  }

  // Build training rows
  const rows = [];
  const FEATURES = [
    'facet_sim_0', 'facet_sim_1', 'facet_sim_2',
    'facet_sim_0_above_floor', 'facet_sim_1_above_floor', 'facet_sim_2_above_floor',
    'facet_sims_geometric_mean',
    'single_vector_sim',
    'geography_hit',
    // 2026-06-10: two new features from the stored geography[] column.
    // geography_stored_lac  = 1 if works.geography contains a LAC country/region.
    // geography_stored_none = 1 if works.geography is populated but has no entries
    //   (meaning the classifier ran and found no specific geography — i.e. global/
    //   theory paper). Distinct from geography[] IS NULL (classifier never ran).
    // These help the RF distinguish "paper about India that mentions LAC in passing"
    // (geography_hit=1, geography_stored_lac=0) from a genuine LAC paper.
    'geography_stored_lac',
    'geography_stored_none',
    'year', 'age_years', 'citation_count', 'citation_rate',
    'sms_level', 'has_abstract', 'abstract_length',
    'abs_rating_numeric', 'repec_percentile',
  ];

  for (const q of labeledQueries) {
    const { queryVec, facets, facetVecs } = queryFeatures.get(q.id);
    const labelEntries = Object.values(q.labels);
    const dois = labelEntries.map(l => normDoi(l.doi)).filter(Boolean);

    // Batch DB lookup
    const allRows = [];
    const BATCH = 50;
    for (let i = 0; i < dois.length; i += BATCH) {
      const { data } = await SB.from('works')
        .select('canonical_doi, title, abstract, year, citation_count, sms_level, abs_rating, repec_percentile, embedding, geography')
        .in('canonical_doi', dois.slice(i, i + BATCH));
      allRows.push(...(data ?? []));
    }
    const byDoi = new Map(allRows.map(r => [normDoi(r.canonical_doi), r]));

    let added = 0, missing = 0;
    for (const lbl of labelEntries) {
      const doi = normDoi(lbl.doi);
      const row = byDoi.get(doi);
      if (!row) { missing++; continue; }
      const emb = parseEmbedding(row.embedding);
      if (!emb) { missing++; continue; }

      const fSims = [];
      const fAbove = [];
      for (let i = 0; i < MAX_FACETS; i++) {
        if (i < facetVecs.length) {
          const c = cosine(facetVecs[i], emb);
          const clipped = (c == null || c < PER_FACET_FLOOR) ? 0 : c;
          fSims.push(c == null ? 0 : c);
          fAbove.push(clipped > 0 ? 1 : 0);
        } else {
          fSims.push(0);
          fAbove.push(0);
        }
      }
      const fAboveSum = fAbove.reduce((s, x) => s + x, 0);
      const gm = fAboveSum > 0
        ? Math.exp(fSims.filter((_, i) => fAbove[i]).reduce((s, v) => s + Math.log(Math.max(v, 1e-6)), 0) / fAboveSum)
        : 0;
      const sv = cosine(queryVec, emb) ?? 0;
      const hay = foldAccents(`${row.title ?? ''} ${String(row.abstract ?? '').slice(0, 300)}`.toLowerCase());
      const geo = LAC_REGEX.test(hay) ? 1 : 0;
      // Stored geography features (new 2026-06-10)
      const storedGeo = Array.isArray(row.geography) ? row.geography : null;
      const geoStoredLac = storedGeo !== null && LAC_REGEX.test(foldAccents(storedGeo.join(' ').toLowerCase())) ? 1 : 0;
      // geography_stored_none = 1 when geography classifier ran (storedGeo is array)
      // but found no entries (global/theory paper). Null means classifier never ran.
      const geoStoredNone = storedGeo !== null && storedGeo.length === 0 ? 1 : 0;
      const year = Number(row.year ?? 0) || null;
      const age = year ? Math.max(0, CURRENT_YEAR - year) : null;
      const cites = Number(row.citation_count ?? 0) || 0;
      const rate = age != null ? cites / Math.max(1, age + 1) : 0;
      const abstr = String(row.abstract ?? '');

      rows.push({
        qid: q.id,
        doi,
        title: row.title ?? '',
        facet_sim_0: fSims[0], facet_sim_1: fSims[1], facet_sim_2: fSims[2],
        facet_sim_0_above_floor: fAbove[0], facet_sim_1_above_floor: fAbove[1], facet_sim_2_above_floor: fAbove[2],
        facet_sims_geometric_mean: gm,
        single_vector_sim: sv,
        geography_hit: geo,
        geography_stored_lac: geoStoredLac,
        geography_stored_none: geoStoredNone,
        year: year ?? 0, age_years: age ?? 0,
        citation_count: cites, citation_rate: rate,
        sms_level: Number(row.sms_level ?? 0) || 0,
        has_abstract: abstr.length > 0 ? 1 : 0, abstract_length: abstr.length,
        abs_rating_numeric: absRatingNumeric(row.abs_rating),
        repec_percentile: Number(row.repec_percentile ?? 50) / 100,
        label: lbl.label,
        label_int: labelToInt(lbl.label),
      });
      added++;
    }
    console.log(`  ${q.id.padEnd(45)} +${added} rows  (missing: ${missing})`);
  }

  console.log(`\nTotal rows: ${rows.length}`);
  const labelDist = rows.reduce((d, r) => { d[r.label] = (d[r.label] ?? 0) + 1; return d; }, {});
  console.log('Label dist:', labelDist);

  // Write CSV + meta
  const date = new Date().toISOString().slice(0, 10);
  const cols = ['qid', 'doi', 'title', ...FEATURES, 'label', 'label_int'];
  const csvLines = [cols.join(',')];
  for (const r of rows) {
    csvLines.push(cols.map(c => {
      const v = r[c];
      if (v == null) return '';
      const s = typeof v === 'number' ? v.toFixed(4).replace(/\.?0+$/, '') : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  const csvPath = join(__dir, '..', 'evals', `classifier-training-set-${date}.csv`);
  const metaPath = join(__dir, '..', 'evals', `classifier-features-meta-${date}.json`);
  writeFileSync(csvPath, csvLines.join('\n') + '\n');
  writeFileSync(metaPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    features: FEATURES,
    target: 'label_int',
    targetMap: { 0: 'irrelevant', 1: 'partial', 2: 'relevant' },
    perQueryFacets: Object.fromEntries([...queryFeatures.entries()].map(([qid, v]) => [qid, v.facets.map(f => f.label)])),
    PER_FACET_FLOOR, MAX_FACETS, currentYear: CURRENT_YEAR,
  }, null, 2));

  console.log(`\nWrote ${csvPath} (${rows.length} rows × ${FEATURES.length} features)`);
  console.log(`Wrote ${metaPath}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
