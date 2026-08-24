#!/usr/bin/env node
/**
 * Delete works whose venue appears in data/corpus-venue-denylist.json.
 *
 * Default mode is dry-run: it counts and exports candidates only.
 *
 * Usage:
 *   node scripts/delete-denied-venue-works.mjs
 *   node scripts/delete-denied-venue-works.mjs --apply
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadVenueDenylist } from "./lib/venue-denylist.mjs";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[delete-denied-venues] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const SKIP_EXPORT = process.argv.includes("--skip-export");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = "reports";
const CANDIDATE_CSV = join(OUT_DIR, `denied-venue-delete-candidates-${TODAY}.csv`);
const SUMMARY_JSON = join(OUT_DIR, `denied-venue-delete-summary-${TODAY}.json`);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const denylist = loadVenueDenylist();
const venues = denylist.venues.filter((venue) => venue && venue !== "(missing)");

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function csvCell(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function countCandidates() {
  let total = 0;
  for (const venueChunk of chunks(venues, 25)) {
    const { count, error } = await supabase
      .from("works")
      .select("id", { count: "exact", head: true })
      .in("venue", venueChunk);
    if (error) throw new Error(`count chunk failed: ${error.message}`);
    total += count ?? 0;
  }
  return { total };
}

async function exportCandidates() {
  const rows = [];
  for (const venueChunk of chunks(venues, 50)) {
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("works")
        .select("id,canonical_doi,title,year,citation_count,venue,source,source_family,venue_kind,publication_type,corpus_source")
        .in("venue", venueChunk)
        .order("venue", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`export chunk failed: ${error.message}`);
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const columns = [
    "id",
    "canonical_doi",
    "title",
    "year",
    "citation_count",
    "venue",
    "source",
    "source_family",
    "venue_kind",
    "publication_type",
    "corpus_source",
  ];
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
  writeFileSync(CANDIDATE_CSV, csv);
  return rows.length;
}

async function deleteCandidates() {
  let deleted = 0;
  let dependentDeleted = 0;
  const errors = [];
  for (const venueChunk of chunks(venues, 100)) {
    const ids = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("works")
        .select("id")
        .in("venue", venueChunk)
        .range(from, from + PAGE - 1);
      if (error) {
        errors.push(`id fetch: ${error.message}`);
        break;
      }
      if (!data?.length) break;
      ids.push(...data.map((row) => row.id));
      if (data.length < PAGE) break;
      from += PAGE;
    }

    for (const idChunk of chunks(ids, 25)) {
      const { count, error } = await supabase
        .from("extraction_issues")
        .delete({ count: "exact" })
        .in("work_id", idChunk);
      if (error) {
        errors.push(`extraction_issues: ${error.message}`);
        continue;
      }
      dependentDeleted += count ?? 0;
    }

    const { count, error } = await supabase
      .from("works")
      .delete({ count: "exact" })
      .in("venue", venueChunk);
    if (error) {
      errors.push(error.message);
      continue;
    }
    deleted += count ?? 0;
  }
  return { deleted, dependentDeleted, errors };
}

mkdirSync(OUT_DIR, { recursive: true });

const before = await countCandidates();
const exportedRows = SKIP_EXPORT ? 0 : await exportCandidates();
let deletion = { deleted: 0, dependentDeleted: 0, errors: [] };
let after = null;

if (APPLY) {
  deletion = await deleteCandidates();
  after = await countCandidates();
}

const summary = {
  generated_at: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry_run",
  denylist_path: denylist.path,
  denylist_venue_count: venues.length,
  candidates_before: before.total,
  exported_candidate_rows: exportedRows,
  candidate_csv: SKIP_EXPORT ? null : CANDIDATE_CSV,
  deleted_rows: deletion.deleted,
  deleted_extraction_issues: deletion.dependentDeleted ?? 0,
  delete_errors: deletion.errors,
  candidates_after: after?.total ?? null,
};

writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ summary, outputs: { candidates: SKIP_EXPORT ? null : CANDIDATE_CSV, summary: SUMMARY_JSON } }, null, 2));

if (deletion.errors.length) process.exitCode = 1;
