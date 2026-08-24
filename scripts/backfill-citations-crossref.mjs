#!/usr/bin/env node
/**
 * Backfill citation_count from Crossref API.
 *
 * Targets canonical non-noise papers where citation_count is NULL or
 * unverified zero (raw_data has no cited_by_count provenance from OA).
 * Fetches `is-referenced-by-count` from api.crossref.org.
 *
 * Crossref counts only citations where the citing paper is also Crossref-indexed
 * (slightly lower than OA), but it has no daily rate limit and responds to any
 * DOI. Good fallback when OA is rate-limited.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-citations-crossref.mjs
 *   node --env-file=.env scripts/backfill-citations-crossref.mjs --dry-run
 *   node --env-file=.env scripts/backfill-citations-crossref.mjs --limit 5000
 *   node --env-file=.env scripts/backfill-citations-crossref.mjs --only-zero
 *
 * Rate: Crossref polite pool ~50 req/s with User-Agent email header.
 * ETA:  43k papers at PARALLEL=10, ~0.3s/call ≈ ~15 min.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONTACT_EMAIL = process.env.CROSSREF_EMAIL || process.env.OPENALEX_MAILTO || "horizon-scanner@iadb.org";
const PARALLEL = 10;
const BATCH_SIZE = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const ONLY_ZERO = args.includes("--only-zero"); // skip NULL papers (only fix the false-zeros)
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function fetchCrossrefCitation(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": `HorizonScanner/1.0 (mailto:${CONTACT_EMAIL})` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const data = await r.json();
    const count = data?.message?.["is-referenced-by-count"];
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Crossref citation backfill ===");
  console.log(`dry_run=${DRY_RUN} | only_zero=${ONLY_ZERO} | limit=${LIMIT} | parallel=${PARALLEL}`);

  let offset = 0, fetched = 0, updated = 0, skipped = 0, missing = 0;
  const start = Date.now();

  while (fetched < LIMIT) {
    let query = sb
      .from("works")
      .select("id, canonical_doi")
      .eq("is_noise", false)
      .is("canonical_work_id", null)
      .not("canonical_doi", "is", null)
      .range(offset, offset + BATCH_SIZE - 1)
      .order("citation_count", { ascending: true, nullsFirst: true })
      .order("id");

    if (ONLY_ZERO) {
      // Only fix papers with unverified zero (not NULL)
      query = query.eq("citation_count", 0).is("raw_data->>cited_by_count", null);
    } else {
      // Both NULL and unverified zero
      query = query.or("citation_count.is.null,and(citation_count.eq.0,raw_data->>cited_by_count.is.null)");
    }

    const { data: rows, error } = await query;
    if (error) { console.error("fetch error:", error.message); break; }
    if (!rows?.length) { console.log("queue exhausted"); break; }

    fetched += rows.length;

    // Process PARALLEL at a time
    for (let i = 0; i < rows.length; i += PARALLEL) {
      const chunk = rows.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        chunk.map((row) => fetchCrossrefCitation(row.canonical_doi))
      );

      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j];
        const count = results[j].status === "fulfilled" ? results[j].value : null;

        if (count === null) { missing++; continue; }
        if (DRY_RUN) { console.log(`[dry] ${row.id}: ${count}`); updated++; continue; }

        const { error: ue } = await sb.from("works")
          .update({ citation_count: count })
          .eq("id", row.id);
        if (ue) { skipped++; continue; }
        updated++;
      }

      if (updated + missing >= LIMIT) break;
    }

    const elapsed = ((Date.now() - start) / 60000).toFixed(1);
    process.stdout.write(`\r  ${fetched} fetched | ${updated} updated | ${missing} missing | ${elapsed}min`);

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
    if (updated + missing >= LIMIT) break;
  }

  console.log("\n\n=== Done ===");
  console.log(JSON.stringify({ fetched, updated, missing, skipped, elapsed_min: ((Date.now() - start) / 60000).toFixed(1) }, null, 2));
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
