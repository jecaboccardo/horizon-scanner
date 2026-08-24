#!/usr/bin/env node
/**
 * Re-score queued evidence-card work so economics/policy papers are claimed
 * before high-citation non-econ papers already sitting in extraction_queue.
 *
 * This only updates state='queued' rows. Processing/done/failed rows are left
 * alone, so it is safe to run while workers are active.
 *
 * Usage:
 *   node scripts/reprioritize-extraction-queue-econ.mjs --limit 10000
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import {
  computeEvidencePriority,
  EVIDENCE_PRIORITY_SELECT,
  loadGoldSignals,
} from "./lib/evidence-priority.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const LIMIT = parseInt(argValue("--limit", "10000"), 10);
const PAGE = 1000;
const WORK_FETCH_PAGE = 80;
const UPDATE_PAGE = 200;

if (!Number.isFinite(LIMIT) || LIMIT <= 0 || LIMIT > 100_000) {
  console.error(`Invalid --limit: ${LIMIT} (must be 1..100000)`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const goldSignals = loadGoldSignals();

console.log(`[reprioritize-econ] target queued rows=${LIMIT}`);

let rows = [];
let from = 0;
while (rows.length < LIMIT) {
  const { data, error } = await supabase
    .from("extraction_queue")
    .select("work_id, priority_score")
    .eq("state", "queued")
    .order("priority_score", { ascending: false })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`queue fetch from=${from}: ${error.message}`);
  if (!data || data.length === 0) break;
  rows.push(...data.slice(0, Math.max(0, LIMIT - rows.length)));
  if (data.length < PAGE) break;
  from += PAGE;
}

if (rows.length === 0) {
  console.log("[reprioritize-econ] no queued rows");
  process.exit(0);
}

rows = [...new Map(rows.map((row) => [row.work_id, row])).values()];
console.log(`[reprioritize-econ] fetched ${rows.length} queued rows`);

async function fetchWorksByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += WORK_FETCH_PAGE) {
    const chunk = ids.slice(i, i + WORK_FETCH_PAGE);
    const { data, error } = await supabase
      .from("works")
      .select(EVIDENCE_PRIORITY_SELECT)
      .in("id", chunk);
    if (error) throw new Error(`works fetch chunk=${i}: ${error.message}`);
    for (const row of data ?? []) out.set(row.id, row);
  }
  return out;
}

const workMap = await fetchWorksByIds(rows.map((row) => row.work_id));
const updates = [];
const buckets = { gold: 0, strongEcon: 0, weakEcon: 0, nonEcon: 0, missingWork: 0 };

for (const row of rows) {
  const work = workMap.get(row.work_id);
  if (!work) {
    buckets.missingWork++;
    continue;
  }
  // Current queued priority may already include an econ boost from a previous
  // run. Cap the inherited base at the old-view scale so repeated runs are
  // idempotent-ish instead of adding the econ boost again and again.
  const basePriority = Math.min(Number(row.priority_score ?? 0), 8);
  const scored = computeEvidencePriority(work, basePriority, { goldSignals });
  const next = Number(scored.finalPriority.toFixed(4));
  const current = Number(row.priority_score ?? 0);
  if (Math.abs(next - current) > 0.01) {
    updates.push({ work_id: row.work_id, priority_score: next });
  }

  if (scored.reasons.includes("gold/canary")) buckets.gold++;
  else if (scored.econScore >= 6) buckets.strongEcon++;
  else if (scored.econScore >= 3) buckets.weakEcon++;
  else buckets.nonEcon++;
}

console.log(
  `[reprioritize-econ] mix: gold=${buckets.gold} strong_econ=${buckets.strongEcon} ` +
  `weak_econ=${buckets.weakEcon} non_econ=${buckets.nonEcon} missing=${buckets.missingWork}`,
);
const uniqueUpdates = [...new Map(updates.map((row) => [row.work_id, row])).values()];
console.log(`[reprioritize-econ] updating ${uniqueUpdates.length} queued priorities`);

let updated = 0;
for (let i = 0; i < uniqueUpdates.length; i += UPDATE_PAGE) {
  const chunk = uniqueUpdates.slice(i, i + UPDATE_PAGE);
  const { error } = await supabase
    .from("extraction_queue")
    .upsert(chunk, { onConflict: "work_id" });
  if (error) throw new Error(`priority update chunk=${i}: ${error.message}`);
  updated += chunk.length;
  console.log(`  updated ${updated}/${uniqueUpdates.length}`);
}

console.log("[reprioritize-econ] DONE");
