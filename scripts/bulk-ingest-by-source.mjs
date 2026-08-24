#!/usr/bin/env node
/**
 * scripts/bulk-ingest-by-source.mjs
 *
 * Bulk-ingest all OpenAlex works belonging to a given primary source
 * (e.g. a journal source_id like S23254222 = American Economic Review).
 *
 * Usage:
 *   node scripts/bulk-ingest-by-source.mjs --source-id S23254222
 *   node scripts/bulk-ingest-by-source.mjs --source-id S23254222 --limit 200      # smoke test
 *   node scripts/bulk-ingest-by-source.mjs --source-id S23254222 --dry-run         # count only
 *   node scripts/bulk-ingest-by-source.mjs --source-id S23254222 --year-min 2010   # restrict
 *   node scripts/bulk-ingest-by-source.mjs --source-id S23254222 --concurrency 8 --batch-size 32
 *
 * Behavior:
 *  - cursor-paginates OpenAlex /works?filter=primary_location.source.id:Sxxxx
 *  - skips works whose DOI or `oa:Wxxxx` id is already in `works`
 *  - embeds title+abstract via the LiteLLM vLLM endpoint (BATCHED)
 *  - upserts into `works` with corpus_source='journal_backfill_<source_id>' (BATCHED, 50 / batch w/ fallback to 25)
 *  - safe to re-run; resumes from cursor after dedupe filter
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_API_KEY
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const EMBED_URL = `${LLM_BASE_URL.replace(/\/+$/, '')}/v1/embeddings`;
const OA_EMAIL = process.env.OPENALEX_EMAIL || 'horizon-scanner@iadb.org';

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE creds'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const argv = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const flag = (n) => args.includes(`--${n}`);

const SOURCE_ID = argv('source-id');
const LIMIT = parseInt(argv('limit') || '0', 10) || Infinity;
const DRY_RUN = flag('dry-run');
const YEAR_MIN = parseInt(argv('year-min') || '0', 10) || null;
const YEAR_MAX = parseInt(argv('year-max') || '0', 10) || null;
let CONCURRENCY = parseInt(argv('concurrency') || '8', 10) || 8;
let EMBED_BATCH = parseInt(argv('batch-size') || '32', 10) || 32;
let UPSERT_BATCH = parseInt(argv('upsert-batch') || '50', 10) || 50;

if (!SOURCE_ID) { console.error('Missing --source-id'); process.exit(1); }
if (!LLM_API_KEY && !DRY_RUN) { console.error('Missing LLM_API_KEY (required when not dry-run)'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normDoi = (d) => d ? String(d).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase().trim() : null;

function reconstructAbstract(inv) {
  if (!inv) return null;
  const pos = []; for (const [w, list] of Object.entries(inv)) for (const p of list || []) pos.push([p, w]);
  if (!pos.length) return null;
  pos.sort((a, b) => a[0] - b[0]);
  return pos.map(([, w]) => w).join(' ');
}

const SMS_PATTERNS = [
  { d: 'RCT', l: 5, re: /\b(randomized|randomised|rct|random assignment|random allocation)\b/i },
  { d: 'DiD', l: 4, re: /\b(difference.in.difference|did|diff.in.diff|double difference)\b/i },
  { d: 'IV', l: 4, re: /\b(instrumental variable|iv\b|two.stage least squares|2sls)\b/i },
  { d: 'RDD', l: 4, re: /\b(regression discontinuity|rdd)\b/i },
  { d: 'Observational', l: 2, re: /\b(observational|cross.sectional|panel data|fixed effects)\b/i },
  { d: 'Qualitative', l: 1, re: /\b(qualitative|case study|ethnograph|interview)\b/i },
];
function classify(p) {
  const t = `${p.title || ''} ${p.abstract || ''}`;
  for (const x of SMS_PATTERNS) if (x.re.test(t)) return { sms_level: x.l, methodology_design: x.d, causal_strength: x.l >= 4 ? 'high' : 'limited', sms_method: 'keyword_scan' };
  return { sms_level: null, methodology_design: null, causal_strength: null, sms_method: null };
}

// --- Adaptive rate-limit state for LiteLLM ---
let backoffUntil = 0;
async function respectBackoff() {
  const wait = backoffUntil - Date.now();
  if (wait > 0) await sleep(wait);
}
function noteRateLimit() {
  // halve concurrency on saturation, floor 1
  const next = Math.max(1, Math.floor(CONCURRENCY / 2));
  if (next !== CONCURRENCY) {
    process.stderr.write(`\n[rate-limit] concurrency ${CONCURRENCY} -> ${next}\n`);
    CONCURRENCY = next;
  }
}

/**
 * Embed a batch of texts in a single LiteLLM call.
 * Returns array of embeddings (same length / order as input). Failed slots = null.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  const cleaned = texts.map((t) => (t || '').slice(0, 2000));
  let delay = 1500;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await respectBackoff();
    try {
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: cleaned }),
        signal: AbortSignal.timeout(180000),
      });
      if (res.status === 429 || res.status >= 500) {
        process.stderr.write(`H${res.status}`);
        backoffUntil = Date.now() + delay;
        noteRateLimit();
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      if (!res.ok) {
        process.stderr.write(`H${res.status}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      const data = await res.json();
      const items = data?.data || [];
      const out = new Array(cleaned.length).fill(null);
      for (const item of items) {
        const idx = typeof item.index === 'number' ? item.index : null;
        if (idx == null) continue;
        if (Array.isArray(item.embedding) && item.embedding.length) out[idx] = item.embedding;
      }
      // verify
      const okCount = out.filter((v) => v).length;
      if (okCount === 0) { process.stderr.write('E'); await sleep(delay); delay = Math.min(delay * 2, 30000); continue; }
      return out;
    } catch (e) {
      process.stderr.write('!');
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
  return new Array(cleaned.length).fill(null);
}

async function preloadExistingIds() {
  const ids = new Set();
  let from = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase.from('works').select('id').range(from, from + PAGE - 1);
    if (error) { console.error('preload err:', error.message); break; }
    if (!data || !data.length) break;
    for (const r of data) ids.add(r.id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

async function* iterOpenAlex(sourceId) {
  let cursor = '*';
  while (cursor) {
    const params = new URLSearchParams({
      mailto: OA_EMAIL,
      per_page: '200',
      cursor,
      filter: [
        `primary_location.source.id:${sourceId}`,
        'type:article',
        'has_doi:true',
        ...(YEAR_MIN ? [`from_publication_date:${YEAR_MIN}-01-01`] : []),
        ...(YEAR_MAX ? [`to_publication_date:${YEAR_MAX}-12-31`] : []),
      ].join(','),
    });
    const url = `https://api.openalex.org/works?${params}`;
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); }
    catch (e) { console.error('OA fetch err:', e.message); await sleep(3000); continue; }
    if (!res.ok) { console.error('OA HTTP', res.status); break; }
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) break;
    for (const raw of results) yield raw;
    cursor = data.meta?.next_cursor;
    if (!cursor) break;
    await sleep(150);
  }
}

function rawToPaper(raw) {
  const doi = normDoi(raw.doi);
  const oaId = raw.id?.match(/\/(W\d+)$/)?.[1];
  const id = doi || (oaId ? `oa:${oaId}` : null);
  if (!id || !raw.title) return null;
  const oa = raw.open_access || {}; const loc = raw.primary_location || {}; const src = loc.source || {};
  return {
    id, title: raw.title, doi, year: raw.publication_year,
    abstract: reconstructAbstract(raw.abstract_inverted_index),
    authors: (raw.authorships || []).map((a) => a?.author?.display_name).filter(Boolean),
    publication_date: raw.publication_date, is_open_access: !!oa.is_oa,
    open_access_pdf_url: oa.oa_url || null,
    fields_of_study: (raw.concepts || []).map((c) => c?.display_name).filter(Boolean),
    venue: src.display_name || null, journal_issn: src.issn_l || null,
    url: oa.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : null),
    citation_count: raw.cited_by_count ?? null,
  };
}

function paperToRow(p, emb, corpusSource) {
  const sms = classify(p);
  return {
    id: p.id, title: p.title, canonical_doi: p.doi, year: p.year || null,
    abstract: p.abstract || null, citation_count: p.citation_count ?? null,
    authors: p.authors || [], publication_date: p.publication_date || null,
    is_open_access: !!p.is_open_access, open_access_pdf_url: p.open_access_pdf_url || null,
    fields_of_study: p.fields_of_study || [], venue: p.venue || null,
    journal_issn: p.journal_issn || null, url: p.url || null,
    source: 'openalex', ...sms,
    embedding: `[${emb.join(',')}]`,
    corpus_source: corpusSource,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Upsert with statement-timeout fallback: tries 50, drops to 25 + sleep on timeout.
 */
