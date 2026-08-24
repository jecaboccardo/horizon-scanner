#!/usr/bin/env node
/**
 * Repository-native World Bank ingester.
 *
 * WHY: the corpus had only ~976 World Bank papers (DOI prefix 10.1596), pulled
 * INCIDENTALLY via OpenAlex — whose World Bank catalogue is fragmented and
 * shallow (the targeted OpenAlex sources hold ~3.2k works total, and key papers
 * like the Avitabile & de Hoyos WB-PRWP twin are filed under untargeted source
 * ids / type=book). The repec importer's OpenAlex-source filters therefore miss
 * most of the ~8k Policy Research Working Papers published since 2000.
 *
 * This crawls the SOURCE OF TRUTH instead — the World Bank Documents & Reports
 * (WDS) API — exactly mirroring the strategy that made the IDB crawler work.
 * Abstracts, authors, PDF links, dates all come inline (no separate abstract
 * backfill needed for these rows; embeddings still need backfill-fast.mjs).
 *
 *   id            = wb:<wds_id>           (WDS gives no DOI; PRWP 10.1596 DOIs
 *                                          are not derivable from the WDS id)
 *   canonical_doi = null
 *   venue         = docty (default "World Bank Policy Research Working Paper")
 *   publication_type = working_paper
 *   source / corpus_source = worldbank_wds
 *   embedding     = null  → run scripts/backfill-fast.mjs afterwards
 *
 * GOLDEN RULE: upsert uses { onConflict:'id', ignoreDuplicates:true } so it
 * NEVER overwrites an existing row. Dedup also skips any WB paper whose
 * normalized title already exists in the corpus (the ~976 OpenAlex versions),
 * so we don't create duplicate shadows.
 *
 * Usage:
 *   node scripts/import-worldbank.mjs --dry-run            # count only, per year
 *   node scripts/import-worldbank.mjs                      # 2000..now, real run
 *   node scripts/import-worldbank.mjs --from 2010          # year range
 *   node scripts/import-worldbank.mjs --to 2015
 *   node scripts/import-worldbank.mjs --docty "Working Paper"
 *   node scripts/import-worldbank.mjs --max 500            # cap (testing)
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flagValue(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const DRY_RUN = args.includes('--dry-run');
const YEAR_FROM = parseInt(flagValue('--from', '2000'), 10);
const YEAR_TO = parseInt(flagValue('--to', String(new Date().getFullYear())), 10);
const DOCTY = flagValue('--docty', 'Policy Research Working Paper');
// Targeted mode: ingest only docs matching a search term (any doctype) — used
// for named flagship reports (e.g. GEEAP "Smart Buys") WITHOUT bulk-ingesting
// the huge, noisy "Report" doctype.
const QTERM = flagValue('--qterm', null);
const MAX_PAPERS = parseInt(flagValue('--max', '0'), 10) || Infinity;

const WDS_URL = 'https://search.worldbank.org/api/v3/wds';
const PAGE_ROWS = 100;
const VENUE = DOCTY === 'Policy Research Working Paper'
  ? 'World Bank Policy Research Working Paper'
  : `World Bank ${DOCTY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------
function cleanText(raw) {
  if (!raw) return null;
  const stripped = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function normTitleKey(title) {
  if (!title) return '';
  return String(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function mapDoc(doc) {
  const title = cleanText(doc.display_title || doc.docna);
  if (!title) return null;

  const wdsId = doc.id || doc.guid || doc.entityids?.entityid;
  if (!wdsId) return null;

  const abstract = cleanText(doc.abstracts?.['cdata!'] ?? doc.abstracts?.cdata ?? null);
  const year = extractYear(doc.docdt);
  const publicationDate = doc.docdt ? String(doc.docdt).slice(0, 10) : null;

  // authors: { "0": { author: "Last, First" }, ... }
  const authors = doc.authors
    ? Object.values(doc.authors).map((a) => cleanText(a?.author)).filter(Boolean)
    : [];

  const country = cleanText(doc.count); // e.g. "India" / "World"

  // Derive venue + publication_type from the doc's OWN doctype (correct for
  // both the PRWP bulk mode and the qterm targeted mode where docty varies).
  const dty = doc.docty || DOCTY;
  const pubType = /policy research working paper|working paper/i.test(dty) ? 'working_paper' : 'report';
  const docVenue = /policy research working paper/i.test(dty) ? 'World Bank Policy Research Working Paper' : `World Bank ${dty}`;

  return {
    id: `wb:${wdsId}`,
    title,
    canonical_doi: null,
    year,
    abstract,
    citation_count: null,
    authors,
    publication_date: publicationDate,
    is_open_access: true,
    open_access_pdf_url: doc.pdfurl || null,
    fields_of_study: doc.keywd ? Object.values(doc.keywd).map((k) => cleanText(k?.keywd ?? k)).filter(Boolean).slice(0, 20) : [],
    venue: docVenue,
    publication_type: pubType,
    journal_issn: null,
    url: doc.url || null,
    source: 'worldbank_wds',
    corpus_source: 'worldbank_wds',
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      wds_id: wdsId,
      docty: doc.docty || DOCTY,
      report_number: doc.repnb || null,
      wb_country: country,
      entity_id: doc.entityids?.entityid || null,
    },
  };
}

// ---------------------------------------------------------------------------
// WDS pagination (per-year — the open-ended strdate query is unreliable)
// ---------------------------------------------------------------------------
async function fetchYearPage(year, offset) {
  const params = new URLSearchParams({
    format: 'json',
    rows: String(PAGE_ROWS),
    os: String(offset),
    strdate: `${year}-01-01`,
    enddate: `${year}-12-31`,
    docty: DOCTY,
  });
  const url = `${WDS_URL}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const total = parseInt(json.total ?? '0', 10) || 0;
  const docsObj = json.documents || {};
  const records = [];
  for (const [key, doc] of Object.entries(docsObj)) {
    if (key === 'facets') continue;
    const mapped = mapDoc(doc);
    if (mapped) records.push(mapped);
  }
  return { records, total };
}

async function fetchQtermPage(offset) {
  const params = new URLSearchParams({ format: 'json', rows: String(PAGE_ROWS), os: String(offset), qterm: QTERM });
  const res = await fetch(`${WDS_URL}?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const total = parseInt(json.total ?? '0', 10) || 0;
  const records = [];
  for (const [key, doc] of Object.entries(json.documents || {})) {
    if (key === 'facets') continue;
    const mapped = mapDoc(doc);
    if (mapped) records.push(mapped);
  }
  return { records, total };
}

// ---------------------------------------------------------------------------
// Existing-corpus load (dedup by id AND normalized title)
// ---------------------------------------------------------------------------
async function loadExisting() {
  const ids = new Set();
  const titles = new Set();
  const PAGE = 1000;
  const CONCURRENCY = 12;

  const { count, error: cErr } = await supabase
    .from('works').select('*', { count: 'exact', head: true });
  if (cErr) { console.error('count error:', cErr.message); }
  const total = count ?? 600000;
  const nPages = Math.ceil(total / PAGE);
  process.stdout.write(`Loading existing corpus (~${total} rows, ${nPages} pages, ${CONCURRENCY}-way) for dedup`);

  async function fetchPage(p) {
    const fromIdx = p * PAGE;
    const { data, error } = await supabase
      .from('works').select('id,title')
      .order('id', { ascending: true })
      .range(fromIdx, fromIdx + PAGE - 1);
    if (error) { console.error(`\npage ${p}:`, error.message); return; }
    for (const r of data || []) {
      if (r.id) ids.add(r.id);
      const tk = normTitleKey(r.title);
      if (tk.length >= 20) titles.add(tk);
    }
  }

  for (let base = 0; base < nPages; base += CONCURRENCY) {
    const batch = [];
    for (let k = 0; k < CONCURRENCY && base + k < nPages; k++) batch.push(fetchPage(base + k));
    await Promise.all(batch);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return { ids, titles };
}

async function upsertBatch(rows) {
  const { error } = await supabase
    .from('works')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== World Bank WDS bulk crawl ===');
  console.log(`docty="${DOCTY}"  years ${YEAR_FROM}..${YEAR_TO}  dry-run=${DRY_RUN}  max=${MAX_PAPERS === Infinity ? 'unlimited' : MAX_PAPERS}\n`);

  const { ids: existingIds, titles: existingTitles } = DRY_RUN
    ? { ids: new Set(), titles: new Set() }
    : await loadExisting();
  if (!DRY_RUN) console.log(`  existing: ${existingIds.size} ids, ${existingTitles.size} titles\n`);

  let totalSeen = 0, totalNew = 0, totalUpserted = 0, dupById = 0, dupByTitle = 0, totalErrors = 0;
  const buffer = [];

  // ----- Targeted qterm mode (named flagship reports, any doctype) -----
  if (QTERM) {
    console.log(`Targeted qterm="${QTERM}" (any doctype)\n`);
    let offset = 0, total = null;
    while (totalSeen < MAX_PAPERS) {
      let page;
      try { page = await fetchQtermPage(offset); }
      catch (err) { console.error(`\n  qterm offset ${offset}: ${err.message} — retry`); await sleep(2000); try { page = await fetchQtermPage(offset); } catch (e2) { console.error(`  failed: ${e2.message}`); totalErrors++; break; } }
      if (total == null) { total = page.total; console.log(`  ${total} matches\n`); }
      if (!page.records.length) break;
      totalSeen += page.records.length;
      for (const row of page.records) {
        if (DRY_RUN) { console.log(`   [${row.year}|${row.publication_type}] ${row.title.slice(0, 70)}`); totalNew++; continue; }
        if (existingIds.has(row.id)) { dupById++; continue; }
        const tk = normTitleKey(row.title);
        if (tk.length >= 20 && existingTitles.has(tk)) { dupByTitle++; continue; }
        buffer.push(row); existingIds.add(row.id); if (tk.length >= 20) existingTitles.add(tk); totalNew++;
      }
      offset += PAGE_ROWS;
      if (offset >= total) break;
      await sleep(300);
    }
    if (!DRY_RUN && buffer.length) { try { await upsertBatch(buffer.splice(0, buffer.length)); totalUpserted = totalNew; } catch (err) { console.error(`\n  upsert: ${err.message}`); totalErrors++; } }
    console.log(`\nDone (qterm). seen=${totalSeen} new=${totalNew} upserted=${DRY_RUN ? '(dry)' : totalUpserted} dup_by_id=${dupById} dup_by_title=${dupByTitle} errors=${totalErrors}`);
    if (!DRY_RUN && totalNew > 0) console.log('\nNext: run  node scripts/backfill-fast.mjs  to embed the new rows.');
    return;
  }

  for (let year = YEAR_TO; year >= YEAR_FROM && totalSeen < MAX_PAPERS; year--) {
    let offset = 0, yearTotal = null, yearNew = 0;
    while (totalSeen < MAX_PAPERS) {
      let page;
      try {
        page = await fetchYearPage(year, offset);
      } catch (err) {
        console.error(`\n  ${year} offset ${offset} error: ${err.message} — retrying once`);
        await sleep(2000);
        try { page = await fetchYearPage(year, offset); }
        catch (e2) { console.error(`  retry failed: ${e2.message} — skipping rest of ${year}`); totalErrors++; break; }
      }
      if (yearTotal == null) yearTotal = page.total;
      if (!page.records.length) break;
      totalSeen += page.records.length;

      for (const row of page.records) {
        if (DRY_RUN) { totalNew++; yearNew++; continue; }
        if (existingIds.has(row.id)) { dupById++; continue; }
        const tk = normTitleKey(row.title);
        if (tk.length >= 20 && existingTitles.has(tk)) { dupByTitle++; continue; }
        buffer.push(row);
        existingIds.add(row.id);
        if (tk.length >= 20) existingTitles.add(tk);
        totalNew++; yearNew++;
      }

      if (!DRY_RUN && buffer.length >= 100) {
        try { await upsertBatch(buffer.splice(0, buffer.length)); totalUpserted = totalNew - buffer.length; }
        catch (err) { console.error(`\n  upsert error: ${err.message}`); totalErrors++; }
      }

      offset += PAGE_ROWS;
      if (offset >= yearTotal) break;
      await sleep(300);
    }
    process.stdout.write(`\r  ${year}: total=${yearTotal ?? '?'} new=${yearNew}   (cumulative seen=${totalSeen} new=${totalNew})        \n`);
  }

  if (!DRY_RUN && buffer.length) {
    try { await upsertBatch(buffer); totalUpserted = totalNew; }
    catch (err) { console.error(`\n  final upsert error: ${err.message}`); totalErrors++; }
  }

  console.log(`\nDone. seen=${totalSeen}  new=${totalNew}  upserted=${DRY_RUN ? '(dry)' : totalUpserted}  dup_by_id=${dupById}  dup_by_title=${dupByTitle}  errors=${totalErrors}`);
  if (!DRY_RUN && totalNew > 0) console.log('\nNext: run  node scripts/backfill-fast.mjs  to embed the new rows (embedding is null).');
}

main().catch((e) => { console.error(e); process.exit(1); });
