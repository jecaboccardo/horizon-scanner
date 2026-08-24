// scripts/jel-survey/enrich-evidence.mjs
//
// JEL Skill 2.5 — Tier-2 evidence enricher (the JEL-scoped front-end to the
// existing scripts/tier2-upgrade-worker.mjs).
//
// The Tier-1 worker extracts cards from abstracts. Abstracts elide what a JEL
// survey needs: exact effect sizes, identification strategy (RDD cutoff,
// IV first-stage F, parallel-trends test), sample composition, robustness
// checks, mechanism, external-validity caveats. Those live in the paper's
// methods + results + discussion sections.
//
// This script scopes the existing tier-2 PDF re-extraction queue to ONLY the
// evidence rows that JEL drafts will actually cite. Enqueues them at high
// priority so the worker drains them first. After the worker runs, re-running
// build-evidence-coding.mjs produces a richer sheet.
//
// Usage:
//   node --env-file=.env scripts/jel-survey/enrich-evidence.mjs
//   node --env-file=.env scripts/jel-survey/enrich-evidence.mjs --only ai-automation-labor
//   node --env-file=.env scripts/jel-survey/enrich-evidence.mjs --priority 400
//   node --env-file=.env scripts/jel-survey/enrich-evidence.mjs --dry-run
//
// After this script, run the worker to drain:
//   node --env-file=.env scripts/tier2-upgrade-worker.mjs
//
// Or use --run-worker to spawn the worker inline once enqueueing completes.

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function parseArgs(argv) {
  const out = { only: null, priority: 300, dryRun: false, includeNoPdf: false };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i], n = argv[i + 1];
    if (f === "--only") { out.only = n; i++; }
    else if (f === "--priority") { out.priority = Number(n); i++; }
    else if (f === "--dry-run") { out.dryRun = true; }
    else if (f === "--include-no-pdf") { out.includeNoPdf = true; }
  }
  return out;
}

function isUsableText(v, minLen = 3) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s.length < minLen) return false;
  if (["unclear", "unknown", "n/a", "na", "none", "null"].includes(s)) return false;
  return !s.includes("unclear");
}

// Mirrors enqueue-tier2-card-upgrades.mjs targetFields() — keeps the upgrade
// worker pointed at the same fields the JEL drafter actually needs.
function targetFields(card) {
  const t = [];
  if (!isUsableText(card.effect_size_text)) t.push("effect_size_text");
  if (!isUsableText(card.statistical_significance)) t.push("statistical_significance");
  if (!Number.isFinite(Number(card.sample_size)) || Number(card.sample_size) <= 0) t.push("sample_size");
  if (!isUsableText(card.treatment_group)) t.push("treatment_group");
  if (!isUsableText(card.control_group)) t.push("control_group");
  if (!isUsableText(card.identification_strategy)) t.push("identification_strategy");
  if (!isUsableText(card.mechanism)) t.push("mechanism");
  if (!isUsableText(card.heterogeneity)) t.push("heterogeneity");
  const dir = String(card.effect_direction ?? "").trim().toLowerCase();
  if (!["positive", "negative", "null", "mixed"].includes(dir)) t.push("effect_direction");
  return t;
}

function sourceHint(work) {
  if (isUsableText(work.open_access_pdf_url, 10)) return "open_access_pdf";
  const text = `${work.source ?? ""} ${work.venue ?? ""} ${work.url ?? ""}`.toLowerCase();
  if (/\b(iadb|idb|world bank|nber|ssrn|iza|cepr|repec|oecd)\b/.test(text)) return "institution_page";
  if (isUsableText(work.canonical_doi, 5)) return "doi";
  if (isUsableText(work.url, 10)) return "publisher_page";
  return "unknown";
}

