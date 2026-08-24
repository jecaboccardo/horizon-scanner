#!/usr/bin/env node
/**
 * Export a whole-corpus venue rollup with a conservative IADB relevance flag.
 *
 * Usage:
 *   node scripts/report-corpus-venue-relevance.mjs
 *   node scripts/report-corpus-venue-relevance.mjs --out-prefix corpus-venue-iadb-relevance-review
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[venue-relevance] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const PAGE = Number(argValue("--page-size", "1000"));
const LIMIT = Number(argValue("--limit", "1000000"));
const OUT_PREFIX = argValue("--out-prefix", "corpus-venue-iadb-relevance-review");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = "reports";
const OUT_CSV = join(OUT_DIR, `${OUT_PREFIX}-${TODAY}.csv`);
const OUT_JSON = join(OUT_DIR, `${OUT_PREFIX}-${TODAY}.json`);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const OFF_DOMAIN_PATTERNS = [
  { label: "medicine", pattern: /\b(medical|medicine|clinical|clinician|surgery|surgical|pharmacology|pharmaceutical|nursing|dentistry|dental|radiology|oncology|cardiology|neurology|psychiatry|anesthesiology|pediatrics|pathology|epidemiology|biomedicine|biomedical)\b/i },
  { label: "physical_science", pattern: /\b(physics|physical review|astronomy|astrophysics|chemistry|chemical|materials science|geology|geophysics|quantum|particle|nuclear)\b/i },
  { label: "life_science", pattern: /\b(biology|biological|molecular|cell biology|genetics|genomics|neuroscience|botany|zoology)\b/i },
];

function emptyStat() {
  return {
    venue: "",
    row_count: 0,
    min_year: null,
    max_year: null,
    pre_1950_count: 0,
    sources: new Map(),
    source_families: new Map(),
    venue_kinds: new Map(),
    publication_types: new Map(),
    corpus_sources: new Map(),
    example_titles: [],
  };
}

function bump(map, value) {
  const key = value == null || value === "" ? "(null)" : String(value);
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addExample(stat, title) {
  if (!title || stat.example_titles.length >= 3) return;
  stat.example_titles.push(String(title).replace(/\s+/g, " ").trim());
}

function topValues(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value}:${count}`)
    .join("; ");
}

function relevanceFlag(stat) {
  const reasons = [];
  const venue = stat.venue || "";
  const tooOld = stat.max_year != null && stat.max_year < 1950;
  if (tooOld) reasons.push("all_items_before_1950");

  const offDomainLabels = OFF_DOMAIN_PATTERNS
    .filter(({ pattern }) => pattern.test(venue))
    .map(({ label }) => label);
  if (offDomainLabels.length) reasons.push(`off_domain_venue_name:${offDomainLabels.join("|")}`);

  return {
    too_old_flag: tooOld,
    off_domain_keyword_flag: offDomainLabels.length > 0,
    not_relevant_to_iadb_flag: reasons.length > 0,
    flag_reason: reasons.join("; "),
  };
}

function csvCell(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function exactCount() {
  const { count, error } = await supabase.from("works").select("id", { count: "exact", head: true });
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

const totalWorks = await exactCount();
const stats = new Map();
let scanned = 0;

for (let from = 0; from < Math.min(totalWorks, LIMIT); from += PAGE) {
  const to = Math.min(from + PAGE - 1, LIMIT - 1);
  const { data, error } = await supabase
    .from("works")
    .select("id,title,year,venue,source,source_family,venue_kind,publication_type,corpus_source")
    .range(from, to);

  if (error) throw new Error(`page ${from}-${to} failed: ${error.message}`);
  if (!data || data.length === 0) break;

  for (const row of data) {
    const venue = row.venue == null || row.venue === "" ? "(missing)" : String(row.venue).trim();
    if (!stats.has(venue)) stats.set(venue, { ...emptyStat(), venue });
    const stat = stats.get(venue);
    const year = Number(row.year);

    stat.row_count += 1;
    if (Number.isFinite(year)) {
      stat.min_year = stat.min_year == null ? year : Math.min(stat.min_year, year);
      stat.max_year = stat.max_year == null ? year : Math.max(stat.max_year, year);
      if (year < 1950) stat.pre_1950_count += 1;
    }
    bump(stat.sources, row.source);
    bump(stat.source_families, row.source_family);
    bump(stat.venue_kinds, row.venue_kind);
    bump(stat.publication_types, row.publication_type);
    bump(stat.corpus_sources, row.corpus_source);
    addExample(stat, row.title);
  }

  scanned += data.length;
  if (data.length < PAGE) break;
}

mkdirSync(OUT_DIR, { recursive: true });

const rows = [...stats.values()]
  .sort((a, b) => b.row_count - a.row_count || a.venue.localeCompare(b.venue))
  .map((stat) => {
    const flags = relevanceFlag(stat);
    return {
      venue: stat.venue,
      row_count: stat.row_count,
      min_year: stat.min_year,
      max_year: stat.max_year,
      pre_1950_count: stat.pre_1950_count,
      pre_1950_share: stat.row_count ? (stat.pre_1950_count / stat.row_count).toFixed(4) : "0.0000",
      too_old_flag: flags.too_old_flag,
      off_domain_keyword_flag: flags.off_domain_keyword_flag,
      not_relevant_to_iadb_flag: flags.not_relevant_to_iadb_flag,
      flag_reason: flags.flag_reason,
      sources: topValues(stat.sources),
      source_families: topValues(stat.source_families),
      venue_kinds: topValues(stat.venue_kinds),
      publication_types: topValues(stat.publication_types),
      corpus_sources: topValues(stat.corpus_sources),
      example_titles: stat.example_titles.join("; "),
    };
  });

const columns = [
  "venue",
  "row_count",
  "min_year",
  "max_year",
  "pre_1950_count",
  "pre_1950_share",
  "too_old_flag",
  "off_domain_keyword_flag",
  "not_relevant_to_iadb_flag",
  "flag_reason",
  "sources",
  "source_families",
  "venue_kinds",
  "publication_types",
  "corpus_sources",
  "example_titles",
];

const csv = [
  columns.join(","),
  ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
].join("\n");

const summary = {
  generated_at: new Date().toISOString(),
  total_works: totalWorks,
  scanned_rows: scanned,
  venue_count: rows.length,
  flagged_venues: rows.filter((row) => row.not_relevant_to_iadb_flag).length,
  criteria: {
    too_old_flag: "max_year < 1950",
    off_domain_keyword_flag: "strict medicine, physical science, or life science keywords in venue name",
    not_relevant_to_iadb_flag: "too_old_flag OR off_domain_keyword_flag",
  },
};

writeFileSync(OUT_CSV, csv);
writeFileSync(OUT_JSON, JSON.stringify({ summary, rows }, null, 2));

console.log(JSON.stringify({ summary, outputs: { csv: OUT_CSV, json: OUT_JSON } }, null, 2));
