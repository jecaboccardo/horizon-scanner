#!/usr/bin/env node
/**
 * Repair citation_count semantics.
 *
 * Rules:
 * - NULL = unknown/not supplied.
 * - 0 = a citation source explicitly reported zero.
 * - Positive values are citation-source counts.
 *
 * The script looks up works with citation_count NULL or 0 by DOI in OpenAlex.
 * If OpenAlex returns a work, it writes cited_by_count (including true 0) and
 * records provenance in raw_data.citation_count_*.
 *
 * For current zero rows from sources that do not provide citations, unresolved
 * rows can be normalized to NULL with --normalize-unknown-zero.
 *
 * Usage:
 *   node scripts/backfill-citation-counts.mjs --dry-run --limit 100
 *   node scripts/backfill-citation-counts.mjs --limit 5000 --normalize-unknown-zero
 *   node scripts/backfill-citation-counts.mjs --limit 5000 --normalize-unknown-zero --normalize-no-doi
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[citation-backfill] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const DRY_RUN = args.includes("--dry-run");
const NORMALIZE_UNKNOWN_ZERO = args.includes("--normalize-unknown-zero");
const NORMALIZE_NO_DOI = args.includes("--normalize-no-doi");
const RETRY_PROVENANCE = args.includes("--retry-provenance");
const LIMIT = Number(argValue("--limit", "1000")) || 1000;
const YEAR_MIN = Number(argValue("--year-min", "0")) || null;
const BATCH = Math.min(50, Number(argValue("--batch-size", "50")) || 50);
const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || "horizon-scanner@iadb.org";
const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `citation-count-backfill-${TODAY}.json`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeDoi(value) {
  return String(value || "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
}

function isCitationAwareSource(row) {
  const text = `${row.source || ""} ${row.corpus_source || ""} ${row.source_family || ""}`.toLowerCase();
  return /openalex|semantic_scholar|crossref/.test(text);
}

function mergeRawData(row, update) {
  const raw = row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
    ? row.raw_data
    : {};
  return { ...raw, ...update };
}

async function fetchTargets() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (all.length < LIMIT) {
    let query = supabase
      .from("works")
      .select("id,title,year,canonical_doi,source,corpus_source,source_family,citation_count,raw_data")
      .or("citation_count.is.null,citation_count.eq.0");
    if (!RETRY_PROVENANCE) query = query.is("raw_data->>citation_count_observed_at", null);
    if (!NORMALIZE_NO_DOI) query = query.not("canonical_doi", "is", null);
    if (YEAR_MIN) query = query.gte("year", YEAR_MIN);
    const { data, error } = await query
      .order("year", { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all.slice(0, LIMIT);
}

async function lookupOpenAlexByDoi(dois) {
  const clean = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  if (!clean.length) return new Map();
  const params = new URLSearchParams({
    filter: `doi:${clean.join("|")}`,
    "per-page": String(Math.min(50, clean.length)),
    select: "doi,cited_by_count",
    mailto: MAILTO,
  });
  const url = `https://api.openalex.org/works?${params.toString()}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${await res.text().catch(() => "")}`);
    const body = await res.json();
    const out = new Map();
    for (const item of body.results || []) {
      const doi = normalizeDoi(item.doi);
      if (!doi) continue;
      const count = item.cited_by_count;
      if (typeof count === "number" && Number.isFinite(count)) out.set(doi, count);
    }
    return out;
  }
  throw new Error("OpenAlex lookup failed after retries");
}

async function main() {
  console.log("\n=== Citation count backfill ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Normalize unknown zero: ${NORMALIZE_UNKNOWN_ZERO}\n`);
  console.log(`Normalize no-DOI non-citation zeros: ${NORMALIZE_NO_DOI}\n`);
  console.log(`Retry rows with citation provenance: ${RETRY_PROVENANCE}\n`);

  const targets = await fetchTargets();
  console.log(`Targets: ${targets.length}`);
  const results = [];
  let updated = 0;
  let confirmedZero = 0;
  let positiveFilled = 0;
  let normalizedNull = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    let found;
    try {
      found = await lookupOpenAlexByDoi(batch.map((row) => row.canonical_doi));
    } catch (error) {
      errors += batch.length;
      for (const row of batch) results.push({ id: row.id, status: "lookup_error", error: String(error.message || error) });
      continue;
    }

    const upserts = [];
    for (const row of batch) {
      const doi = normalizeDoi(row.canonical_doi);
      if (!doi) {
        if (NORMALIZE_NO_DOI && row.citation_count === 0 && !isCitationAwareSource(row)) {
          const raw_data = mergeRawData(row, {
            citation_count_source: null,
            citation_count_observed_at: new Date().toISOString(),
            citation_count_semantics: "unknown_normalized_from_legacy_zero_no_doi",
          });
          upserts.push({ id: row.id, citation_count: null, raw_data });
          normalizedNull++;
          results.push({ id: row.id, doi: null, status: DRY_RUN ? "would_normalize_null" : "normalized_null" });
        } else {
          notFound++;
          results.push({ id: row.id, doi: null, status: "no_doi" });
        }
        continue;
      }
      if (found.has(doi)) {
        const count = found.get(doi);
        const raw_data = mergeRawData(row, {
          citation_count_source: "openalex",
          citation_count_observed_at: new Date().toISOString(),
          citation_count_semantics: count === 0 ? "explicit_zero" : "source_reported",
        });
        upserts.push({ id: row.id, citation_count: count, raw_data });
        if (count === 0) confirmedZero++;
        else positiveFilled++;
        results.push({ id: row.id, doi, status: DRY_RUN ? "would_update" : "updated", citation_count: count });
        continue;
      }

      if (NORMALIZE_UNKNOWN_ZERO && row.citation_count === 0 && !isCitationAwareSource(row)) {
        const raw_data = mergeRawData(row, {
          citation_count_source: null,
          citation_count_observed_at: new Date().toISOString(),
          citation_count_semantics: "unknown_normalized_from_legacy_zero",
        });
        upserts.push({ id: row.id, citation_count: null, raw_data });
        normalizedNull++;
        results.push({ id: row.id, doi, status: DRY_RUN ? "would_normalize_null" : "normalized_null" });
      } else {
        notFound++;
        results.push({ id: row.id, doi, status: "not_found" });
      }
    }

    if (!DRY_RUN && upserts.length) {
      let batchUpdated = 0;
      for (const patch of upserts) {
        const { id, ...update } = patch;
        const { error } = await supabase.from("works").update(update).eq("id", id);
        if (error) {
          errors++;
          console.error(`\nUpdate error for ${id}: ${error.message}`);
        } else {
          batchUpdated++;
        }
      }
      updated += batchUpdated;
    } else if (DRY_RUN) {
      updated += upserts.length;
    }

    process.stdout.write(`\r  processed ${Math.min(i + BATCH, targets.length)}/${targets.length} | updates ${updated}`);
    await sleep(120);
  }
  process.stdout.write("\n");

  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    limit: LIMIT,
    year_min: YEAR_MIN,
    normalize_unknown_zero: NORMALIZE_UNKNOWN_ZERO,
    normalize_no_doi: NORMALIZE_NO_DOI,
    retry_provenance: RETRY_PROVENANCE,
    targets: targets.length,
    updated,
    positive_filled: positiveFilled,
    confirmed_zero: confirmedZero,
    normalized_null: normalizedNull,
    not_found: notFound,
    errors,
  };

  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((error) => {
  console.error("Fatal:", error.message);
  process.exit(1);
});