async function main() {
  const args = parseArgs(process.argv);

  // 1. Collect JEL evidence work_ids from coding sheets
  const sheetNames = ["cash-transfers-education-lac", "ai-automation-labor", "informality-lac"];
  const allEvidence = new Set();
  for (const s of sheetNames) {
    if (args.only && s !== args.only) continue;
    const path = resolve(ROOT, `reports/evidence-coding-${s}-2026-05-20.json`);
    const sheet = JSON.parse(await readFile(path, "utf8"));
    // Use indexes — only papers in the evidence set (admitted, not just candidate).
    // The papers array includes both; filter by isEvidence.
    for (const p of sheet.papers ?? []) {
      if (p.isEvidence) allEvidence.add(p.workId);
    }
  }
  const workIds = [...allEvidence];
  console.log(`[enrich] JEL evidence universe: ${workIds.length} work_ids`);

  // 2. Fetch existing cards for those work_ids (we only enrich what has a tier-1 card)
  const CHUNK = 100;
  const cards = [];
  for (let i = 0; i < workIds.length; i += CHUNK) {
    const slice = workIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from("evidence_cards")
      .select("id, work_id, confidence, confidence_score, effect_direction, effect_size_text, statistical_significance, sample_size, treatment_group, control_group, identification_strategy, mechanism, heterogeneity, study_design, intervention, outcome")
      .in("work_id", slice);
    if (error) throw new Error(`evidence_cards: ${error.message}`);
    cards.push(...(data ?? []));
  }
  const cardByWork = new Map(cards.map((c) => [c.work_id, c]));
  console.log(`[enrich] cards available: ${cards.length} / ${workIds.length}`);

  // 3. Fetch works for PDF / source-hint info
  const works = new Map();
  for (let i = 0; i < workIds.length; i += CHUNK) {
    const slice = workIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from("works")
      .select("id, open_access_pdf_url, url, canonical_doi, venue, source")
      .in("id", slice);
    if (error) throw new Error(`works: ${error.message}`);
    for (const w of (data ?? [])) works.set(w.id, w);
  }

  // 4. Fetch already-queued so we don't duplicate-upsert (upsert handles dupes, but
  // we want to compare counts to give the user clear feedback).
  const { data: existingQ, error: qErr } = await sb.from("evidence_card_upgrade_queue")
    .select("work_id, state, priority_score").in("work_id", workIds);
  if (qErr) throw new Error(`upgrade queue: ${qErr.message}`);
  const queueByWork = new Map((existingQ ?? []).map((r) => [r.work_id, r]));

  // 5. Filter to papers that need enrichment + have a usable source
  const candidates = [];
  const skipped = { noCard: 0, noTargets: 0, noPdf: 0, alreadyDone: 0 };

  for (const workId of workIds) {
    const card = cardByWork.get(workId);
    const work = works.get(workId);
    if (!card) { skipped.noCard++; continue; }
    if (!work) { skipped.noCard++; continue; }
    const targets = targetFields(card);
    if (targets.length === 0) { skipped.noTargets++; continue; }
    if (!args.includeNoPdf && !isUsableText(work.open_access_pdf_url, 10)) { skipped.noPdf++; continue; }
    const existing = queueByWork.get(workId);
    if (existing && existing.state === "done") { skipped.alreadyDone++; continue; }

    candidates.push({
      work_id: workId,
      evidence_card_id: card.id,
      priority_score: args.priority,
      state: "queued",
      target_fields: targets,
      source_hint: sourceHint(work),
      reasons: ["jel-evidence", `targets:${targets.length}`, card.confidence ?? "?"],
      // started_at / attempts reset so worker re-tries if previously failed
      attempts: 0,
      started_at: null,
      completed_at: null,
      last_error: null,
    });
  }

  console.log(`[enrich] enrichment candidates: ${candidates.length}`);
  console.log(`[enrich] skipped: ${JSON.stringify(skipped)}`);

  // Show distribution of target fields
  const fieldCounts = {};
  for (const c of candidates) for (const f of c.target_fields) fieldCounts[f] = (fieldCounts[f] || 0) + 1;
  console.log(`[enrich] missing-field distribution: ${JSON.stringify(fieldCounts)}`);

  if (args.dryRun) {
    console.log(`[enrich] dry-run — nothing written.`);
    console.log(`[enrich] top 5 candidates:`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${c.work_id} targets=[${c.target_fields.join(",")}] source=${c.source_hint}`);
    }
    return;
  }

  // 6. Upsert into evidence_card_upgrade_queue
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const { error } = await sb.from("evidence_card_upgrade_queue")
      .upsert(batch, { onConflict: "work_id" });
    if (error) throw new Error(`upgrade queue upsert at ${i}: ${error.message}`);
  }

  console.log(`[enrich] enqueued ${candidates.length} JEL-evidence cards for Tier-2 upgrade.`);
  console.log(`[enrich] Next: run \`node --env-file=.env scripts/tier2-upgrade-worker.mjs\` to drain.`);
  console.log(`[enrich] After worker drains: rerun \`node scripts/jel-survey/build-evidence-coding.mjs --all\` to get the enriched coding sheets.`);
}

main().catch((err) => {
  console.error("[enrich] fatal:", err);
  process.exit(1);
});
