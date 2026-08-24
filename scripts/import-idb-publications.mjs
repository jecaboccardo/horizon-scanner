#!/usr/bin/env node
/**
 * Bulk crawl the IDB Publications repository via Drupal JSON:API.
 * Paginates through ALL publications above the year cutoff (no query filter).
 *
 * Why this exists: the existing supabase/functions/_shared/idbPublicationsClient.ts
 * is a *search* client used at query time (filter by user query). The corpus
 * was missing systematic IDB papers — Azuara Herrera, Herrera Giraldo, etc. —
 * because they were only ingested when someone happened to search for them.
 *
 * This script crawls everything so the corpus has full IDB coverage.
 *
 * Usage:
 *   node scripts/import-idb-publications.mjs                  # 2018+, real run
 *   node scripts/import-idb-publications.mjs --years 10       # last N years
 *   node scripts/import-idb-publications.mjs --dry-run        # count only
 *   node scripts/import-idb-publications.mjs --max 1000       # cap for testing
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
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
const YEARS = parseInt(flagValue('--years', '8'));
const MAX_PAPERS = parseInt(flagValue('--max', '0')) || Infinity;
// --from <year> wins over --years (e.g. --from 2000 for the full back-catalogue).
const FROM_ARG = parseInt(flagValue('--from', ''), 10);
const YEAR_FROM = Number.isFinite(FROM_ARG) ? FROM_ARG : new Date().getFullYear() - YEARS;
const PAGE_LIMIT = 50; // IDB JSON:API max

const IDB_JSONAPI_URL = 'https://publications.iadb.org/en/jsonapi/node/publication';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mapping helpers (mirrors idbPublicationsClient.ts but server-side)
// ---------------------------------------------------------------------------
function cleanText(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function normalizeDoi(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase();
  return cleaned || null;
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function extractRelated(publication, includedMap, relName, attrField) {
  const rels = publication.relationships?.[relName]?.data;
  if (!Array.isArray(rels)) return [];
  const out = [];
  for (const rel of rels) {
    const inc = includedMap.get(`${rel.type}:${rel.id}`);
    const val = inc?.attributes?.[attrField] ?? inc?.attributes?.title ?? inc?.attributes?.name;
    if (val) out.push(String(val).trim());
  }
  return out;
}

function mapPublication(resource, includedMap) {
  const a = resource.attributes;
  if (!a) return null;
  const title = cleanText(a.title);
  if (!title) return null;

  const rawDoi = typeof a.field_doi === 'object' ? a.field_doi?.uri : a.field_doi;
  const doi = normalizeDoi(rawDoi);
  const id = doi ?? `idb:${resource.id}`;

  const abstract = cleanText(a.field_abstract?.value ?? a.field_abstract);
  const year = extractYear(a.field_date_issued_text);
  const publicationDate = a.field_date_issued_text ? String(a.field_date_issued_text).slice(0, 10) : null;

  const pdfUrl = a.field_document_link_en?.uri ?? a.field_document_link_es?.uri ?? a.field_document_link_pt?.uri ?? null;

  const authors = extractRelated(resource, includedMap, 'field_author', 'title');
  const subjects = extractRelated(resource, includedMap, 'field_subject', 'name');
  const pubType = extractRelated(resource, includedMap, 'field_knl_publication_type_code', 'name')[0] ?? null;
  const series = extractRelated(resource, includedMap, 'field_idb_series', 'name')[0] ?? null;
  const { publicationType, venue } = classifyIdbType(pubType, series);

  const handleId = a.field_handle_id;
  const url = handleId
    ? `https://publications.iadb.org/en/publication/${handleId}`
    : `https://publications.iadb.org/en/node/${resource.id}`;

  return {
    id,
    title,
    canonical_doi: doi,
    year,
    abstract,
    citation_count: null,
    authors,
    publication_date: publicationDate,
    is_open_access: true,
    open_access_pdf_url: pdfUrl,
    fields_of_study: subjects,
    venue,
    publication_type: publicationType,
    journal_issn: null,
    url,
    source: 'idb_publications',
    corpus_source: 'idb_bulk',
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      idb_node_id: resource.id,
      handle_id: handleId,
      subjects,
      idb_publication_type: pubType,
      idb_series: series,
    },
  };
}

// Map the IDB knowledge publication-type taxonomy term to the corpus
// publication_type enum + a type-specific venue label, so Technical Notes,
// Working Papers, etc. are distinguishable and filterable. IDB output is mostly
// gray literature → default to 'report'/'IDB Publication' when type is unknown.
function classifyIdbType(pubType, _series) {
  const t = String(pubType ?? '').toLowerCase();
  if (/technical note/.test(t))   return { publicationType: 'report',           venue: 'IDB Technical Note' };
  if (/working paper/.test(t))    return { publicationType: 'working_paper',    venue: 'IDB Working Paper' };
  if (/discussion paper/.test(t)) return { publicationType: 'discussion_paper', venue: 'IDB Discussion Paper' };
  if (/policy brief|brief/.test(t)) return { publicationType: 'report',         venue: 'IDB Policy Brief' };
  if (/monograph|book/.test(t))   return { publicationType: 'book',             venue: 'IDB Monograph' };
  if (/article/.test(t))          return { publicationType: 'journal_article',  venue: 'IDB Publication' };
  return { publicationType: 'report', venue: 'IDB Publication' };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
async function fetchPage(offset) {
  const params = new URLSearchParams();
  params.set('filter[date-filter][condition][path]', 'field_date_issued_text');
  params.set('filter[date-filter][condition][operator]', '>=');
  params.set('filter[date-filter][condition][value]', `${YEAR_FROM}-01-01`);
  params.set('sort', '-field_date_issued_text');
  params.set('page[limit]', String(PAGE_LIMIT));
  params.set('page[offset]', String(offset));
  params.set('include', 'field_author,field_subject,field_knl_publication_type_code,field_idb_series');

  const url = `${IDB_JSONAPI_URL}?${params}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.api+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const includedMap = new Map();
  if (Array.isArray(json.included)) {
    for (const inc of json.included) includedMap.set(`${inc.type}:${inc.id}`, inc);
  }
  const rawCount = (json.data ?? []).length;
  const records = (json.data ?? [])
    .map((r) => mapPublication(r, includedMap))
    .filter(Boolean);
  // total available — when omitted, infer from JSON:API `links.next` or raw count.
  const total = json.meta?.count ?? null;
  // Crucial: hasMore must be based on the RAW API page size (records may drop
  // due to null mapping for missing titles). Also honor `links.next`.
  const hasMore = (json.links?.next != null) || rawCount === PAGE_LIMIT;
  return { records, total, hasMore };
}

async function loadExistingIds() {
  const ids = new Set();
  const dois = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('works')
      .select('id,canonical_doi')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('existing-load:', error.message); break; }
    if (!data?.length) break;
    for (const r of data) {
      if (r.id) ids.add(r.id);
      if (r.canonical_doi) dois.add(r.canonical_doi.toLowerCase());
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { ids, dois };
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
  console.log('\n=== IDB Publications bulk crawl ===');
  console.log(`Years: from ${YEAR_FROM}, dry-run=${DRY_RUN}, max=${MAX_PAPERS === Infinity ? 'unlimited' : MAX_PAPERS}\n`);

  console.log('Loading existing corpus ids/dois (for dedup)...');
  const { ids: existingIds, dois: existingDois } = await loadExistingIds();
  console.log(`  existing: ${existingIds.size} ids, ${existingDois.size} dois\n`);

  let offset = 0;
  let totalSeen = 0;
  let totalNew = 0;
  let totalUpserted = 0;
  let totalErrors = 0;
  const buffer = [];

  while (totalSeen < MAX_PAPERS) {
    let page;
    try {
      page = await fetchPage(offset);
    } catch (err) {
      console.error(`\n  fetch error at offset ${offset}: ${err.message}`);
      // Backoff once
      await sleep(2000);
      try {
        page = await fetchPage(offset);
      } catch (err2) {
        console.error(`  retry failed: ${err2.message} — stopping.`);
        break;
      }
    }
    if (!page.records.length) break;
    totalSeen += page.records.length;

    for (const row of page.records) {
      // Skip if already in corpus by id or DOI
      if (existingIds.has(row.id)) continue;
      if (row.canonical_doi && existingDois.has(row.canonical_doi)) continue;
      buffer.push(row);
      existingIds.add(row.id);
      if (row.canonical_doi) existingDois.add(row.canonical_doi);
      totalNew++;
    }

    process.stdout.write(`\r  offset=${offset}  seen=${totalSeen}  new=${totalNew}  upserted=${totalUpserted}`);

    if (!DRY_RUN && buffer.length >= 100) {
      try {
        await upsertBatch(buffer.splice(0, buffer.length));
        totalUpserted = totalNew - buffer.length;
      } catch (err) {
        console.error(`\n  upsert error: ${err.message}`);
        totalErrors++;
      }
    }

    if (!page.hasMore) break;
    offset += PAGE_LIMIT;
    await sleep(300);
  }

  if (!DRY_RUN && buffer.length > 0) {
    try {
      await upsertBatch(buffer);
      totalUpserted = totalNew;
    } catch (err) {
      console.error(`\n  final upsert error: ${err.message}`);
      totalErrors++;
    }
  }

  console.log(`\n\nDone. seen=${totalSeen}, new=${totalNew}, upserted=${DRY_RUN ? '(dry)' : totalUpserted}, errors=${totalErrors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
