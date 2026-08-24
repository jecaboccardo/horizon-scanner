#!/usr/bin/env node
/**
 * Delete corpus works with year <= 1960.
 *
 * This is intentionally conservative: dry-run by default, requires --confirm
 * to delete, and deletes non-cascading related rows before deleting works.
 *
 * Usage:
 *   node scripts/delete-pre-1961-works.mjs --dry-run
 *   node scripts/delete-pre-1961-works.mjs --confirm
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { CORPUS_MIN_YEAR } from "./lib/corpus-year-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[delete-pre-1961] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CONFIRM = process.argv.includes("--confirm");
const DRY_RUN = !CONFIRM || process.argv.includes("--dry-run");
const YEAR_MAX = CORPUS_MIN_YEAR - 1;
const PAGE = Number(process.env.DELETE_PRE_1961_PAGE || "1000");
const RELATED_CHUNK = Number(process.env.DELETE_PRE_1961_RELATED_CHUNK || "100");

async function exactCount(table, apply) {
  let q = supabase.from(table).select("*", { count: "exact", head: true });
  if (apply) q = apply(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count || 0;
}

async function sampleOldWorks() {
  const { data, error } = await supabase
    .from("works")
    .select("id,title,year,venue,citation_count")
    .lte("year", YEAR_MAX)
    .order("citation_count", { ascending: false, nullsFirst: false })
    .limit(10);
  if (error) throw new Error(`sample: ${error.message}`);
  return data || [];
}

async function loadOldIds() {
  const { data, error } = await supabase
    .from("works")
    .select("id")
    .lte("year", YEAR_MAX)
    .order("id", { ascending: true })
    .limit(PAGE);
  if (error) throw new Error(`load ids: ${error.message}`);
  return (data || []).map((row) => row.id).filter(Boolean);
}

async function deleteFrom(table, column, ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += RELATED_CHUNK) {
    const chunk = ids.slice(i, i + RELATED_CHUNK);
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).delete().in(column, chunk);
    if (error) throw new Error(`${table} delete: ${error.message}`);
    deleted += chunk.length;
  }
  return deleted;
}

async function deleteBatch(ids) {
  await deleteFrom("extraction_issues", "work_id", ids);
  await deleteFrom("work_citations", "cited_work_id", ids);
  await deleteFrom("works", "id", ids);
  return ids.length;
}

async function main() {
  console.log("\n=== Delete pre-1961 works ===");
  console.log(`Policy: delete works where year <= ${YEAR_MAX}`);
  console.log(`Mode: ${DRY_RUN ? "dry-run" : "CONFIRMED DELETE"}`);
  console.log(`Batch size: ${PAGE}\n`);
  console.log(`Related-row delete chunk: ${RELATED_CHUNK}\n`);

  const oldWorks = await exactCount("works", (q) => q.lte("year", YEAR_MAX));
  const sample = await sampleOldWorks();

  console.log(`Works year <= ${YEAR_MAX}: ${oldWorks}`);
  console.log("Top sample by citation_count:");
  for (const row of sample) {
    console.log(`  ${row.year || "?"} ${row.citation_count || 0} ${row.id} :: ${String(row.title || "").slice(0, 100)}`);
  }

  if (DRY_RUN) {
    console.log("\nDry run only. Re-run with --confirm to delete.");
    return;
  }

  let deleted = 0;
  for (;;) {
    const ids = await loadOldIds();
    if (!ids.length) break;
    const n = await deleteBatch(ids);
    deleted += n;
    process.stdout.write(`\r  deleted works: ${deleted}/${oldWorks}`);
  }
  console.log(`\n\nDeleted works: ${deleted}`);

  const remaining = await exactCount("works", (q) => q.lte("year", YEAR_MAX));
  console.log(`Remaining works year <= ${YEAR_MAX}: ${remaining}`);
}

main().catch((err) => {
  console.error("[delete-pre-1961] failed:", err);
  process.exit(1);
});
