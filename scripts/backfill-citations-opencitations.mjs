#!/usr/bin/env node
/**
 * Backfill citation_count from OpenCitations COCI index.
 *
 * OpenCitations is a fully open, no-rate-limit scholarly citation database.
 * It indexes citations where both the citing and cited paper are Crossref-indexed.
 * Coverage is lower than OpenAlex but it has no daily quota — ideal fallback.
 *
 * API: GET https://opencitations.net/index/coci/api/v1/citation-count/{doi}
 * Returns: [{"oci":"...","count":"42"}] or []
 *
 * Targets canonical non-noise papers with unverified citation_count (NULL or
 * zero with no OA/Crossref provenance), ordered by year ascending so older
 * papers (most likely to have real citations) are checked first.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-citations-opencitations.mjs
 *   node --env-file=.env scripts/backfill-citations-opencitations.mjs --dry-run
 *   node --env-file=.env scripts/backfill-citations-opencitations.mjs --limit 10000
 *   node --env-file=.env scripts/backfill-citations-opencitations.mjs --min-year 1990 --max-year 2010
 *
 * Rate: No limit (OpenCitations is fully open). Run PARALLEL=20 safely.
 * ETA:  43k papers at PARALLEL=20, ~0.4s/call ≈ ~15 min.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PARALLEL = 20;
const BATCH_SIZE = 500;
const OC_BASE = "https://opencitations.net/index/coci/api/v1/citation-count";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const LIMIT    = (() => { const i = args.indexOf("--limit");    return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const MIN_YEAR = (() => { const i = args.indexOf("--min-year"); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();
const MAX_YEAR = (() => { const i = args.indexOf("--max-year"); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function fetchOCCount(doi) {
  const url = `${OC_BASE}/${encodeURIComponent(doi)}`;
  try {
    const r = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const count = parseInt(data[0]?.count ?? data[0]?.citing ?? "0", 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== OpenCitations citation backfill ===");
  console.log(`dry_run=${DRY_RUN} | limit=${LIMIT} | parallel=${PARALLEL} | years=${MIN_YEAR ?? "any"}-${MAX_YEAR ?? "any"}`);

  let offset = 0, fetched = 0, updated = 0, missing = 0, skipped = 0;
  const start = Date.now();

  while (fetched < LIMIT) {
    let query = sb
      .from("works")
      .select("id, canonical_doi, year")
      .eq("is_noise", false)
      .is("canonical_work_id", null)
      .not("canonical_doi", "is", null)
      // Target: unverified zeros OR still-null after other passes
      .or("citation_count.is.null,and(citation_count.eq.0,raw_data->>cited_by_count.is.null)")
      .range(offset, offset + BATCH_SIZE - 1)
      .order("year", { ascending: true, nullsFirst: false }) // oldest first — most citations accumulated
      .order("id");

    if (MIN_YEAR) query = query.gte("year", MIN_YEAR);
    if (MAX_YEAR) query = query.lte("year", MAX_YEAR);

    const { data: rows, error } = await query;
    if (error) { console.error("fetch error:", error.message); break; }
    if (!rows?.length) { console.log("queue exhausted"); break; }

    fetched += rows.length;

    // Process PARALLEL at a time
    for (let i = 0; i < rows.length; i += PARALLEL) {
      const chunk = rows.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        chunk.map((row) => fetchOCCount(row.canonical_doi))
      );

      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j];
        const count = results[j].status === "fulfilled" ? results[j].value : null;

        if (count === null) { missing++; continue; }

        if (DRY_RUN) {
          console.log(`[dry] ${row.id} (${row.year}): ${count} citations`);
          updated++;
          continue;
        }

        const { error: ue } = await sb.from("works")
          .update({ citation_count: count })
          .eq("id", row.id);
        if (ue) { skipped++; continue; }
        updated++;
      }

      if (updated + missing >= LIMIT) break;
    }

    const elapsed = ((Date.now() - start) / 60000).toFixed(1);
    process.stdout.write(`\r  ${fetched} fetched | ${updated} updated | ${missing} not-in-OC | ${elapsed}min`);

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
    if (updated + missing >= LIMIT) break;
  }

  console.log("\n\n=== Done ===");
  console.log(JSON.stringify({ fetched, updated, missing, skipped, elapsed_min: ((Date.now() - start) / 60000).toFixed(1) }, null, 2));
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
