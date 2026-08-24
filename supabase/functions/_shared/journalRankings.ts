/**
 * supabase/functions/_shared/journalRankings.ts
 *
 * Journal ranking lookup for QUAL-02 (RePEC) and QUAL-03 (ABS).
 *
 * Loads both ranking tables into memory on first use, then matches
 * paper venue names via normalized key lookup.
 *
 * Normalization handles common mismatches:
 *   - "The Quarterly Journal of Economics" vs "Quarterly Journal of Economics"
 *   - Case differences
 *   - Leading/trailing whitespace
 *   - Punctuation differences
 */

import { adminClient } from "./supabase.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AbsEntry {
  absRating: string;
  field: string;
  issn: string | null;
}

interface RepecEntry {
  rank: number;
  percentile: number;
  score: number;
}

interface MatchInfo {
  matchType: "exact" | "normalized";
  inputVenue: string;
  normalizedKey: string;
  absField: string | null;
  repecTotalCount: number | null;
}

interface RankingResult {
  absRating: string | null;
  repecRank: number | null;
  repecPercentile: number | null;
  matchInfo: MatchInfo | null;
}

// ---------------------------------------------------------------------------
// In-memory caches — loaded once on first call
// ---------------------------------------------------------------------------

let absMap: Map<string, AbsEntry> | null = null;
let repecMap: Map<string, RepecEntry> | null = null;
let loaded = false;
// Singleflight: when the first request triggers a load, subsequent concurrent
// requests await the same promise instead of starting their own fetches.
// Without this, the deno-api startup-warm + first few user queries can each
// kick off duplicate `fetchAll` pairs (the warm runs `void` in server.ts:45 so
// it doesn't block request handling).
let loadPromise: Promise<void> | null = null;

/**
 * Normalize a journal name for matching.
 * Strips "The " prefix, lowercases, removes punctuation, collapses whitespace.
 */
function normalize(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    // Strip a trailing country/region disambiguator that the ABS guide appends
    // but the corpus venue lacks, e.g. "Health Economics (United Kingdom)" →
    // "health economics", "Agricultural Economics (United Kingdom)". Must run
    // before punctuation removal (it needs the parentheses).
    .replace(/\s*\([^)]*\)\s*$/, "")
    // "&" and the spelled-out "and" are used interchangeably across venue
    // strings: the corpus stores "Journal of Economic Behavior & Organization"
    // while the ABS guide stores "...Behavior and Organization". Convert the
    // ampersand to the word before punctuation stripping so both sides agree.
    .replace(/&/g, " and ")
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch all rows from a table, paginating past Supabase's 1000-row default limit.
 */
// deno-lint-ignore no-explicit-any
async function fetchAll(table: string, columns: string): Promise<any[]> {
  const PAGE = 1000;
  // deno-lint-ignore no-explicit-any
  let all: any[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await adminClient
      .from(table)
      .select(columns)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error(
        `[journalRankings] Error fetching ${table}:`,
        error.message
      );
      break;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/**
 * Load ranking tables from Supabase into memory.
 * Called once lazily on first lookup, OR eagerly at deno-api startup via
 * `warmJournalRankings()` to avoid the cold-cache tax on the first search
 * after every deploy (~8s, see evals/perf-log.md 2026-05-11).
 */
export async function warmJournalRankings(): Promise<void> {
  await loadRankings();
}

async function loadRankings(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = doLoad().catch((err) => {
      // On failure, clear the promise so the next caller can retry.
      // Without this, a transient DB error would permanently break lookups.
      loadPromise = null;
      throw err;
    });
  }
  await loadPromise;
}

async function doLoad(): Promise<void> {
  const [absRows, repecRows] = await Promise.all([
    fetchAll("abs_rankings", "journal_name, abs_rating, field, issn"),
    fetchAll("ideas_repec_rankings", "journal_name, rank, percentile, score"),
  ]);

  absMap = new Map();
  for (const row of absRows) {
    const key = normalize(row.journal_name);
    if (key)
      absMap.set(key, {
        absRating: row.abs_rating,
        field: row.field,
        issn: row.issn,
      });
  }

  repecMap = new Map();
  for (const row of repecRows) {
    const key = normalize(row.journal_name);
    if (key)
      repecMap.set(key, {
        rank: row.rank,
        percentile: row.percentile,
        score: row.score,
      });
  }

  loaded = true;
  console.log(
    `[journalRankings] Loaded ${absMap.size} ABS + ${repecMap.size} RePEC entries`
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Look up journal rankings for a venue name.
 */
export async function lookupJournalRankings(
  venue: string | null | undefined
): Promise<RankingResult> {
  if (!venue)
    return { absRating: null, repecRank: null, repecPercentile: null, matchInfo: null };

  await loadRankings();

  const key = normalize(venue);
  const isNormalized = key !== venue.toLowerCase().trim();
  const abs = absMap!.get(key) ?? null;
  const repec = repecMap!.get(key) ?? null;
  const found = abs || repec;

  return {
    absRating: abs?.absRating ?? null,
    repecRank: repec?.rank ?? null,
    repecPercentile: repec?.percentile ?? null,
    matchInfo: found
      ? {
          matchType: isNormalized ? "normalized" : "exact",
          inputVenue: venue,
          normalizedKey: key,
          absField: abs?.field ?? null,
          repecTotalCount: repecMap?.size ?? null,
        }
      : null,
  };
}

/**
 * Batch lookup for multiple papers.
 * Returns a Map of paper.id -> rankings.
 */
export async function lookupBatch(
  papers: Array<{ id: string; venue?: string | null }>
): Promise<Map<string, RankingResult>> {
  await loadRankings();

  const results = new Map<string, RankingResult>();
  for (const paper of papers) {
    const key = normalize(paper.venue);
    const isNormalized = paper.venue
      ? key !== paper.venue.toLowerCase().trim()
      : false;
    const abs = key ? (absMap!.get(key) ?? null) : null;
    const repec = key ? (repecMap!.get(key) ?? null) : null;
    const found = abs || repec;
    results.set(paper.id, {
      absRating: abs?.absRating ?? null,
      repecRank: repec?.rank ?? null,
      repecPercentile: repec?.percentile ?? null,
      matchInfo: found
        ? {
            matchType: isNormalized ? "normalized" : "exact",
            inputVenue: paper.venue!,
            normalizedKey: key,
            absField: abs?.field ?? null,
            repecTotalCount: repecMap?.size ?? null,
          }
        : null,
    });
  }
  return results;
}

/**
 * Force reload of rankings (useful after seeding new data).
 */
export function invalidateCache(): void {
  loaded = false;
  loadPromise = null;
  absMap = null;
  repecMap = null;
}
