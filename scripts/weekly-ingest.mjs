#!/usr/bin/env node
/**
 * scripts/weekly-ingest.mjs
 *
 * Incremental "what's new" corpus ingest — runs weekly (GitHub Actions cron, Mondays
 * 09:00 UTC) or manually. Pulls recently-INDEXED papers from each configured source,
 * skips ones already in the corpus, embeds the genuinely-new ones (qwen-768), and
 * upserts them. Sources: NBER, RePEc, IDB, Crossref-DOI econ journals (all via the
 * OpenAlex aggregator, which carries each source's works + Crossref DOIs), and
 * Semantic Scholar (its own API).
 *
 * Delta mechanism: OpenAlex `from_publication_date` (free tier; `from_created_date`/
 * `from_updated_date` are Premium-only) = today - lookbackDays. Use a generous lookback
 * (papers can be indexed a few weeks after publication). No watermark table needed;
 * dedup is by works.id (DOI or openalex:/ss: id). The DB upsert uses
 * onConflict:'id', ignoreDuplicates:true — GOLDEN RULE: never overwrites an existing
 * row; only inserts new papers.
 *
 * Usage:
 *   node scripts/weekly-ingest.mjs                       # all sources, last 10 days
 *   node scripts/weekly-ingest.mjs --source nber         # one source
 *   node scripts/weekly-ingest.mjs --lookback-days 60    # widen window (catch-up)
 *   node scripts/weekly-ingest.mjs --since 2026-05-01    # explicit from_created_date
 *   node scripts/weekly-ingest.mjs --max-per-source 2000 # cap per source (default 3000)
 *   node scripts/weekly-ingest.mjs --dry-run             # fetch + dedup, no embed/write
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL, LLM_API_KEY
 *   (OLLAMA_EMBEDDING_MODEL optional, default qwen3-embedding:8b-app).
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { loadVenueDenylist, filterDeniedVenues } from './lib/venue-denylist.mjs';
config();

// data/corpus-venue-denylist.json — mono-disciplinary non-econ venues (biomedical,
// materials science, astrophysics, etc.). fetchSemanticScholarDelta() below trusts
// S2's OWN fieldsOfStudy='Economics' tag, which is noisy (S2's ML classifier mistags
// pure biology papers as touching "Economics" — the 2026-07-20 contamination:
// Neuron/Cell Death and Disease/Science Immunology/etc. entering via this exact
// path with zero venue filter). Applied to every source's delta, not just S2, since
// OpenAlex's concept-based filters can drift too.
const VENUE_DENYLIST = loadVenueDenylist();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY || '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b-app';
const MODEL_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;
const MAILTO = process.env.OPENALEX_MAILTO || 'horizon-scanner@iadb.org';
const SS_KEY = process.env.SS_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || '';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const ONLY_SOURCE = arg('source');
const DRY_RUN = flag('dry-run');
const LOOKBACK_DAYS = Number(arg('lookback-days') || 10);
const MAX_PER_SOURCE = Number(arg('max-per-source') || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SINCE = arg('since') || (() => { const d = new Date(); d.setDate(d.getDate() - LOOKBACK_DAYS); return d.toISOString().slice(0, 10); })();

// ---------------------------------------------------------------------------
// OpenAlex source configs (NBER/RePEc/IDB by source/institution id; econ_journals
// = Economics-concept articles, which carry Crossref DOIs → the "crossref" coverage).
// ---------------------------------------------------------------------------
const OA_SOURCES = {
  nber:          { filter: 'primary_location.source.id:S2809516038', label: 'NBER Working Papers' },
  repec:         { filter: 'primary_location.source.id:S4306401271', label: 'RePEc: Research Papers in Economics' },
  idb:           { filter: 'institutions.id:I184564680',             label: 'Inter-American Development Bank' },
  econ_journals: { filter: 'concepts.id:C162324750,type:article,primary_location.source.type:journal', label: null }, // Economics articles in real JOURNALS only (source.type:journal excludes the Zenodo/repo self-publication flood that OpenAlex mislabels)
};

function reconstructAbstract(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const pos = Object.values(inv).flat(); if (!pos.length) return null;
  const words = Array(Math.max(...pos) + 1).fill('');
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) words[p] = w;
  const s = words.join(' ').trim(); return s.length > 20 ? s : null;
}
const normalizeDoi = (raw) => raw ? String(raw).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').trim() || null : null;
function mapType(t) {
  if (t === 'preprint') return 'working_paper';
  if (t === 'report') return 'report';
  if (t === 'article' || t === 'review') return 'journal_article';
  if (t === 'book') return 'book';
  if (t === 'book-chapter') return 'book_chapter';
  return 'working_paper';
}

function mapOaWork(w, sourceKey, fallbackLabel) {
  const title = w.title ? String(w.title).replace(/\s+/g, ' ').trim() : null;
  if (!title) return null;
  const wid = String(w.id || '').replace('https://openalex.org/', '');
  const doi = normalizeDoi(w.doi);
  const id = doi ?? (wid ? `openalex:${wid}` : null);
  if (!id) return null;
  const year = w.publication_year ?? null;
  const venue = w.primary_location?.source?.display_name || fallbackLabel || null;
  return {
    id, title, canonical_doi: doi, year,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    citation_count: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
    authors: (w.authorships || []).map((a) => a?.author?.display_name).filter(Boolean),
    publication_date: w.publication_date || (year ? `${year}-01-01` : null),
    is_open_access: !!w.open_access?.is_oa,
    open_access_pdf_url: w.primary_location?.pdf_url || w.best_oa_location?.pdf_url || null,
    fields_of_study: (w.concepts || []).slice(0, 12).map((c) => c.display_name).filter(Boolean),
    venue,
    publication_type: mapType(w.type),
    journal_issn: null,
    url: w.id || null,
    source: sourceKey === 'econ_journals' ? 'openalex' : sourceKey,
    corpus_source: `weekly_${sourceKey}`,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: { openalex_id: wid, openalex_type: w.type, weekly_ingest: SINCE },
  };
}

async function fetchOpenAlexDelta(sourceKey, cfg) {
  const out = [];
  let cursor = '*';
  while (out.length < MAX_PER_SOURCE) {
    const params = new URLSearchParams({
      filter: `${cfg.filter},from_publication_date:${SINCE}`,
      per_page: '200', cursor, mailto: MAILTO,
      select: 'id,doi,title,publication_year,publication_date,authorships,abstract_inverted_index,cited_by_count,primary_location,best_oa_location,open_access,concepts,type',
    });
    let j;
    for (let a = 1; a <= 4; a++) {
      try {
        const res = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 429) { await sleep(2000 * a); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        j = await res.json(); break;
      } catch (e) { if (a === 4) throw e; await sleep(1500 * a); }
    }
    for (const w of (j.results || [])) { const r = mapOaWork(w, sourceKey, cfg.label); if (r) out.push(r); }
    cursor = j.meta?.next_cursor ?? null;
    if (!cursor || !(j.results || []).length) break;
  }
  return out.slice(0, MAX_PER_SOURCE);
}

async function fetchSemanticScholarDelta() {
  // S2 bulk search: Economics field, indexed since SINCE (publicationDateOrYear lower bound).
  const out = [];
  let token = null;
  const headers = SS_KEY ? { 'x-api-key': SS_KEY } : {};
  do {
    const params = new URLSearchParams({
      query: 'economics', fieldsOfStudy: 'Economics',
      publicationDateOrYear: `${SINCE}:`,
      fields: 'title,abstract,authors,year,externalIds,venue,publicationDate,publicationTypes,citationCount',
      limit: '1000',
    });
    if (token) params.set('token', token);
    let j;
    for (let a = 1; a <= 4; a++) {
      try {
        const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search/bulk?${params}`, { headers, signal: AbortSignal.timeout(45_000) });
        if (res.status === 429) { await sleep(5000 * a); continue; }
        if (!res.ok) { console.error(`  [SS ${res.status}]`); return out; }
        j = await res.json(); break;
      } catch (e) { if (a === 4) { console.error(`  ss err ${e.message}`); return out; } await sleep(2000); }
    }
    for (const p of (j.data || [])) {
      const title = p.title ? String(p.title).replace(/\s+/g, ' ').trim() : null;
      if (!title) continue;
      const doi = normalizeDoi(p.externalIds?.DOI);
      const id = doi ?? (p.paperId ? `ss:${p.paperId}` : null);
      if (!id) continue;
      const abs = p.abstract && String(p.abstract).trim().length > 20 ? String(p.abstract).trim() : null;
      out.push({
        id, title, canonical_doi: doi, year: p.year ?? null, abstract: abs,
        citation_count: typeof p.citationCount === 'number' ? p.citationCount : null,
        authors: (p.authors || []).map((a) => a.name).filter(Boolean),
        publication_date: p.publicationDate || (p.year ? `${p.year}-01-01` : null),
        is_open_access: false, open_access_pdf_url: null, fields_of_study: ['Economics'],
        venue: p.venue || null,
        publication_type: (p.publicationTypes || []).includes('JournalArticle') ? 'journal_article' : 'working_paper',
        journal_issn: null, url: doi ? `https://doi.org/${doi}` : null,
        source: 'semantic_scholar', corpus_source: 'weekly_semantic_scholar',
        embedding: null, corpus_imported_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        raw_data: { ss_paper_id: p.paperId, weekly_ingest: SINCE },
      });
    }
    token = j.token ?? null;
    if (out.length >= MAX_PER_SOURCE) break;
  } while (token);
  return out.slice(0, MAX_PER_SOURCE);
}

// ---------------------------------------------------------------------------
// Embedding (qwen-768, matches reembed-qwen768.mjs / the corpus `embedding` column)
// ---------------------------------------------------------------------------
async function embedBatch(rows) {
  const texts = rows.map((r) => `search_document: ${[r.title, r.abstract].filter(Boolean).join(' ').slice(0, 8000)}`);
  for (let a = 1; a <= 4; a++) {
    try {
      const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}) },
        body: JSON.stringify({ model: EMBED_MODEL, ...(MODEL_DIMS ? { dimensions: MODEL_DIMS } : {}), input: texts, keep_alive: '60m' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) { await sleep(3000 * a); continue; }
      if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
      const j = await res.json();
      return (j.data || []).map((d) => d.embedding);
    } catch (e) { if (a === 4) throw e; await sleep(1500 * a); }
  }
}

// existence check for a batch of ids (cheap, avoids loading the whole corpus)
async function existingIds(ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 80) {
    const { data, error } = await supabase.from('works').select('id').in('id', ids.slice(i, i + 80));
    if (error) { console.error('  exists check:', error.message); continue; }
    for (const r of (data || [])) found.add(r.id);
  }
  return found;
}

async function ingestSource(sourceKey, rows) {
  if (!rows.length) return { fetched: 0, added: 0, dup: 0, denied: 0 };
  // Venue denylist FIRST — never let a known-noise venue reach the DB, dedup,
  // or the embedding call. Applied before existence-check so a re-run doesn't
  // re-pay the venue-lookup cost on rows we'll drop anyway.
  const preDeny = rows.length;
  rows = filterDeniedVenues(rows, VENUE_DENYLIST);
  const denied = preDeny - rows.length;
  if (!rows.length) { if (denied) console.log(`  [${sourceKey}] fetched ${preDeny} | denied(venue) ${denied} — nothing left to ingest`); return { fetched: preDeny, added: 0, dup: 0, denied }; }
  // dedup vs corpus by id
  const ids = [...new Set(rows.map((r) => r.id))];
  const have = await existingIds(ids);
  const seen = new Set();
  const fresh = rows.filter((r) => !have.has(r.id) && !seen.has(r.id) && seen.add(r.id));
  const dup = rows.length - fresh.length;
  if (DRY_RUN) { console.log(`  [${sourceKey}] fetched ${preDeny} | denied(venue) ${denied} | new ${fresh.length} | dup ${dup} (dry-run)`); return { fetched: preDeny, added: 0, dup, denied }; }
  let added = 0;
  for (let i = 0; i < fresh.length; i += 20) {
    const batch = fresh.slice(i, i + 20);
    try {
      const embs = await embedBatch(batch);
      batch.forEach((r, k) => { if (Array.isArray(embs?.[k]) && embs[k].length === (MODEL_DIMS || 768)) r.embedding = embs[k]; });
    } catch (e) { console.error(`  [${sourceKey}] embed batch failed (${e.message}) — inserting with null embedding`); }
    const { error } = await supabase.from('works').upsert(batch, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error(`  [${sourceKey}] upsert: ${error.message}`); continue; }
    added += batch.length;
    process.stdout.write(`\r  [${sourceKey}] ingested ${added}/${fresh.length}   `);
    await sleep(120);
  }
  process.stdout.write('\n');
  return { fetched: preDeny, added, dup, denied };
}

async function main() {
  console.log(`\n=== Weekly corpus ingest — ${new Date().toISOString()} ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | from_created_date >= ${SINCE} | max/source ${MAX_PER_SOURCE} | embed ${EMBED_MODEL}@${MODEL_DIMS || 'native'}\n`);
  if (!DRY_RUN && !LLM_KEY) { console.error('LLM_API_KEY missing — needed to embed new papers. Aborting.'); process.exit(1); }

  const sourceKeys = ['nber', 'repec', 'idb', 'econ_journals', 'semantic_scholar'];
  const targets = ONLY_SOURCE ? sourceKeys.filter((s) => s === ONLY_SOURCE) : sourceKeys;
  const totals = {};
  let grandAdded = 0;

  for (const key of targets) {
    console.log(`\n[${key}] fetching since ${SINCE}...`);
    let rows = [];
    try {
      rows = key === 'semantic_scholar' ? await fetchSemanticScholarDelta() : await fetchOpenAlexDelta(key, OA_SOURCES[key]);
    } catch (e) { console.error(`  [${key}] fetch failed: ${e.message}`); totals[key] = { error: e.message }; continue; }
    console.log(`  [${key}] fetched ${rows.length} candidate(s)`);
    const r = await ingestSource(key, rows);
    totals[key] = r; grandAdded += r.added || 0;
  }

  console.log('\n\n=== SUMMARY ===');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(18)} ${v.error ? 'ERROR: ' + v.error : `fetched ${v.fetched}, denied(venue) ${v.denied || 0}, new ${v.added}, dup ${v.dup}`}`);
  console.log(`\nTotal new papers ingested: ${grandAdded}`);
  console.log(`Venue denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
