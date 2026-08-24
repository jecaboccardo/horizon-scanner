// scripts/enqueue.mjs
// Insert top-N priority papers into extraction_queue.
//
// Default profile is `econ`: starts from works_priority_view but only enqueues
// papers with clear economics / policy relevance, plus eval gold/canary papers.
// Use --profile all to recover the old broad behavior.
//
// Usage:
//   node scripts/enqueue.mjs --limit 1000
//   node scripts/enqueue.mjs --limit 1000 --profile all
//   node scripts/enqueue.mjs --limit 3000 --min-econ-score 3 --scan-limit 50000

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import {
  computeEvidencePriority,
  EVIDENCE_PRIORITY_SELECT,
  isEconEligible,
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

const LIMIT = parseInt(argValue("--limit", "10"), 10);
const PROFILE = argValue("--profile", "econ");
const MIN_ECON_SCORE = Number(argValue("--min-econ-score", "3"));
const SCAN_MULTIPLIER = Number(argValue("--scan-multiplier", "10"));
const SCAN_LIMIT = Number(argValue(
  "--scan-limit",
  String(Math.min(80_000, Math.max(LIMIT * SCAN_MULTIPLIER, LIMIT))),
));

if (!Number.isFinite(LIMIT) || LIMIT <= 0 || LIMIT > 300_000) {
  console.error(`Invalid --limit: ${LIMIT} (must be 1..300000)`);
  process.exit(1);
}
if (!["econ", "all"].includes(PROFILE)) {
  console.error(`Invalid --profile: ${PROFILE} (expected "econ" or "all")`);
  process.exit(1);
}

const PAGE = 1000;
const WORK_FETCH_PAGE = 80;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

console.log(`[enqueue] target=${LIMIT} profile=${PROFILE} from works_priority_view`);
if (PROFILE === "econ") {
  console.log(`[enqueue] econ filter: min_econ_score=${MIN_ECON_SCORE} scan_limit=${SCAN_LIMIT}`);
}

async function fetchExistingIds() {
  const set = new Set();
  for (const table of ["extraction_queue", "evidence_cards"]) {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select("work_id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} fetch: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const row of data) set.add(row.work_id);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  return set;
}

async function fetchWorksByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += WORK_FETCH_PAGE) {
    const chunk = ids.slice(i, i + WORK_FETCH_PAGE);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("works")
      .select(EVIDENCE_PRIORITY_SELECT)
      .in("id", chunk);
    if (error) throw new Error(`works fetch chunk ${i}: ${error.message}`);
    for (const row of data ?? []) out.set(row.id, row);
  }
  return out;
}

async function seedGoldCanaries(fresh, already, goldSignals) {
  const dois = [...goldSignals.doiSet];
  for (let i = 0; i < dois.length; i += 100) {
    const chunk = dois.slice(i, i + 100);
    const { data, error } = await supabase
      .from("works")
      .select(EVIDENCE_PRIORITY_SELECT)
      .in("canonical_doi", chunk);
    if (error) throw new Error(`gold/canary DOI fetch ${i}: ${error.message}`);

    for (const work of data ?? []) {
      if (already.has(work.id)) continue;
      const scored = computeEvidencePriority(work, 50, { goldSignals });
      fresh.push({
        id: work.id,
        priority_score: scored.finalPriority,
        original_priority_score: 50,
        econScore: scored.econScore,
        reasons: scored.reasons,
      });
      already.add(work.id);
    }
  }
}

const already = await fetchExistingIds();
console.log(`[enqueue] already in queue/cards: ${already.size}`);

const fresh = [];
const goldSignals = PROFILE === "econ" ? loadGoldSignals() : null;
if (PROFILE === "econ") {
  await seedGoldCanaries(fresh, already, goldSignals);
  if (fresh.length > 0) {
    console.log(`[enqueue] seeded ${fresh.length} gold/canary rows before priority scan`);
  }
}

let from = 0;
let scanned = 0;
while (fresh.length < LIMIT && (PROFILE === "all" || scanned < SCAN_LIMIT)) {
  const { data, error } = await supabase
    .from("works_priority_view")
    .select("id, priority_score")
    .order("priority_score", { ascending: false })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`priority view page from=${from}: ${error.message}`);
  if (!data || data.length === 0) break;

  const unseen = data.filter((candidate) => !already.has(candidate.id));

  if (PROFILE === "all") {
    for (const candidate of unseen) {
      fresh.push({
        id: candidate.id,
        priority_score: candidate.priority_score,
        original_priority_score: candidate.priority_score,
        econScore: null,
        reasons: ["profile:all"],
      });
      already.add(candidate.id);
      if (fresh.length >= LIMIT) break;
    }
  } else {
    const workMap = await fetchWorksByIds(unseen.map((candidate) => candidate.id));
    for (const candidate of unseen) {
      const work = workMap.get(candidate.id);
      if (!work) continue;
      const scored = computeEvidencePriority(work, candidate.priority_score, { goldSignals });
      scanned++;
      if (isEconEligible(scored, MIN_ECON_SCORE)) {
        fresh.push({
          id: candidate.id,
          priority_score: scored.finalPriority,
          original_priority_score: candidate.priority_score,
          econScore: scored.econScore,
          reasons: scored.reasons,
        });
        already.add(candidate.id);
      }
      if (fresh.length >= LIMIT || scanned >= SCAN_LIMIT) break;
    }
  }

  if (data.length < PAGE) break;
  from += PAGE;
}

fresh.sort((a, b) => b.priority_score - a.priority_score);
if (fresh.length > LIMIT) fresh.length = LIMIT;

if (fresh.length === 0) {
  console.log("[enqueue] nothing to enqueue - all candidates are processed or below profile threshold");
  process.exit(0);
}

if (fresh.length < LIMIT) {
  console.warn(`[enqueue] WARN: only ${fresh.length} fresh candidates (asked ${LIMIT})`);
}

console.log(
  `[enqueue] inserting ${fresh.length} rows ` +
  `(top score: ${fresh[0].priority_score?.toFixed(2)}, ` +
  `bottom: ${fresh.at(-1).priority_score?.toFixed(2)})`,
);
if (PROFILE === "econ") {
  console.log("[enqueue] top econ candidates:");
  for (const row of fresh.slice(0, 5)) {
    console.log(
      `  ${row.id} econ=${row.econScore?.toFixed(1)} ` +
      `base=${Number(row.original_priority_score ?? 0).toFixed(2)} ` +
      `reasons=${row.reasons?.slice(0, 4).join("|") || "-"}`,
    );
  }
}

let inserted = 0;
for (let i = 0; i < fresh.length; i += PAGE) {
  const chunk = fresh.slice(i, i + PAGE).map((candidate) => ({
    work_id: candidate.id,
    priority_score: candidate.priority_score,
    state: "queued",
  }));
  const { error } = await supabase
    .from("extraction_queue")
    .upsert(chunk, { onConflict: "work_id", ignoreDuplicates: true, defaultToNull: true });
  if (error) throw new Error(`insert chunk ${i}: ${error.message}`);
  inserted += chunk.length;
  process.stdout.write(`  +${chunk.length} (${inserted}/${fresh.length})\n`);
}

console.log(`\n[enqueue] DONE - ${inserted} rows inserted into extraction_queue`);
if (PROFILE === "econ") {
  console.log(`[enqueue] scanned ${scanned} priority-view candidates for econ relevance`);
}
console.log("[enqueue] Worker should claim within 5s and start processing.");
