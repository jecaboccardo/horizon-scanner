#!/usr/bin/env node
/**
 * Export works with missing/empty abstracts for corpus hygiene/backfill triage.
 *
 * Usage:
 *   node scripts/report-missing-abstracts.mjs
 *   node scripts/report-missing-abstracts.mjs --limit 50000
 *   node scripts/report-missing-abstracts.mjs --venues "Journal of Econometrics,Econometrica,Journal of Applied Econometrics" --out-prefix targeted-missing-abstracts
 *   node scripts/report-missing-abstracts.mjs --include-denied-venues --out-prefix missing-abstracts-all
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[missing-abstracts] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const LIMIT = Number(argValue("--limit", "200000"));
const OUT_PREFIX = argValue("--out-prefix", "missing-abstracts");
const VENUES = String(argValue("--venues", ""))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const INCLUDE_DENIED_VENUES = process.argv.includes("--include-denied-venues");
const VENUE_DENYLIST = loadVenueDenylist();
const PAGE = 1000;
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = "reports";
const OUT_JSON = join(OUT_DIR, `${OUT_PREFIX}-${TODAY}.json`);
const OUT_CSV = join(OUT_DIR, `${OUT_PREFIX}-${TODAY}.csv`);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function missingAbstract(query) {
  return query.or("abstract.is.null,abstract.eq.");
}

function venueFilter(query) {
  return VENUES.length ? query.in("venue", VENUES) : query;
}

function targetMissing(query) {
  return missingAbstract(venueFilter(query));
}

async function exactCount(apply) {
  let query = supabase.from("works").select("id", { count: "exact", head: true });
  if (apply) query = apply(query);
  const { count, error } = await query;
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

function groupCount(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = row[key] == null || row[key] === "" ? "(null)" : String(row[key]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([value, count]) => ({ value, count }));
}

function csvCell(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

const totalWorks = await exactCount(VENUES.length ? venueFilter : null);
const missingCount = await exactCount(targetMissing);

const rows = [];
for (let from = 0; rows.length < Math.min(LIMIT, missingCount); from += PAGE) {
  const to = Math.min(from + PAGE - 1, LIMIT - 1);
  const { data, error } = await targetMissing(
    supabase
      .from("works")
      .select([
        "id",
        "canonical_doi",
        "title",
        "year",
        "citation_count",
        "authors",
        "venue",
        "source",
        "source_family",
        "venue_kind",
        "publication_type",
        "corpus_source",
        "url",
        "open_access_pdf_url",
        "sms_level",
        "methodology_design",
        "causal_strength",
      ].join(","))
      .order("citation_count", { ascending: false, nullsFirst: false })
      .range(from, to),
  );
  if (error) throw new Error(`page ${from}-${to} failed: ${error.message}`);
  if (!data || data.length === 0) break;
  rows.push(...(INCLUDE_DENIED_VENUES ? data : filterDeniedVenues(data, VENUE_DENYLIST)));
  if (data.length < PAGE) break;
}

mkdirSync(OUT_DIR, { recursive: true });

const summary = {
  generated_at: new Date().toISOString(),
  venues: VENUES.length ? VENUES : "all",
  venue_denylist_count: VENUE_DENYLIST.venues.length,
  include_denied_venues: INCLUDE_DENIED_VENUES,
  total_works_in_scope: totalWorks,
  missing_abstract_count: missingCount,
  missing_abstract_pct: totalWorks ? Number(((missingCount / totalWorks) * 100).toFixed(2)) : 0,
  exported_rows: rows.length,
  ordered_by: "citation_count desc",
  top_source_family: groupCount(rows, "source_family"),
  top_source: groupCount(rows, "source"),
  top_venue_kind: groupCount(rows, "venue_kind"),
  top_publication_type: groupCount(rows, "publication_type"),
  top_corpus_source: groupCount(rows, "corpus_source"),
};

writeFileSync(OUT_JSON, JSON.stringify({ summary, rows }, null, 2));

const csvColumns = [
  "id",
  "canonical_doi",
  "title",
  "year",
  "citation_count",
  "authors",
  "venue",
  "source",
  "source_family",
  "venue_kind",
  "publication_type",
  "corpus_source",
  "url",
  "open_access_pdf_url",
  "sms_level",
  "methodology_design",
  "causal_strength",
];

const csv = [
  csvColumns.join(","),
  ...rows.map((row) => csvColumns.map((column) => csvCell(row[column])).join(",")),
].join("\n");
writeFileSync(OUT_CSV, csv);

console.log(JSON.stringify({
  summary,
  outputs: {
    json: OUT_JSON,
    csv: OUT_CSV,
  },
}, null, 2));
