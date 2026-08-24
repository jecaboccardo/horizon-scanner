#!/usr/bin/env node
/**
 * Tag generic non-primary rows (discussion/editorial/front matter) as
 * commentary and remove them from evidence-card queues.
 *
 * Dry-run by default. Use --confirm to write changes.
 *
 * Usage:
 *   node scripts/tag-generic-commentary-works.mjs --dry-run
 *   node scripts/tag-generic-commentary-works.mjs --confirm
 *   node scripts/tag-generic-commentary-works.mjs --verify-only
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  GENERIC_NON_PRIMARY_REASON,
  isGenericNonPrimaryTitle,
} from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[generic-commentary] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CONFIRM = process.argv.includes("--confirm");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const DRY_RUN = (!CONFIRM || process.argv.includes("--dry-run")) && !VERIFY_ONLY;
const PAGE = Number(process.env.GENERIC_COMMENTARY_PAGE || "1000");
const CHUNK = Number(process.env.GENERIC_COMMENTARY_CHUNK || "100");
const COUNT_CHUNK = Number(process.env.GENERIC_COMMENTARY_COUNT_CHUNK || "25");
const TITLE_VARIANTS = [
  "General Discussion",
  "Comments and Discussion",
  "Comment and Discussion",
  "Discussion",
  "Editor's Introduction",
  "Editors' Introduction",
  "Editor’s Introduction",
  "Editors’ Introduction",
  "Introduction",
  "Front Matter",
  "Back Matter",
  "Book Review",
  "Book Reviews",
  "Editor's Summary",
  "Editors' Summary",
  "Editorâ€™s Summary",
  "Editorsâ€™ Summary",
];
const TITLE_ILIKE_PATTERNS = [
  "%Index%",
  "%Editor%Summary%",
  "%Editors%Summary%",
  "Panel on %",
  "%Vernon Prize Committee%",
];

async function fetchPage(from) {
  const { data, error } = await supabase
    .from("works")
    .select("id,title,year,venue,abstract,publication_type,venue_kind,raw_data,citation_count")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`works fetch: ${error.message}`);
  return data || [];
}

async function fetchAllTargets() {
  const targets = new Map();
  const collect = (rows) => {
    for (const row of rows || []) {
      if (isGenericNonPrimaryTitle(row.title)) targets.set(row.id, row);
    }
  };
  for (let i = 0; i < TITLE_VARIANTS.length; i += CHUNK) {
    const titleChunk = TITLE_VARIANTS.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("works")
        .select("id,title,year,venue,abstract,publication_type,venue_kind,raw_data,citation_count")
        .in("title", titleChunk)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`works title fetch: ${error.message}`);
      collect(data);
      if (!data || data.length < PAGE) break;
    }
  }
  for (const pattern of TITLE_ILIKE_PATTERNS) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("works")
        .select("id,title,year,venue,abstract,publication_type,venue_kind,raw_data,citation_count")
        .ilike("title", pattern)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`works title pattern fetch: ${error.message}`);
      collect(data);
      if (!data || data.length < PAGE) break;
    }
  }
  return [...targets.values()];
}

async function deleteFrom(table, column, ids) {
  let affected = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await supabase.from(table).delete().in(column, chunk);
    if (error) throw new Error(`${table} delete: ${error.message}`);
    affected += chunk.length;
  }
  return affected;
}

async function markCardsUnusable(ids) {
  let affected = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("evidence_cards")
      .update({
        needs_review: true,
        card_usable_for_ranking: false,
      })
      .in("work_id", chunk);
    if (error && !/card_usable_for_ranking/i.test(error.message)) {
      throw new Error(`evidence_cards update: ${error.message}`);
    }
    affected += chunk.length;
  }
  return affected;
}

async function countRows(table, column, ids, applyFilter = (q) => q) {
  let count = 0;
  for (let i = 0; i < ids.length; i += COUNT_CHUNK) {
    const chunk = ids.slice(i, i + COUNT_CHUNK);
    const query = applyFilter(supabase.from(table).select(column, { count: "exact", head: true }).in(column, chunk));
    const { count: chunkCount, error } = await query;
    if (error) throw new Error(`${table} count: ${error.message || JSON.stringify(error)}`);
    count += chunkCount || 0;
  }
  return count;
}

async function verifyTargets(targets, ids) {
  const tagged = targets.filter((row) => row.venue_kind === "commentary").length;
  const excluded = targets.filter((row) => row.raw_data?.excluded_from_evidence === true).length;
  const reasoned = targets.filter((row) => row.raw_data?.excluded_reason === GENERIC_NON_PRIMARY_REASON).length;
  const abstractPresent = targets.filter((row) => String(row.abstract || "").trim()).length;
  const inExtractionQueue = await countRows("extraction_queue", "work_id", ids);
  const inUpgradeQueue = await countRows("evidence_card_upgrade_queue", "work_id", ids).catch((err) => {
    if (/relation .* does not exist/i.test(err.message)) return 0;
    throw err;
  });

  console.log("\nVerification:");
  console.log(`  venue_kind=commentary: ${tagged}/${targets.length}`);
  console.log(`  raw_data.excluded_from_evidence=true: ${excluded}/${targets.length}`);
  console.log(`  raw_data.excluded_reason set: ${reasoned}/${targets.length}`);
  console.log(`  abstracts still present: ${abstractPresent}`);
  console.log(`  extraction_queue remaining: ${inExtractionQueue}`);
  console.log(`  evidence_card_upgrade_queue remaining: ${inUpgradeQueue}`);
}

async function updateWorks(rows) {
  let updated = 0;
  for (const row of rows) {
    const patch = {
      abstract: null,
      publication_type: "other",
      publication_type_method: "generic_title_policy",
      publication_type_confidence: 0.99,
      venue_kind: "commentary",
      raw_data: {
        ...(row.raw_data || {}),
        excluded_from_evidence: true,
        excluded_reason: GENERIC_NON_PRIMARY_REASON,
        generic_title_policy: {
          matched_at: new Date().toISOString(),
          original_publication_type: row.publication_type ?? null,
          original_venue_kind: row.venue_kind ?? null,
          original_abstract_present: Boolean(String(row.abstract || "").trim()),
        },
      },
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("works").update(patch).eq("id", row.id);
    if (error) throw new Error(`works update ${row.id}: ${error.message}`);
    updated += 1;
    if (updated % 250 === 0) console.log(`[generic-commentary] tagged ${updated}/${rows.length}`);
  }
  return updated;
}

async function main() {
  console.log("\n=== Tag Generic Commentary Works ===");
  console.log(`Mode: ${VERIFY_ONLY ? "verify-only" : DRY_RUN ? "dry-run" : "CONFIRMED UPDATE"}`);
  console.log(`Reason: ${GENERIC_NON_PRIMARY_REASON}\n`);

  const targets = await fetchAllTargets();
  const ids = targets.map((row) => row.id);
  const byTitle = new Map();
  for (const row of targets) byTitle.set(row.title, (byTitle.get(row.title) || 0) + 1);

  console.log(`Targets: ${targets.length}`);
  console.log("Top matched titles:");
  for (const [title, count] of [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${count.toLocaleString()}  ${title}`);
  }
  console.log("Sample:");
  for (const row of targets.slice(0, 10)) {
    console.log(`  ${row.year || "?"} ${row.id} :: ${row.title}`);
  }

  if (DRY_RUN) {
    console.log("\nDry run only. Re-run with --confirm to tag rows and remove queue entries.");
    return;
  }

  if (VERIFY_ONLY) {
    await verifyTargets(targets, ids);
    return;
  }

  const updatedWorks = await updateWorks(targets);
  const queueDeleted = await deleteFrom("extraction_queue", "work_id", ids);
  const upgradeDeleted = await deleteFrom("evidence_card_upgrade_queue", "work_id", ids).catch((err) => {
    if (/relation .* does not exist/i.test(err.message)) return 0;
    throw err;
  });
  const cardsMarked = await markCardsUnusable(ids).catch((err) => {
    if (/column .*card_usable_for_ranking/i.test(err.message)) return 0;
    throw err;
  });

  console.log("\nUpdated:");
  console.log(`  works tagged: ${updatedWorks}`);
  console.log(`  extraction_queue rows removed/checks: ${queueDeleted}`);
  console.log(`  evidence_card_upgrade_queue rows removed/checks: ${upgradeDeleted}`);
  console.log(`  evidence_cards marked unusable/checks: ${cardsMarked}`);
  await verifyTargets(await fetchAllTargets(), ids);
}

main().catch((err) => {
  console.error("[generic-commentary] failed:", err);
  process.exit(1);
});
