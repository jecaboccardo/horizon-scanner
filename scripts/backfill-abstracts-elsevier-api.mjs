#!/usr/bin/env node
/**
 * Backfill missing abstracts via Elsevier Abstract Retrieval API.
 *
 * Uses the Elsevier API key to fetch abstracts for papers with 10.1016/
 * and other Elsevier DOIs. No browser / CAPTCHA needed.
 *
 * API: https://api.elsevier.com/content/abstract/doi/{doi}
 * Rate limit: ~6 RPS — we use 3 concurrent with 400ms sleep to be safe.
 *
 * Usage:
 *   node scripts/backfill-abstracts-elsevier-api.mjs --dry-run --limit 50
 *   node scripts/backfill-abstracts-elsevier-api.mjs --limit 1000
 *   node scripts/backfill-abstracts-elsevier-api.mjs --limit 5000 --min-abs-rating 4
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY = process.env.ELSEVIER_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[elsevier-api] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!API_KEY) {
  console.error("[elsevier-api] Missing ELSEVIER_API_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function argValue(name, fallback = null) {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(argValue("--limit", "1000"));
const YEAR_MIN = Number(argValue("--year-min", "0")) || 0;
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", "0")) || 0;
const CONCURRENCY = Number(argValue("--concurrency", "3"));
const SLEEP_MS = Number(argValue("--sleep-ms", "400"));

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-elsevier-api-backfill-${TODAY}.json`);
const VENUE_DENYLIST = loadVenueDenylist();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function absRatingValue(value) {
  const text = String(value || "").trim();
  if (text === "4*") return 4.5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactText(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

function isGoodAbstract(text) {
  const t = compactText(text);
  return t.length >= 80 && t.length <= 8000;
}

function looksElsevier(work) {
  const doi = String(work.canonical_doi || "").toLowerCase();
  return doi.startsWith("10.1016/") || doi.startsWith("10.1006/") ||
    doi.startsWith("10.1053/") || doi.startsWith("10.1078/") ||
    doi.startsWith("10.1054/") || doi.startsWith("10.1067/");
}

function priorAttemptFailed(work) {
  const src = work.raw_data?.abstract_backfill?.source || "";
  const status = work.raw_data?.abstract_backfill?.status || "";
  return src.includes("elsevier_api") && ["not_found", "api_error"].includes(status);
}

async function selectAll(baseQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await baseQuery.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function loadTargets() {
  let query = supabase.from("works")
    .select("id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,abs_rating,publication_type,is_noise,excluded")
    .or("abstract.is.null,abstract.eq.")
    .eq("is_noise", false)
    .order("citation_count", { ascending: false, nullsFirst: false });
  if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);

  const rows = filterDeniedVenues(await selectAll(query), VENUE_DENYLIST)
    .filter((r) => !String(r.abstract || "").trim())
    .filter((r) => !r.excluded)
    .filter((r) => !isGenericNonPrimaryTitle(r.title))
    .filter((r) => MIN_ABS_RATING <= 0 || absRatingValue(r.abs_rating) >= MIN_ABS_RATING)
    .filter(looksElsevier)
    .filter((r) => !priorAttemptFailed(r))
    .sort((a, b) =>
      absRatingValue(b.abs_rating) - absRatingValue(a.abs_rating) ||
      Number(b.citation_count || 0) - Number(a.citation_count || 0)
    );

  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

async function fetchElsevierAbstract(doi) {
  const url = `https://api.elsevier.com/content/abstract/doi/${encodeURIComponent(doi)}`;
  const resp = await fetch(url, {
    headers: {
      "X-ELS-APIKey": API_KEY,
      "Accept": "application/json",
    },
  });
  if (resp.status === 404) return { kind: "not_found" };
  if (resp.status === 429) return { kind: "rate_limited" };
  if (!resp.ok) return { kind: "api_error", status: resp.status };

  const json = await resp.json();
  const core = json?.["abstracts-retrieval-response"]?.coredata;
  const abstract = core?.["dc:description"] || core?.["prism:teaser"] || null;
  if (!abstract || !isGoodAbstract(abstract)) return { kind: "not_found" };
  return { kind: "formal_abstract", abstract: compactText(abstract) };
}

async function apply(work, extracted) {
  const backfillMeta = {
    source: "elsevier_api",
    status: extracted.kind,
    matched_at: new Date().toISOString(),
    doi: work.canonical_doi,
  };
  if (extracted.kind !== "formal_abstract") {
    if (!DRY_RUN) {
      await supabase.from("works").update({
        raw_data: { ...(work.raw_data || {}), abstract_backfill: backfillMeta },
      }).eq("id", work.id);
    }
    return { status: extracted.kind, work };
  }
  if (DRY_RUN) return { status: "would_update", work, abstract: extracted.abstract };
  const { error } = await supabase.from("works").update({
    abstract: extracted.abstract,
    raw_data: { ...(work.raw_data || {}), abstract_backfill: backfillMeta },
  }).eq("id", work.id);
  if (error) return { status: "update_error", work, error: error.message };
  return { status: "updated", work };
}

async function processWork(work, idx, total, stats) {
  try {
    const extracted = await fetchElsevierAbstract(work.canonical_doi);
    if (extracted.kind === "rate_limited") {
      await sleep(5000);
      const retry = await fetchElsevierAbstract(work.canonical_doi);
      Object.assign(extracted, retry);
    }
    const result = await apply(work, extracted);
    if (result.status === "updated") stats.updated++;
    else if (result.status === "not_found") stats.not_found++;
    else if (result.status === "would_update") stats.would_update++;
    const label = result.status === "updated" ? "✓" : result.status === "not_found" ? "–" : result.status;
    console.log(`${idx + 1}/${total} ${label} ${work.year || ""} ${work.venue?.slice(0, 28) || ""} :: ${work.title?.slice(0, 65) || work.id}`);
    return result;
  } catch (err) {
    stats.errors++;
    console.log(`${idx + 1}/${total} error :: ${work.title?.slice(0, 65) || work.id}: ${err.message}`);
    return { status: "error", work, error: err.message };
  }
}

async function main() {
  console.log("\n=== Elsevier API abstract backfill ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Concurrency: ${CONCURRENCY} | Sleep: ${SLEEP_MS}ms\n`);

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) { console.log("Nothing to do."); return; }

  const stats = { updated: 0, would_update: 0, not_found: 0, errors: 0 };
  const results = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((work, j) => processWork(work, i + j, targets.length, stats))
    );
    results.push(...batchResults);
    if (i + CONCURRENCY < targets.length) await sleep(SLEEP_MS);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    limit: LIMIT,
    min_abs_rating: MIN_ABS_RATING || null,
    targets: targets.length,
    updated: stats.updated,
    would_update: stats.would_update,
    not_found: stats.not_found,
    errors: stats.errors,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log("\n" + JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[elsevier-api] failed:", err);
  process.exit(1);
});
