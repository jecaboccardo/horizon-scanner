#!/usr/bin/env node
/**
 * Fill missing works.sms_level / methodology_design from evidence_cards.study_design.
 *
 * This is the reverse of the card fallback: if card extraction already found a
 * study design, keep work-level SMS metadata in sync so retrieval, filters, and
 * evidence tables all see the same method signal.
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

function mapStudyDesign(studyDesign) {
  const s = String(studyDesign || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "rct" || s.includes("random")) {
    return { sms_level: 5, methodology_design: "RCT", causal_strength: "high" };
  }
  if (s.includes("quasi") || s.includes("did") || s.includes("iv") || s.includes("rdd") ||
      s.includes("synthetic") || s.includes("matching") || s.includes("fixed") || s.includes("panel")) {
    return { sms_level: 4, methodology_design: "QuasiExperimental", causal_strength: "high" };
  }
  if (s === "observational" || s === "survey" || s === "predictive") {
    return { sms_level: 2, methodology_design: "Observational", causal_strength: "limited" };
  }
  if (s === "qualitative") {
    return { sms_level: 1, methodology_design: "Qualitative", causal_strength: "limited" };
  }
  if (s === "review") {
    return { sms_level: 0, methodology_design: "Review", causal_strength: "not_applicable" };
  }
  if (s === "theoretical") {
    return { sms_level: 0, methodology_design: "Theoretical", causal_strength: "not_applicable" };
  }
  if (s === "descriptive") {
    return { sms_level: 1, methodology_design: "Descriptive", causal_strength: "limited" };
  }
  return { sms_level: 1, methodology_design: studyDesign, causal_strength: "limited" };
}

async function main() {
  console.log("\n=== Works SMS fallback from evidence_cards.study_design ===");
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
      .select("work_id,study_design,works!inner(id,sms_level,methodology_design)")
      .not("study_design", "is", null)
      .or("sms_level.is.null,methodology_design.is.null", { referencedTable: "works" })
      .range(from, from + remaining - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const row of data) {
      scanned++;
      const mapped = mapStudyDesign(row.study_design);
      if (!mapped) continue;
      byDesign.set(mapped.methodology_design, (byDesign.get(mapped.methodology_design) || 0) + 1);
      if (!DRY_RUN) {
        const patch = {
          sms_level: row.works?.sms_level ?? mapped.sms_level,
          methodology_design: row.works?.methodology_design ?? mapped.methodology_design,
          causal_strength: mapped.causal_strength,
          sms_method: "evidence_card_fallback",
          sms_rationale: `Filled from evidence_cards.study_design=${row.study_design}`,
          updated_at: new Date().toISOString(),
        };
        const { error: updateError } = await supabase
          .from("works")
          .update(patch)
          .eq("id", row.work_id);
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
  console.error("[works-sms-card-fallback] failed:", err.message);
  process.exit(1);
});
