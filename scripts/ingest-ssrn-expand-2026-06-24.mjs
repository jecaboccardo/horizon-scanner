#!/usr/bin/env node
/**
 * Targeted SSRN corpus expansion (Camino 1 + 2, 2026-06-24).
 *
 * SSRN is NOT in OpenAlex and Crossref carries no SSRN abstracts, so:
 *   - DISCOVERY uses Crossref (prefix 10.2139): the xlsx curated list (Camino 1) +
 *     topical search restricted to SCL-relevant topics, title-gated (Camino 2).
 *   - ABSTRACTS are filled afterward by scripts/backfill-abstracts-ssrn-cdp.mjs
 *     (it auto-targets any canonical SSRN row with a NULL abstract — including these).
 *
 * This script INSERTS new rows only (ids not already in corpus) — it never touches
 * existing rows (golden rule: no clobber). Embeds title(+abstract) with the SAME
 * settings the corpus was built with (qwen3 768-dim, 'search_document: ' prefix).
 * SMS + geography are left for a later off-peak backfill (deterministic, gap-only).
 *
 * Usage:
 *   node --env-file=.env scripts/ingest-ssrn-expand-2026-06-24.mjs --dry-run
 *   node --env-file=.env scripts/ingest-ssrn-expand-2026-06-24.mjs --camino both
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const M = process.env.OPENALEX_MAILTO || 'horizon-scanner@iadb.org';
const DRY_RUN = process.argv.includes('--dry-run');
const CAMINO = (() => { const i = process.argv.indexOf('--camino'); return i >= 0 ? process.argv[i + 1] : 'both'; })();
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY || '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b-app';
const MODEL_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;

const normDoi = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STUB = /^see abstract at|^abstract available|available at:|^https?:\/\//i;
const authorsOf = it => (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ').trim()).filter(Boolean);

const TOPICS = [
  'cash transfer', 'conditional cash transfer', 'early childhood development', 'education learning developing countries',
  'school dropout', 'teacher incentives', 'labor informality', 'female labor force participation',
  'health insurance developing countries', 'social protection', 'poverty Latin America', 'remittances migration',
  'microfinance', 'vocational training', 'child labor', 'maternal health', 'pension reform', 'minimum wage developing',
  'financial inclusion', 'social safety net',
];

async function crossrefTopic(q, rowsN = 100) {
  const url = `https://api.crossref.org/prefixes/10.2139/works?query=${encodeURIComponent(q)}&rows=${rowsN}&select=DOI,title,published,author,container-title&mailto=${M}`;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) return []; return (await r.json()).message?.items || []; }
  catch { return []; }
}
async function crossrefByDoi(doi) {
  try { const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${M}`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) return null; return (await r.json()).message; }
  catch { return null; }
}

// ---------- build candidate map: doi -> {title, year, authors, venue, abstract} ----------
const cand = new Map();
if (CAMINO === '1' || CAMINO === 'both') {
  const c1 = JSON.parse(fs.readFileSync('reports/_ssrn-c1-candidates.json', 'utf8'));
  for (const r of c1) cand.set(r.doi, { title: r.title, year: r.year ? parseInt(r.year) : null, authors: [], venue: r.venue || 'SSRN Electronic Journal', abstract: r.abstract || null, _src: 'xlsx' });
  console.log(`Camino 1: ${c1.length} candidates from xlsx`);
}
if (CAMINO === '2' || CAMINO === 'both') {
  let n = 0;
  for (const q of TOPICS) {
    const items = await crossrefTopic(q, 100);
    for (const it of items) {
      const doi = normDoi(it.DOI);
      const title = (it.title || [])[0] || '';
      const year = it.published?.['date-parts']?.[0]?.[0] || null;
      const words = q.split(' ').filter(w => w.length > 4);
      if (!title || !words.some(w => title.toLowerCase().includes(w))) continue; // title-gate
      if (year && year < 2010) continue;
      if (cand.has(doi)) continue;
      cand.set(doi, { title, year, authors: authorsOf(it), venue: (it['container-title'] || [])[0] || 'SSRN Electronic Journal', abstract: null, _src: 'crossref' });
      n++;
    }
    await sleep(300);
  }
  console.log(`Camino 2: ${n} title-gated candidates from Crossref (${TOPICS.length} topics)`);
}

// ---------- dedup vs corpus ----------
const dois = [...cand.keys()];
const existing = new Set();
for (const b of chunk(dois, 150)) {
  const { data } = await sb.from('works').select('id').in('id', b);
  for (const row of data || []) existing.add(row.id.toLowerCase());
}
const newDois = dois.filter(d => !existing.has(d));
console.log(`\nTotal unique candidates: ${dois.length} | already in corpus: ${existing.size} | NEW to ingest: ${newDois.length}`);

// ---------- enrich xlsx candidates lacking authors (Crossref per-DOI) ----------
let enriched = 0;
for (const d of newDois) {
  const c = cand.get(d);
  if (c.authors.length === 0) {
    const m = await crossrefByDoi(d);
    if (m) {
      c.authors = authorsOf(m);
      if (!c.title) c.title = (m.title || [])[0] || c.title;
      if (!c.year) c.year = m.published?.['date-parts']?.[0]?.[0] || m.issued?.['date-parts']?.[0]?.[0] || null;
      enriched++;
    }
    await sleep(120);
  }
}
console.log(`Enriched authors via Crossref for ${enriched} candidates`);

if (DRY_RUN) {
  console.log(`\n[dry-run] would ingest ${newDois.length} new SSRN rows. Sample:`);
  for (const d of newDois.slice(0, 10)) { const c = cand.get(d); console.log(`  ${d} | ${c.year} | ${(c.title || '').slice(0, 60)} | authors=${c.authors.length} | abs=${c.abstract ? 'yes' : 'no'}`); }
  process.exit(0);
}

// ---------- embed (qwen 768, search_document prefix) ----------
async function embedBatch(texts) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, ...(MODEL_DIMS ? { dimensions: MODEL_DIMS } : {}), input: texts, keep_alive: '30m' }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (e) { if (attempt === 4) throw e; await sleep(attempt * 1500); }
  }
}

let ingested = 0, embedFail = 0, upsertFail = 0;
const ingestedIds = [];
const now = new Date().toISOString();
for (const batch of chunk(newDois, 20)) {
  const texts = batch.map(d => { const c = cand.get(d); return `search_document: ${[c.title, c.abstract].filter(Boolean).join(' ').slice(0, 8000)}`; });
  let vecs;
  try { vecs = await embedBatch(texts); } catch { embedFail += batch.length; continue; }
  const rows = [];
  for (let i = 0; i < batch.length; i++) {
    const d = batch[i]; const c = cand.get(d); const vec = vecs[i];
    if (!Array.isArray(vec) || (MODEL_DIMS && vec.length !== MODEL_DIMS)) { embedFail++; continue; }
    rows.push({
      id: d, title: c.title, canonical_doi: d, year: c.year || null,
      abstract: c.abstract || null, authors: c.authors || [], venue: c.venue || 'SSRN Electronic Journal',
      source: 'crossref', source_family: 'SSRN', publication_type: 'working_paper',
      is_open_access: false, open_access_pdf_url: null, citation_count: null,
      url: `https://doi.org/${d}`, fields_of_study: [], is_noise: false,
      embedding: `[${vec.join(',')}]`,
      corpus_source: 'ssrn_expand_2026_06_24', corpus_imported_at: now, updated_at: now,
    });
  }
  if (!rows.length) continue;
  const { error } = await sb.from('works').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error) { upsertFail += rows.length; console.error('\nupsert err:', error.message); continue; }
  ingested += rows.length; ingestedIds.push(...rows.map(r => r.id));
  process.stdout.write(`\r  ingested ${ingested}/${newDois.length} | embedFail ${embedFail} | upsertFail ${upsertFail}`);
  await sleep(200);
}
process.stdout.write('\n');
fs.writeFileSync('reports/ssrn-expand-ingested-ids-2026-06-24.json', JSON.stringify(ingestedIds, null, 2));
console.log(`\nDONE. ingested=${ingested} embedFail=${embedFail} upsertFail=${upsertFail}`);
console.log(`ingested ids -> reports/ssrn-expand-ingested-ids-2026-06-24.json`);
console.log(`Next: (1) run backfill-abstracts-ssrn-cdp.mjs to fill abstracts, (2) re-embed, (3) SMS + geography backfill.`);
