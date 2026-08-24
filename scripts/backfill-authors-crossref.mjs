// scripts/backfill-authors-crossref.mjs
//
// Backfill works.authors from Crossref API for papers that have a canonical_doi
// but empty/null authors. Crossref has near-complete author coverage for papers
// with DOIs — this fills the ~13k papers where OpenAlex returned no authorships.
//
// Usage:
//   node scripts/backfill-authors-crossref.mjs [--limit N] [--dry-run]
//
// Rate: Crossref polite pool is ~50 req/s with email header; we batch 10 in parallel.
// ETA: ~13k papers / 10 parallel / ~0.3s per call ≈ ~7 minutes.

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONTACT_EMAIL = process.env.CROSSREF_EMAIL || "horizon-scanner@iadb.org";
const PARALLEL = 10;
const BATCH_SIZE = 200;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Crossref lookup
// ---------------------------------------------------------------------------

async function fetchAuthorsFromCrossref(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": `HorizonScanner/1.0 (mailto:${CONTACT_EMAIL})`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const data = await r.json();
    const authors = (data?.message?.author ?? [])
      .map((a) => {
        const given = a.given ?? "";
        const family = a.family ?? "";
        if (!family) return a.name ?? null;
        return `${given} ${family}`.trim();
      })
      .filter(Boolean);
    return authors.length > 0 ? authors : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[crossref-backfill] starting — parallel=${PARALLEL} dry_run=${DRY_RUN}`);

  let offset = 0;
  let totalFetched = 0;
  let totalUpdated = 0;
  let totalMissed = 0;

  while (true) {
    // Fetch a batch of papers with DOIs but no authors
    const { data: rows, error } = await sb
      .from("works")
      .select("id, canonical_doi, title")
      .filter("authors", "eq", "[]")
      .not("canonical_doi", "is", null)
      .or("is_noise.is.null,is_noise.eq.false")   // was .eq("is_noise", false) — that excluded NULL rows
      .is("canonical_work_id", null)
      .range(offset, offset + BATCH_SIZE - 1)
      .order("year", { ascending: false })  // recent first — better Crossref coverage
      .order("id");

    if (error) {
      console.error("[crossref-backfill] fetch error:", error.message);
      break;
    }
    if (!rows || rows.length === 0) {
      console.log("[crossref-backfill] queue exhausted");
      break;
    }

    console.log(`[crossref-backfill] batch offset=${offset} size=${rows.length}`);
    totalFetched += rows.length;

    // Process in chunks of PARALLEL
    for (let i = 0; i < rows.length; i += PARALLEL) {
      const chunk = rows.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        chunk.map((row) => fetchAuthorsFromCrossref(row.canonical_doi))
      );

      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j];
        const result = results[j];
        if (result.status !== "fulfilled" || !result.value) {
          totalMissed++;
          continue;
        }
        const authors = result.value;
        if (!DRY_RUN) {
          const { error: updateErr } = await sb
            .from("works")
            .update({ authors: JSON.stringify(authors) })
            .eq("id", row.id);
          if (updateErr) {
            console.error(`[crossref-backfill] update error ${row.id}:`, updateErr.message);
          } else {
            totalUpdated++;
            if (totalUpdated % 100 === 0) {
              console.log(`[crossref-backfill] updated=${totalUpdated} missed=${totalMissed}`);
            }
          }
        } else {
          console.log(`[dry-run] ${row.id}: ${authors.slice(0, 2).join(", ")}${authors.length > 2 ? " et al." : ""}`);
          totalUpdated++;
        }

        if (totalUpdated + totalMissed >= LIMIT) break;
      }

      if (totalUpdated + totalMissed >= LIMIT) break;
    }

    if (totalUpdated + totalMissed >= LIMIT) break;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`\n[crossref-backfill] done — fetched=${totalFetched} updated=${totalUpdated} missed=${totalMissed}`);
}

main().catch((err) => {
  console.error("[crossref-backfill] fatal:", err);
  process.exit(1);
});