async function upsertRows(rows, stats) {
  if (!rows.length) return;
  // try full size first
  const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id' });
  if (!error) { stats.upserted += rows.length; return; }
  if (!/timeout|canceling statement|too large/i.test(error.message || '')) {
    stats.upsert_failed += rows.length;
    console.error('\nupsert err:', error.message);
    return;
  }
  // fallback: 25 at a time with sleep
  process.stderr.write(`\n[upsert] timeout — falling back to 25/batch + sleep\n`);
  if (UPSERT_BATCH > 25) UPSERT_BATCH = 25;
  for (let i = 0; i < rows.length; i += 25) {
    const slice = rows.slice(i, i + 25);
    const { error: e2 } = await supabase.from('works').upsert(slice, { onConflict: 'id' });
    if (e2) { stats.upsert_failed += slice.length; console.error('\nupsert err (small):', e2.message); }
    else { stats.upserted += slice.length; }
    await sleep(1800);
  }
}

/**
 * Process a chunk of papers: batched embed, then upsert.
 */
async function processChunk(papers, corpusSource, stats, existingIds) {
  if (!papers.length) return;
  // embed in batches of EMBED_BATCH
  const rows = [];
  for (let i = 0; i < papers.length; i += EMBED_BATCH) {
    const batch = papers.slice(i, i + EMBED_BATCH);
    const texts = batch.map((p) => `${p.title} ${p.abstract || ''}`);
    const embs = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      if (!embs[j]) { stats.embed_failed++; continue; }
      stats.embedded++;
      rows.push(paperToRow(batch[j], embs[j], corpusSource));
    }
  }
  // upsert in UPSERT_BATCH groups
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const slice = rows.slice(i, i + UPSERT_BATCH);
    await upsertRows(slice, stats);
    for (const r of slice) existingIds.add(r.id);
    if (UPSERT_BATCH <= 25) await sleep(1500);
  }
}

