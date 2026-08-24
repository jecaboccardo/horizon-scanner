#!/usr/bin/env node
/**
 * Deterministic SMS=0 classification for theory/review papers.
 *
 * Papers that are definitionally non-empirical (systematic reviews,
 * meta-analyses, theoretical models, handbooks) should have sms_level=0
 * but currently have null because the Qwen SMS classifier was never run
 * on them (it can't run without an abstract, and many lack one).
 *
 * This script tags them via title patterns and abstract-opening signals
 * that unambiguously indicate a non-empirical paper. Gap-only: never
 * overwrites a non-null sms_level.
 *
 * Usage:
 *   node scripts/classify-sms-deterministic.mjs --dry-run
 *   node scripts/classify-sms-deterministic.mjs --limit 5000
 *   node scripts/classify-sms-deterministic.mjs --limit 5000 --batch-size 200
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const argv = process.argv;
const DRY_RUN = argv.includes("--dry-run");
const LIMIT = Number(argv[argv.indexOf("--limit") + 1] || 0) || Infinity;
const BATCH_SIZE = Number(argv[argv.indexOf("--batch-size") + 1] || 0) || 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pattern sets — all HIGH-CONFIDENCE non-empirical signals
// ---------------------------------------------------------------------------

// Title patterns: regex against the full title (case-insensitive).
// Each pattern produces sms_level=0. Patterns ordered: most specific first.
const TITLE_PATTERNS = [
  // Explicit review/synthesis types
  { re: /\bsystematic review\b/i, reason: "title:systematic_review" },
  { re: /\bmeta.analysis\b/i, reason: "title:meta_analysis" },
  { re: /\bscoping review\b/i, reason: "title:scoping_review" },
  { re: /\bnarrative review\b/i, reason: "title:narrative_review" },
  { re: /\breview of the literature\b/i, reason: "title:review_of_literature" },
  { re: /\bliterature review\b/i, reason: "title:literature_review" },
  { re: /\ba survey of (the\s+)?(literature|evidence|research)\b/i, reason: "title:survey_literature" },
  // Reference/compilation works
  { re: /\bhandbook of\b/i, reason: "title:handbook" },
  { re: /\bcompendium of\b/i, reason: "title:compendium" },
  // Theoretical/formal
  { re: /\btheoretical (model|framework|analysis|approach)\b/i, reason: "title:theoretical_model" },
  { re: /\ba theory of\b/i, reason: "title:a_theory_of" },
  // Only match "theory of X" when it clearly describes a formal paper, not
  // empirical work that tests a theory
  { re: /^(a\s+)?(general\s+)?theory of\s+/i, reason: "title:theory_of_start" },
];

// Abstract-opening patterns (first 300 chars): definitively non-empirical
const ABSTRACT_PATTERNS = [
  { re: /^(this\s+)?(paper|article|study|chapter)\s+(reviews?|surveys?|synthesizes?|provides an overview|summarizes?|provides a survey)\b/i, reason: "abstract:review_opening" },
  { re: /^we\s+(review|survey|synthesize|examine the literature on|provide an overview of)\b/i, reason: "abstract:we_review" },
  { re: /^this\s+(systematic review|meta-analysis|literature review|scoping review|narrative review)\b/i, reason: "abstract:systematic_review_opening" },
  { re: /^in this\s+(review|survey|meta-analysis|systematic review)\b/i, reason: "abstract:in_this_review" },
  { re: /\bwe\s+(construct|develop|propose|present)\s+a\s+(formal\s+)?(theoretical\s+)?(model|framework)\b/i, reason: "abstract:we_propose_model" },
  { re: /^we\s+(construct|develop|build|propose)\s+a\s+(model|theory)\b/i, reason: "abstract:we_build_model" },
  { re: /\bthis\s+(paper|article)\s+(develops?|presents?|proposes?|introduces?)\s+(a|an)\s+(theoretical|formal|stylized)\s+(model|framework)\b/i, reason: "abstract:paper_develops_model" },
];

// Publication type → SMS=0 (reviews and editorials are non-empirical by definition)
const REVIEW_PUB_TYPES = new Set(["review", "commentary", "editorial"]);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
function classify(paper) {
  const title = String(paper.title ?? "");
  for (const { re, reason } of TITLE_PATTERNS) {
    if (re.test(title)) return reason;
  }
  if (REVIEW_PUB_TYPES.has(paper.publication_type)) {
    return "pub_type:" + paper.publication_type;
  }
  const absOpen = String(paper.abstract ?? "").slice(0, 300);
  if (absOpen) {
    for (const { re, reason } of ABSTRACT_PATTERNS) {
      if (re.test(absOpen)) return reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("=== Deterministic SMS=0 classifier ===");
console.log("Dry run:", DRY_RUN, "| Limit:", LIMIT === Infinity ? "none" : LIMIT, "| Batch:", BATCH_SIZE);

// Fetch null-SMS non-noise canonical papers in batches
let processed = 0, tagged = 0, offset = 0;
const byReason = {};

while (processed < LIMIT) {
  const batchLimit = Math.min(BATCH_SIZE, LIMIT - processed);
  const { data, error } = await sb.from("works")
    .select("id,title,abstract,publication_type,raw_data,sms_level")
    .is("sms_level", null)
    .not("is_noise", "is", true)
    .is("canonical_work_id", null)
    .range(offset, offset + batchLimit - 1);

  if (error) { console.error("Fetch error:", error.message); break; }
  if (!data || data.length === 0) break;

  const toUpdate = [];
  for (const paper of data) {
    const reason = classify(paper);
    if (!reason) continue;
    toUpdate.push({ id: paper.id, reason });
    byReason[reason] = (byReason[reason] || 0) + 1;
    tagged++;
  }

  if (!DRY_RUN && toUpdate.length > 0) {
    // Update in a single upsert chunk
    const updates = toUpdate.map(({ id, reason }) => ({
      id,
      sms_level: 0,
      raw_data: { sms_method: "rule_theory_review", sms_reason: reason, sms_classified_at: new Date().toISOString() },
    }));
    // Use per-row update to merge raw_data without clobbering existing fields
    for (const u of updates) {
      const { data: existing } = await sb.from("works").select("raw_data").eq("id", u.id).single();
      const mergedRaw = { ...(existing?.raw_data || {}), ...u.raw_data };
      await sb.from("works").update({ sms_level: 0, raw_data: mergedRaw }).eq("id", u.id).is("sms_level", null);
    }
    console.log(`  [+] batch offset=${offset}: ${toUpdate.length} tagged`);
  } else if (DRY_RUN && toUpdate.length > 0) {
    for (const { id, reason } of toUpdate.slice(0, 3)) {
      const p = data.find((x) => x.id === id);
      console.log(`  [dry] ${reason}: ${String(p?.title ?? "").slice(0, 70)}`);
    }
    if (toUpdate.length > 3) console.log(`  [dry] ... and ${toUpdate.length - 3} more in this batch`);
  }

  processed += data.length;
  offset += data.length;
  if (data.length < batchLimit) break; // end of results
  await sleep(200);
}

console.log(`\n=== Done: processed=${processed} tagged=${tagged} (${DRY_RUN ? "dry-run, no writes" : "written"}) ===`);
console.log("By reason:", JSON.stringify(byReason, null, 2));
