#!/usr/bin/env node
/**
 * Requeue a bounded slice of evidence-card extraction failures caused by the
 * retired qwen2.5:14b-instruct model.
 *
 * Usage:
 *   node scripts/requeue-old-model-extraction-failures.mjs --limit 1000
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limitFlag = process.argv.indexOf("--limit");
const LIMIT = limitArg
  ? parseInt(limitArg.split("=")[1], 10)
  : limitFlag >= 0
    ? parseInt(process.argv[limitFlag + 1], 10)
    : 500;

if (!Number.isFinite(LIMIT) || LIMIT <= 0 || LIMIT > 25_000) {
  console.error(`Invalid --limit: ${LIMIT} (must be 1..25000)`);
  process.exit(1);
}

const FETCH_PAGE = 1000;
const UPDATE_PAGE = 100;
const OLD_MODEL_PATTERN = "%qwen2.5:14b-instruct%";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

console.log(`[requeue-old-model] target=${LIMIT}`);

const rows = [];
let from = 0;
while (rows.length < LIMIT) {
  const { data, error } = await supabase
    .from("extraction_queue")
    .select("work_id, priority_score, attempts, last_error")
    .eq("state", "failed")
    .ilike("last_error", OLD_MODEL_PATTERN)
    .order("priority_score", { ascending: false })
    .range(from, from + FETCH_PAGE - 1);

  if (error) throw new Error(`failed rows fetch from=${from}: ${error.message}`);
  if (!data || data.length === 0) break;

  rows.push(...data.slice(0, Math.max(0, LIMIT - rows.length)));
  if (data.length < FETCH_PAGE) break;
  from += FETCH_PAGE;
}

if (rows.length === 0) {
  console.log("[requeue-old-model] nothing to requeue");
  process.exit(0);
}

console.log(
  `[requeue-old-model] requeueing ${rows.length} rows ` +
  `(top score: ${Number(rows[0].priority_score ?? 0).toFixed(2)}, ` +
  `bottom: ${Number(rows.at(-1).priority_score ?? 0).toFixed(2)})`,
);

let updated = 0;
for (let i = 0; i < rows.length; i += UPDATE_PAGE) {
  const ids = rows.slice(i, i + UPDATE_PAGE).map((row) => row.work_id);
  const { error } = await supabase
    .from("extraction_queue")
    .update({
      state: "queued",
      attempts: 0,
      last_error: null,
      started_at: null,
      completed_at: null,
    })
    .in("work_id", ids);

  if (error) throw new Error(`requeue chunk ${i}: ${error.message}`);
  updated += ids.length;
  console.log(`  requeued ${updated}/${rows.length}`);
}

console.log(`[requeue-old-model] DONE - ${updated} rows requeued`);
