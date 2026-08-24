#!/usr/bin/env node
/**
 * Enqueue Tier 2 evidence-card upgrades.
 *
 * This only writes rows into evidence_card_upgrade_queue. It does not fetch
 * PDFs or call an LLM, so it should not slow SMS/design backfill or Tier 1
 * card extraction. Tier 2 work starts only when a separate upgrade worker is
 * launched.
 *
 * Usage:
 *   node scripts/enqueue-tier2-card-upgrades.mjs --limit 1000
 *   node scripts/enqueue-tier2-card-upgrades.mjs --limit 1000 --dry-run
 *   node scripts/enqueue-tier2-card-upgrades.mjs --limit 3000 --include-no-pdf
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import {
  computeEvidencePriority,
  EVIDENCE_PRIORITY_SELECT,
  isEconEligible,
  loadGoldSignals,
} from "./lib/evidence-priority.mjs";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[tier2-enqueue] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const LIMIT = Number(argValue("--limit", "1000"));
const SCAN_LIMIT = Number(argValue("--scan-limit", String(Math.min(80_000, Math.max(LIMIT * 8, LIMIT)))));
const MIN_ECON_SCORE = Number(argValue("--min-econ-score", "3"));
const INCLUDE_NO_PDF = hasFlag("--include-no-pdf");
const INCLUDE_NOT_RANKING_USABLE = hasFlag("--include-not-ranking-usable");
const INCLUDE_BLOCKED_PDF_HOSTS = hasFlag("--include-blocked-pdf-hosts");
const DRY_RUN = hasFlag("--dry-run");

if (!Number.isFinite(LIMIT) || LIMIT <= 0 || LIMIT > 300_000) {
  console.error(`[tier2-enqueue] Invalid --limit: ${LIMIT} (must be 1..300000)`);
  process.exit(1);
}

const PAGE = 1000;
const WORK_PAGE = 80;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const goldSignals = loadGoldSignals();

function isUsableText(value, minLength = 3) {
  if (value == null) return false;
  const text = String(value).trim();
  if (text.length < minLength) return false;
  const lower = text.toLowerCase();
  if (["unclear", "unknown", "n/a", "na", "none", "null"].includes(lower)) return false;
  return !lower.includes("unclear");
}

const BLOCKED_PDF_HOST_PATTERNS = [
  /(^|\.)aeaweb\.org$/i,
  /(^|\.)academic\.oup\.com$/i,
  /(^|\.)journals\.sagepub\.com$/i,
  /(^|\.)publications\.iadb\.org$/i,
  /(^|\.)openknowledge\.worldbank\.org$/i,
  /(^|\.)doi\.org$/i,
  /(^|\.)dx\.doi\.org$/i,
];

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isKnownBlockedPdfHost(url) {
  const host = hostnameOf(url);
  return !!host && BLOCKED_PDF_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function hasBrowserFreePdfHint(work) {
  const pdf = String(work.open_access_pdf_url || "").trim();
  if (!isUsableText(pdf, 10)) return false;
  return !isKnownBlockedPdfHost(pdf);
}

function targetFields(card) {
  const targets = [];
  if (!isUsableText(card.effect_size_text)) targets.push("effect_size_text");
  if (!isUsableText(card.statistical_significance)) targets.push("statistical_significance");
  if (!Number.isFinite(Number(card.sample_size)) || Number(card.sample_size) <= 0) targets.push("sample_size");
  if (!isUsableText(card.treatment_group)) targets.push("treatment_group");
  if (!isUsableText(card.control_group)) targets.push("control_group");
  const direction = String(card.effect_direction ?? "").trim().toLowerCase();
  if (!["positive", "negative", "null", "mixed"].includes(direction)) targets.push("effect_direction");
  return targets;
}

async function fetchExistingQueueIds() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("evidence_card_upgrade_queue")
      .select("work_id")
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(
        `evidence_card_upgrade_queue fetch failed: ${error.message}. ` +
        "Apply supabase/migrations/20260519000002_evidence_card_upgrade_queue.sql first.",
      );
    }
    for (const row of data ?? []) ids.add(row.work_id);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

async function fetchCards() {
  const rows = [];
  let from = 0;
  while (rows.length < SCAN_LIMIT) {
    const remaining = Math.min(PAGE, SCAN_LIMIT - rows.length);
    let query = supabase
      .from("evidence_cards")
      .select([
        "id",
        "work_id",
        "confidence",
        "confidence_score",
        "needs_review",
        "card_usable_for_ranking",
        "effect_direction",
        "effect_size_text",
        "statistical_significance",
        "sample_size",
        "treatment_group",
        "control_group",
        "intervention",
        "outcome",
        "study_design",
        "extracted_at",
      ].join(","))
      .eq("confidence", "low")
      .order("extracted_at", { ascending: false })
      .range(from, from + remaining - 1);

    if (!INCLUDE_NOT_RANKING_USABLE) {
      query = query.eq("card_usable_for_ranking", true);
    }

    const { data, error } = await query;
    if (error) throw new Error(`evidence_cards fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < remaining) break;
    from += remaining;
  }
  return rows;
}

async function fetchWorksByIds(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += WORK_PAGE) {
    const chunk = ids.slice(i, i + WORK_PAGE);
    const { data, error } = await supabase
      .from("works")
      .select(EVIDENCE_PRIORITY_SELECT)
      .in("id", chunk);
    if (error) throw new Error(`works fetch failed at ${i}: ${error.message}`);
    for (const row of data ?? []) out.set(row.id, row);
  }
  return out;
}

function sourceHint(work) {
  if (hasBrowserFreePdfHint(work)) return "open_access_pdf";
  if (isKnownBlockedPdfHost(work.open_access_pdf_url)) return "blocked_pdf_host";
  const text = `${work.source ?? ""} ${work.venue ?? ""} ${work.url ?? ""}`.toLowerCase();
  if (/\b(iadb|idb|world bank|nber|ssrn|iza|cepr|repec|oecd)\b/.test(text)) return "institution_page";
  if (isUsableText(work.canonical_doi, 5)) return "doi";
  if (isUsableText(work.url, 10)) return "publisher_page";
  return "unknown";
}

function priorityFor(card, work) {
  const citationBase = Math.min(12, Math.log1p(Number(work.citation_count ?? 0)) * 1.5);
  const scored = computeEvidencePriority(work, citationBase, { goldSignals });
  const targets = targetFields(card);
  const reasons = [...scored.reasons];

  if (card.card_usable_for_ranking) reasons.push("usable-for-ranking");
  if (hasBrowserFreePdfHint(work)) reasons.push("pdf");
  if (isKnownBlockedPdfHost(work.open_access_pdf_url)) reasons.push("blocked-pdf-host");
  if (Number(work.year) >= 2010) reasons.push("post-2010");
  if (targets.length <= 3) reasons.push("few-missing-fields");
  else reasons.push("many-missing-fields");

  let priority = scored.finalPriority;
  if (card.card_usable_for_ranking) priority += 5;
  if (hasBrowserFreePdfHint(work)) priority += 3;
  if (targets.length <= 3) priority += 2;
  priority += Math.max(0, 6 - targets.length) * 0.25;

  return {
    priority: Number(priority.toFixed(3)),
    targets,
    reasons: [...new Set(reasons)],
    econScore: scored.econScore,
  };
}

console.log(
  `[tier2-enqueue] limit=${LIMIT} scan_limit=${SCAN_LIMIT} min_econ_score=${MIN_ECON_SCORE} ` +
  `include_no_pdf=${INCLUDE_NO_PDF} include_not_ranking_usable=${INCLUDE_NOT_RANKING_USABLE} ` +
  `include_blocked_pdf_hosts=${INCLUDE_BLOCKED_PDF_HOSTS} dry_run=${DRY_RUN}`,
);

const existing = DRY_RUN ? new Set() : await fetchExistingQueueIds();
console.log(`[tier2-enqueue] already in upgrade queue: ${existing.size}`);

const cards = await fetchCards();
console.log(`[tier2-enqueue] scanned low-confidence cards: ${cards.length}`);

const workIds = [...new Set(cards.map((card) => card.work_id).filter(Boolean))];
const workMap = await fetchWorksByIds(workIds);

const candidates = [];
const skipped = {
  alreadyQueued: 0,
  missingWork: 0,
  noTargets: 0,
  noPdf: 0,
  notEcon: 0,
};

for (const card of cards) {
  if (existing.has(card.work_id)) {
    skipped.alreadyQueued++;
    continue;
  }
  const work = workMap.get(card.work_id);
  if (!work) {
    skipped.missingWork++;
    continue;
  }
  const targets = targetFields(card);
  if (targets.length === 0) {
    skipped.noTargets++;
    continue;
  }
  if (!INCLUDE_NO_PDF && !isUsableText(work.open_access_pdf_url, 10)) {
    skipped.noPdf++;
    continue;
  }
  if (!INCLUDE_BLOCKED_PDF_HOSTS && isKnownBlockedPdfHost(work.open_access_pdf_url)) {
    skipped.blockedPdfHost = (skipped.blockedPdfHost || 0) + 1;
    continue;
  }
  const scored = priorityFor(card, work);
  if (!isEconEligible({ econScore: scored.econScore, reasons: scored.reasons }, MIN_ECON_SCORE)) {
    skipped.notEcon++;
    continue;
  }

  candidates.push({
    work_id: card.work_id,
    evidence_card_id: card.id,
    priority_score: scored.priority,
    state: "queued",
    target_fields: scored.targets,
    source_hint: sourceHint(work),
    reasons: scored.reasons,
  });
}

candidates.sort((a, b) => b.priority_score - a.priority_score);
const selected = candidates.slice(0, LIMIT);

console.log(`[tier2-enqueue] eligible candidates: ${candidates.length}`);
console.log(`[tier2-enqueue] selected for queue: ${selected.length}`);
console.log(`[tier2-enqueue] skipped: ${JSON.stringify(skipped)}`);
console.log("[tier2-enqueue] top 10:");
for (const row of selected.slice(0, 10)) {
  console.log(`  ${row.priority_score.toFixed(3)} ${row.work_id} targets=${row.target_fields.join(",")} reasons=${row.reasons.slice(0, 6).join("|")}`);
}

if (DRY_RUN || selected.length === 0) {
  process.exit(0);
}

for (let i = 0; i < selected.length; i += 500) {
  const batch = selected.slice(i, i + 500);
  const { error } = await supabase
    .from("evidence_card_upgrade_queue")
    .upsert(batch, { onConflict: "work_id" });
  if (error) throw new Error(`queue upsert failed at ${i}: ${error.message}`);
}

console.log(`[tier2-enqueue] queued ${selected.length} Tier 2 upgrade row(s)`);
