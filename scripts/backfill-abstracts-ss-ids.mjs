#!/usr/bin/env node
/**
 * Backfill missing abstracts via native Semantic Scholar paper IDs.
 *
 * This complements backfill-abstracts-ss.mjs, which targets DOI-bearing works.
 * Many Semantic Scholar imports have ids like `ss:<paperId>` but no DOI, so
 * the DOI-only pass cannot reach them.
 *
 * Usage:
 *   node scripts/backfill-abstracts-ss-ids.mjs
 *   node scripts/backfill-abstracts-ss-ids.mjs --dry-run
 *   node scripts/backfill-abstracts-ss-ids.mjs --limit 5000 --year-min 2010 --order-by citation_count
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();
const YEAR_MIN = (() => {
  const i = args.indexOf("--year-min");
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : null;
})();
const VENUES = (() => {
  const i = args.indexOf("--venues");
  return i >= 0 && args[i + 1]
    ? args[i + 1].split(",").map((venue) => venue.trim()).filter(Boolean)
    : [];
})();
const ORDER_BY = (() => {
  const i = args.indexOf("--order-by");
  const value = i >= 0 && args[i + 1] ? args[i + 1] : "id";
  return ["id", "year", "citation_count"].includes(value) ? value : "id";
})();
const VENUE_DENYLIST = loadVenueDenylist();

const SS_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
const BATCH = 500;
const MIN_INTERVAL_MS = SS_API_KEY ? 100 : 1100;
const MISS_CACHE = path.resolve("data", "semantic-scholar-abstract-id-misses.txt");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paperIdFromWorkId = (id) => String(id || "").replace(/^ss:/, "").trim();
const cacheKey = (id) => paperIdFromWorkId(id).toLowerCase();

function loadMissCache() {
  try {
    const lines = fs.readFileSync(MISS_CACHE, "utf8").split(/\r?\n/).filter(Boolean);
    return new Set(lines.map((line) => line.trim().toLowerCase()));
  } catch {
    return new Set();
  }
}

function appendMisses(ids, missCache) {
  const fresh = [];
  for (const id of ids) {
    const key = cacheKey(id);
    if (!key || missCache.has(key)) continue;
    missCache.add(key);
    fresh.push(key);
  }
  if (!fresh.length) return 0;
  fs.mkdirSync(path.dirname(MISS_CACHE), { recursive: true });
  fs.appendFileSync(MISS_CACHE, `${fresh.join("\n")}\n`);
  return fresh.length;
}

function missingAbstract(query) {
  return query.or("abstract.is.null,abstract.eq.");
}

async function fetchTargets(missCache) {
  const all = [];
  let from = 0;
  const PAGE = 1000;

  while (all.length < LIMIT) {
    let query = missingAbstract(
      supabase
        .from("works")
        .select("id, year, citation_count, venue")
        .like("id", "ss:%"),
    );
    if (YEAR_MIN) query = query.gte("year", YEAR_MIN);
    if (VENUES.length) query = query.in("venue", VENUES);

    const { data, error } = await query
      .order(ORDER_BY, { ascending: ORDER_BY === "id", nullsFirst: false })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("Target query error:", error.message);
      break;
    }
    if (!data?.length) break;

    all.push(...filterDeniedVenues(data, VENUE_DENYLIST).filter((row) => !missCache.has(cacheKey(row.id))));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loading targets... ${all.length}`);
  }

  const selected = all.slice(0, LIMIT);
  console.log(`\r  targets: ${selected.length} ss:<paperId> works missing abstracts`);
  return selected;
}

async function fetchBatchFromSS(ids) {
  const url = "https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract";
  const headers = { "Content-Type": "application/json" };
  if (SS_API_KEY) headers["x-api-key"] = SS_API_KEY;

  let attempts = 0;
  while (attempts < 4) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: ids.map(paperIdFromWorkId) }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429) {
        const wait = 5000 * (attempts + 1);
        console.error(`\n  [SS 429] backing off ${wait}ms`);
        await sleep(wait);
        attempts++;
        continue;
      }
      if (!res.ok) {
        console.error(`\n  [SS ${res.status}]`, await res.text().catch(() => ""));
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error(`\n  fetch err: ${err.message}`);
      attempts++;
      await sleep(2000);
    }
  }
  return [];
}

async function applyAbstracts(targets, ssResults) {
  let updated = 0;
  let missing = 0;
  const missingIds = [];

  for (let i = 0; i < targets.length; i++) {
    const ss = ssResults[i];
    const abstract = String(ss?.abstract || "").trim();
    if (!abstract) {
      missing++;
      missingIds.push(targets[i].id);
      continue;
    }

    const { error } = await supabase
      .from("works")
      .update({ abstract })
      .eq("id", targets[i].id);
    if (error) {
      console.error(`\n  update err ${targets[i].id}: ${error.message}`);
      continue;
    }
    updated++;
  }

  return { updated, missing, missingIds };
}

async function main() {
  console.log("\n=== Abstract backfill (Semantic Scholar paper IDs) ===");
  console.log(`API key: ${SS_API_KEY ? "present" : "unauthenticated (slower)"}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? "none" : LIMIT}\n`);
  console.log(`Filters: year_min=${YEAR_MIN || "none"}, order_by=${ORDER_BY}\n`);
  console.log(`Venues: ${VENUES.length ? VENUES.join(", ") : "any"}\n`);

  const missCache = loadMissCache();
  console.log(`Miss cache: ${MISS_CACHE} (${missCache.size} paper ID misses)\n`);

  const targets = await fetchTargets(missCache);
  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (DRY_RUN) {
    console.log(`Would query SS for ${targets.length} paper IDs in ${Math.ceil(targets.length / BATCH)} batches.`);
    return;
  }

  let totalUpdated = 0;
  let totalMissing = 0;
  let totalProcessed = 0;
  let totalCachedMisses = 0;
  const startTime = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const t0 = Date.now();
    const results = await fetchBatchFromSS(slice.map((target) => target.id));
    const { updated, missing, missingIds } = await applyAbstracts(slice, results);
    if (results.length === slice.length) {
      totalCachedMisses += appendMisses(missingIds, missCache);
    }
    totalUpdated += updated;
    totalMissing += missing;
    totalProcessed += slice.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(targets.length / BATCH)} | processed ${totalProcessed} | filled ${totalUpdated} | not in SS ${totalMissing} | ${elapsed}s`);

    const sleepFor = MIN_INTERVAL_MS - (Date.now() - t0);
    if (sleepFor > 0) await sleep(sleepFor);
  }

  console.log("\n\n=== Done ===");
  console.log(`Processed:  ${totalProcessed}`);
  console.log(`Filled:     ${totalUpdated}`);
  console.log(`Not in SS:  ${totalMissing}`);
  console.log(`New cached misses: ${totalCachedMisses}`);
  console.log(`Elapsed:    ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
