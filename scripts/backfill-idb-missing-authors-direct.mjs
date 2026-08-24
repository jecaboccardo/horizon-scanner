#!/usr/bin/env node
/**
 * Directly repair IDB/IADB rows whose authors are still empty.
 *
 * The broad IDB page-scan repair can miss rows when local source/year metadata
 * came from a different provider. This script scans candidate works locally,
 * then queries the public IDB JSON:API by DOI first and title second.
 *
 * Usage:
 *   node scripts/backfill-idb-missing-authors-direct.mjs --dry-run
 *   node scripts/backfill-idb-missing-authors-direct.mjs
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const DRY_RUN = process.argv.includes("--dry-run");
const PAGE = 1000;
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

function isMissingAuthors(authors) {
  return !Array.isArray(authors) ||
    authors.length === 0 ||
    authors.every((author) => !String(author || "").trim());
}

function titleWithoutLanguage(title) {
  return String(title || "").replace(/\s+\([a-z]{2}\)\s*$/i, "").trim();
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
  const doi = normalizeDoi(attrs.field_doi);
  const handleId = attrs.field_handle_id;
  return {
    title,
    canonical_doi: doi,
    year: extractYear(attrs.field_date_issued_text),
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
      repaired_from_idb_direct_author_lookup: true,
    },
  };
}

async function idbRequest(params) {
  params.set("include", "field_author,field_subject");
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(`${IDB_JSONAPI_URL}?${params}`, {
        headers: { Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`IDB HTTP ${response.status}`);
      const json = await response.json();
      const includedMap = new Map();
      for (const item of json.included || []) includedMap.set(`${item.type}:${item.id}`, item);
      return (json.data || []).map((item) => mapPublication(item, includedMap)).filter(Boolean);
    } catch (err) {
      lastError = err;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function lookupIdb(row) {
  const doi = normalizeDoi(row.canonical_doi || row.id);
  if (doi?.startsWith("10.18235/")) {
    const params = new URLSearchParams();
    params.set("filter[doi-filter][condition][path]", "field_doi.uri");
    params.set("filter[doi-filter][condition][operator]", "CONTAINS");
    params.set("filter[doi-filter][condition][value]", doi);
    const byDoi = await idbRequest(params);
    const exact = byDoi.find((pub) => pub.canonical_doi === doi && pub.authors.length);
    if (exact) return exact;
    const withAuthors = byDoi.find((pub) => pub.authors.length);
    if (withAuthors) return withAuthors;
  }

  const params = new URLSearchParams();
  params.set("filter[title-filter][condition][path]", "title");
  params.set("filter[title-filter][condition][operator]", "CONTAINS");
  params.set("filter[title-filter][condition][value]", titleWithoutLanguage(row.title));
  const byTitle = await idbRequest(params);
  return byTitle.find((pub) => pub.authors.length) || null;
}

async function loadTargets() {
  const targets = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("works")
      .select("id,title,year,source,source_family,venue,authors,canonical_doi,url,open_access_pdf_url,fields_of_study,publication_date,raw_data,abstract")
      .or("venue.eq.IDB Publication,source.eq.idb,source.eq.idb_publications,source_family.eq.IADB")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load targets failed: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      if (isMissingAuthors(row.authors)) targets.push(row);
    }
    if (data.length < PAGE) break;
  }
  return targets;
}

function buildPatch(row, pub) {
  const patch = {
    authors: pub.authors,
    source: row.source || "idb_publications",
    source_family: row.source_family || "IADB",
    corpus_source: "idb_bulk",
    is_open_access: true,
    raw_data: {
      ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
      ...pub.raw_data,
    },
    updated_at: new Date().toISOString(),
  };
  if (!row.canonical_doi && pub.canonical_doi) patch.canonical_doi = pub.canonical_doi;
  if (!row.url && pub.url) patch.url = pub.url;
  if (!row.open_access_pdf_url && pub.open_access_pdf_url) patch.open_access_pdf_url = pub.open_access_pdf_url;
  if (!row.publication_date && pub.publication_date) patch.publication_date = pub.publication_date;
  if ((!Array.isArray(row.fields_of_study) || row.fields_of_study.length === 0) && pub.fields_of_study.length) {
    patch.fields_of_study = pub.fields_of_study;
  }
  if (!row.abstract && pub.abstract) patch.abstract = pub.abstract;
  return patch;
}

async function main() {
  console.log("\n=== IDB direct missing-author repair ===");
  console.log(`Dry run: ${DRY_RUN}\n`);

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);

  let matched = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    try {
      const pub = await lookupIdb(row);
      if (!pub?.authors?.length) {
        notFound++;
        console.log(`${i + 1}/${targets.length} not_found ${row.year || "?"} ${row.id} :: ${row.title}`);
        continue;
      }
      matched++;
      const patch = buildPatch(row, pub);
      if (!DRY_RUN) {
        const { data, error } = await supabase
          .from("works")
          .update(patch)
          .eq("id", row.id)
          .select("id,authors")
          .single();
        if (error) throw new Error(error.message);
        if (isMissingAuthors(data?.authors)) {
          throw new Error("update did not persist authors");
        }
      }
      updated++;
      console.log(`${i + 1}/${targets.length} ${DRY_RUN ? "would_update" : "updated"} authors=${pub.authors.join("; ")} ${row.id}`);
      await sleep(150);
    } catch (err) {
      errors++;
      console.error(`${i + 1}/${targets.length} error ${row.id}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({
    dry_run: DRY_RUN,
    targets: targets.length,
    matched,
    updated,
    not_found: notFound,
    errors,
  }, null, 2));
}

main().catch((err) => {
  console.error("[idb-direct-author-repair] failed:", err.message);
  process.exit(1);
});
