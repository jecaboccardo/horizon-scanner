#!/usr/bin/env node
/**
 * Fill missing evidence_cards.study_design from works.methodology_design.
 *
 * The evidence-card extractor stores a card-level `study_design`, while the
 * SMS classifiers store work-level `methodology_design` and `sms_level`.
 * When card extraction cannot infer design but the work-level classifier did,
 * use the work-level value as a conservative fallback.
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const PAGE = 1000;

function normalizeDesign(methodology, smsLevel) {
  const m = String(methodology || "").trim().toLowerCase();
  if (!m) return null;
  if (m === "rct" || m.includes("random")) return "RCT";
  if ([
    "did",
    "iv",
    "rdd",
    "syntheticcontrol",
    "synthetic control",
    "naturalexperiment",
    "natural experiment",
    "psm",
    "matching",
    "fixedeffects",
    "fixed effects",
    "panel",
  ].includes(m)) return "quasi-experimental";
  if (m.includes("difference") || m.includes("instrument") || m.includes("discontinuity")) return "quasi-experimental";
  if (m.includes("fixed") || m.includes("panel") || m.includes("matching") || Number(smsLevel) >= 3) return "quasi-experimental";
  if (m === "observational" || m === "survey" || m === "predictive") return "observational";
  if (m === "qualitative") return "qualitative";
  if (m === "review") return "review";
  if (m === "theoretical") return "theoretical";
  if (m === "simulation") return "theoretical";
  if (m === "descriptive" || m === "other") return "descriptive";
  return methodology;
}

async function main() {
  console.log("\n=== Evidence-card study_design fallback from works ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? "(unlimited)" : LIMIT}\n`);

  let from = 0;
  let scanned = 0;
  let updated = 0;
  const byDesign = new Map();

  while (scanned < LIMIT) {
    const remaining = Math.min(PAGE, LIMIT - scanned);
    const { data, error } = await supabase
      .from("evidence_cards")
      .select("id,work_id,study_design,works!inner(methodology_design,sms_level)")
      .is("study_design", null)
      .not("works.methodology_design", "is", null)
      .range(from, from + remaining - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const row of data) {
      scanned++;
      const design = normalizeDesign(row.works?.methodology_design, row.works?.sms_level);
      if (!design) continue;
      byDesign.set(design, (byDesign.get(design) || 0) + 1);
      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from("evidence_cards")
          .update({
            study_design: design,
            extracted_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (updateError) {
          console.error(`  update failed ${row.work_id}: ${updateError.message}`);
          continue;
        }
      }
      updated++;
    }
    process.stdout.write(`\r  scanned ${scanned} | ${DRY_RUN ? "would update" : "updated"} ${updated}`);
    if (data.length < remaining) break;
    from += remaining;
  }

  console.log("\n");
  console.log(JSON.stringify({
    dry_run: DRY_RUN,
    scanned,
    updated,
    by_design: Object.fromEntries([...byDesign.entries()].sort((a, b) => b[1] - a[1])),
  }, null, 2));
}

main().catch((err) => {
  console.error("[card-study-design-fallback] failed:", err.message);
  process.exit(1);
});