/**
 * Run multiple chunk-processors in parallel up to CONCURRENCY.
 * The "concurrency" here parallelizes embed-batch HTTP calls across chunks.
 */
async function runConcurrent(papers, corpusSource, stats, existingIds) {
  if (!papers.length) return;
  // split papers across CONCURRENCY workers, each doing batched embeds
  const workers = Math.max(1, Math.min(CONCURRENCY, Math.ceil(papers.length / EMBED_BATCH)));
  const chunkSize = Math.ceil(papers.length / workers);
  const chunks = [];
  for (let i = 0; i < papers.length; i += chunkSize) chunks.push(papers.slice(i, i + chunkSize));
  await Promise.all(chunks.map((c) => processChunk(c, corpusSource, stats, existingIds)));
}

async function main() {
  const t0 = Date.now();
  console.log(`=== Bulk ingest by source ===`);
  console.log(`source_id=${SOURCE_ID} limit=${LIMIT === Infinity ? 'none' : LIMIT} dry_run=${DRY_RUN} concurrency=${CONCURRENCY} embed_batch=${EMBED_BATCH} upsert_batch=${UPSERT_BATCH}`);

  const existingIds = await preloadExistingIds();
  console.log(`Existing work ids in DB: ${existingIds.size}`);

  const stats = { fetched: 0, skipped_duplicate: 0, embedded: 0, upserted: 0, embed_failed: 0, upsert_failed: 0 };
  const corpusSource = `journal_backfill_${SOURCE_ID}`;

  // pull WAVE papers from OpenAlex, then process them in parallel before pulling next wave
  const WAVE = Math.max(EMBED_BATCH * CONCURRENCY, 64); // e.g. 32*8 = 256
  let wave = [];

  for await (const raw of iterOpenAlex(SOURCE_ID)) {
    if (stats.upserted >= LIMIT) break;
    const p = rawToPaper(raw);
    if (!p) continue;
    stats.fetched++;
    if (existingIds.has(p.id)) { stats.skipped_duplicate++; continue; }
    if (DRY_RUN) { stats.upserted++; continue; }
    wave.push(p);
    if (wave.length >= WAVE) {
      await runConcurrent(wave, corpusSource, stats, existingIds);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = stats.upserted > 0 ? (stats.upserted / (Date.now() - t0) * 1000).toFixed(2) : '0';
      process.stdout.write(`\r  fetched=${stats.fetched} dup=${stats.skipped_duplicate} embedded=${stats.embedded} upserted=${stats.upserted} fail=${stats.embed_failed}/${stats.upsert_failed} ${elapsed}s ${rate}/s  `);
      wave = [];
      if (stats.upserted >= LIMIT) break;
    }
  }
  if (!DRY_RUN && wave.length) {
    await runConcurrent(wave, corpusSource, stats, existingIds);
  }
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n\n=== Done ===');
  console.log(JSON.stringify({ ...stats, wall_seconds: parseFloat(wallSec), papers_per_sec: parseFloat((stats.upserted / parseFloat(wallSec)).toFixed(2)) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
