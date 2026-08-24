#!/usr/bin/env node
/**
 * Repair skinny IDB Publication rows with metadata from the public IDB
 * Publications JSON:API.
 *
 * Older ingestion paths created some IDB rows with title/abstract only. The
 * bulk importer later used ignoreDuplicates, so those rows never received
 * authors, publication URLs, PDF URLs, canonical DOI, or raw_data provenance.
 *
 * Usage:
 *   node scripts/backfill-idb-publication-metadata.mjs --year-min 2000
 *   node scripts/backfill-idb-publication-metadata.mjs --dry-run --year-min 2000
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] ?? fallback : fallback;
}

const DRY_RUN = args.includes("--dry-run");
const YEAR_MIN = Number(argValue("--year-min", "2000"));
const MAX_PAGES = Number(argValue("--max-pages", "0")) || Infinity;
const PAGE_LIMIT = 50;
const IDB_JSONAPI_URL = "https://publications.iadb.org/en/jsonapi/node/publication";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function normalizeDoi(raw) {
  if (!raw) return null;
  const value = typeof raw === "object" ? raw.uri : raw;
  return String(value || "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase() || null;
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([a-z]{2}\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(value) {
  const year = Number.parseInt(String(value || "").slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function extractRelated(resource, includedMap, relName, attrField) {
  const rels = resource.relationships?.[relName]?.data;
  if (!Array.isArray(rels)) return [];
  const out = [];
  for (const rel of rels) {
    const included = includedMap.get(`${rel.type}:${rel.id}`);
    const value = included?.attributes?.[attrField] ?? included?.attributes?.title ?? included?.attributes?.name;
    if (value) out.push(String(value).trim());
  }
  return [...new Set(out.filter(Boolean))];
}

function mapPublication(resource, includedMap) {
  const attrs = resource.attributes || {};
  const title = cleanText(attrs.title);
  if (!title) return null;
  const doi = normalizeDoi(attrs.field_doi);
  const year = extractYear(attrs.field_date_issued_text);
  const handleId = attrs.field_handle_id;
  return {
    id: doi || `idb:${resource.id}`,
    title,
    titleKey: normalizeTitle(title),
    canonical_doi: doi,
    year,
    abstract: cleanText(attrs.field_abstract?.value ?? attrs.field_abstract),
    authors: extractRelated(resource, includedMap, "field_author", "title"),
    fields_of_study: extractRelated(resource, includedMap, "field_subject", "name"),
    publication_date: attrs.field_date_issued_text ? String(attrs.field_date_issued_text).slice(0, 10) : null,
    open_access_pdf_url: attrs.field_document_link_en?.uri ??
      attrs.field_document_link_es?.uri ??
      attrs.field_document_link_pt?.uri ??
      null,
    url: handleId
      ? `https://publications.iadb.org/en/publication/${handleId}`
      : `https://publications.iadb.org/en/node/${resource.id}`,
    raw_data: {
      idb_node_id: resource.id,
      handle_id: handleId ?? null,
      subjects: extractRelated(resource, includedMap, "field_subject", "name"),
      repaired_from_idb_jsonapi: true,
    },
  };
}

async function loadTargets() {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("works")
      .select("id,title,year,venue,source,source_family,canonical_doi,authors,abstract,url,open_access_pdf_url,fields_of_study,publication_date,raw_data")
      .gte("year", YEAR_MIN)
      .or("venue.eq.IDB Publication,source.eq.idb,source.eq.idb_publications,source_family.eq.IADB")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`target load failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function needsRepair(row) {
  const authorsMissing = !Array.isArray(row.authors) || row.authors.length === 0;
  const rawEmpty = !row.raw_data || (typeof row.raw_data === "object" && Object.keys(row.raw_data).length === 0);
  return authorsMissing || !row.url || !row.open_access_pdf_url || !row.canonical_doi || rawEmpty;
}

function hasValue(value) {
  return value != null && String(value).trim() !== "";
}

function buildPatch(row, pub) {
  const patch = {
    source: row.source || "idb_publications",
    source_family: row.source_family || "IADB",
    corpus_source: "idb_bulk",
    is_open_access: true,
    updated_at: new Date().toISOString(),
  };
  if ((!Array.isArray(row.authors) || row.authors.length === 0) && pub.authors.length) patch.authors = pub.authors;
  if (!hasValue(row.canonical_doi) && pub.canonical_doi) patch.canonical_doi = pub.canonical_doi;
  if (!hasValue(row.url) && pub.url) patch.url = pub.url;
  if (!hasValue(row.open_access_pdf_url) && pub.open_access_pdf_url) patch.open_access_pdf_url = pub.open_access_pdf_url;
  if (!hasValue(row.publication_date) && pub.publication_date) patch.publication_date = pub.publication_date;
  if ((!Array.isArray(row.fields_of_study) || row.fields_of_study.length === 0) && pub.fields_of_study.length) {
    patch.fields_of_study = pub.fields_of_study;
  }
  if (!hasValue(row.abstract) && pub.abstract) patch.abstract = pub.abstract;
  patch.raw_data = {
    ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
    ...pub.raw_data,
  };
  return patch;
}

async function fetchPage(offset) {
  const params = new URLSearchParams();
  params.set("filter[date-filter][condition][path]", "field_date_issued_text");
  params.set("filter[date-filter][condition][operator]", ">=");
  params.set("filter[date-filter][condition][value]", `${YEAR_MIN}-01-01`);
  params.set("sort", "-field_date_issued_text");
  params.set("page[limit]", String(PAGE_LIMIT));
  params.set("page[offset]", String(offset));
  params.set("include", "field_author,field_subject");

  let response = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await fetch(`${IDB_JSONAPI_URL}?${params}`, {
        headers: { Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`IDB HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
    } catch (err) {
      if (attempt === 4) throw err;
    }
    await sleep(1500 * attempt);
  }
  if (!response?.ok) throw new Error(`IDB HTTP ${response?.status || "unknown"}`);
  const json = await response.json();
  const includedMap = new Map();
  for (const item of json.included || []) includedMap.set(`${item.type}:${item.id}`, item);
  return {
    records: (json.data || []).map((item) => mapPublication(item, includedMap)).filter(Boolean),
    hasMore: Boolean(json.links?.next) || (json.data || []).length === PAGE_LIMIT,
  };
}

async function main() {
  console.log("\n=== IDB publication metadata repair ===");
  console.log(`Year min: ${YEAR_MIN}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const targets = (await loadTargets()).filter(needsRepair);
  const byId = new Map(targets.map((row) => [String(row.id).toLowerCase(), row]));
  const byDoi = new Map(targets.filter((row) => row.canonical_doi).map((row) => [String(row.canonical_doi).toLowerCase(), row]));
  const byTitle = new Map();
  for (const row of targets) {
    const key = `${normalizeTitle(row.title)}|${row.year || ""}`;
    if (!byTitle.has(key)) byTitle.set(key, row);
  }
  console.log(`Repair candidates in works: ${targets.length}`);

  let offset = 0;
  let pageNo = 0;
  let seen = 0;
  let matched = 0;
  let updated = 0;
  let authorFilled = 0;
  let urlFilled = 0;
  let pdfFilled = 0;

  while (pageNo < MAX_PAGES) {
    const page = await fetchPage(offset);
    if (!page.records.length) break;
    pageNo++;
    seen += page.records.length;

    for (const pub of page.records) {
      const row = byId.get(String(pub.id).toLowerCase()) ||
        (pub.canonical_doi ? byDoi.get(pub.canonical_doi) : null) ||
        byTitle.get(`${pub.titleKey}|${pub.year || ""}`);
      if (!row) continue;
      matched++;
      const patch = buildPatch(row, pub);
      if (Object.keys(patch).length <= 5) continue;
      if (!DRY_RUN) {
        const { error } = await supabase.from("works").update(patch).eq("id", row.id);
        if (error) {
          console.error(`  update failed ${row.id}: ${error.message}`);
          continue;
        }
      }
      updated++;
      if (patch.authors) authorFilled++;
      if (patch.url) urlFilled++;
      if (patch.open_access_pdf_url) pdfFilled++;
    }

    process.stdout.write(`\r  pages ${pageNo} | IDB seen ${seen} | matched ${matched} | updated ${updated}`);
    if (!page.hasMore) break;
    offset += PAGE_LIMIT;
    await sleep(150);
  }

  console.log("\n");
  console.log(JSON.stringify({
    dry_run: DRY_RUN,
    year_min: YEAR_MIN,
    repair_candidates: targets.length,
    idb_records_seen: seen,
    matched,
    updated,
    author_filled: authorFilled,
    url_filled: urlFilled,
    pdf_filled: pdfFilled,
  }, null, 2));
}

main().catch((err) => {
  console.error("[idb-metadata-repair] failed:", err.message);
  process.exit(1);
});
