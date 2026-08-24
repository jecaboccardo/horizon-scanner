// ⚠️ FROZEN SNAPSHOT — pre-2026-06-02 rerank.ts (before Layer-2 floor + P0 gate).
// Used ONLY by scripts/probe-rerank-regression.mjs for the scoring A/B. NOT
// production code; do not import from the pipeline. Regenerate with:
//   git show HEAD:supabase/functions/_shared/rerank.ts > _rerank_baseline.ts
/**
 * supabase/functions/_shared/rerank.ts
 *
 * Composite-score rerank applied AFTER the per-facet relevance gate
 * (directIndirectClassifier). The gate already filtered out off-topic papers
 * — anything reaching this function has cleared the geometric-mean threshold
 * on every required facet. This rerank only orders the qualified pool.
 *
 * IMPORTANT: scripts/eval-gold.mjs has a JS mirror of the scoring functions
 * and weights so the eval reflects the post-rerank top-K, not just the RPC
 * pool. If you change any scoring function, weight, or LAC keyword list here,
 * update the mirror and re-pin evals/baseline.json.
 *
 * History: an older version of this file applied composite scoring over the
 * unfiltered universe and produced the "Maternal Labor Supply problem"
 * (commit 792d59b) — prestige beat irrelevance. That bug is now closed by
 * the relevance gate upstream, so composite-within-qualified is safe and
 * surfaces canonical global papers (Bhalotra, Aizer, Anderberg) that the
 * cluster-by-classification sort was hiding behind direct-LAC papers.
 *
 * Default weights (sum to 1.0):
 *   0.50 · vector cosine similarity to the query
 *   0.15 · rigor (sms_level / 5)
 *   0.05 · recency (newer = higher, capped 25-year window)
 *   0.05 · region match (LAC default; remapped per filters.regions)
 *   0.20 · age-normalized citation rate (log-scaled, capped at 500 cites/yr)
 *   0.05 · FTS rank (ts_rank_cd from match_works_v2, clipped to [0,1])
 *
 * Citation weight bumped 2026-05-15 (Phase 1.3): 0.05 → 0.20 per the
 * canonical-position-probe-2026-05-12 Variant C recommendation (α=0.20-0.30
 * surfaces canonical papers consistently). Pre-2010 canonicals were dropping
 * to 0% canary_top20 hit rate under the prior weights (recency=0.10 demoted
 * highly-cited foundational papers like Card 1990, Borjas 2003). The
 * age-normalized citation score gives recent landmark papers a boost too
 * (a 2024 RCT with 30 cites/yr gets meaningful weight), so we can simul-
 * taneously reduce recency to 0.05 and similarity to 0.50 without losing
 * the "newer is better" prior — it just shifts to "newer AND well-cited
 * is better." Watch canary_top20_pre2010 and canary_top20_post2010 deltas
 * separately on `npm run eval`.
 *
 * FTS weight added 2026-05-15 (Phase 1.0): ftsRank is computed in match_works_v2
 * (RPC) and marshaled through to TypeScript, but the prior composite ignored
 * it entirely — meaning FTS hits couldn't influence ranking even when synonyms
 * or exact keywords were the only signal a canonical paper had. Standalone
 * impact is small (FTS=0 for many canonicals due to vocabulary mismatch); the
 * real lever was the citation weight bump (Phase 1.3).
 *
 * Filter-aware behavior:
 *   - Default (no region filter, or "LAC" picked): region match = LAC keywords
 *   - User picks another region (Sub-Saharan Africa, OECD, etc.): region
 *     match swaps to that region's keyword set; LAC papers no longer get
 *     the small boost when they don't match the user's geography
 *   - User picks "Global" or selects all regions: region weight drops to 0
 *     (region is no longer a tiebreaker — pure relevance + rigor + recency)
 *
 * Cluster signal is preserved as metadata on each paper (paper.classification:
 * direct-lac | direct-global | indirect | excluded). The UI shows it as a
 * badge; the ranker does not enforce it as a hard cluster boundary anymore.
 */

// Minimal filter shape used by the reranker. Mirrors the relevant slice of
// the SearchFilters interface in retrieval.ts (which is not exported there).
export interface RerankFilters {
  regions?: string[];
}

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

// Region keyword sets. Keep in sync with REGION_KEYWORDS in retrieval.ts —
// duplicated here so this module stays standalone-testable.
const REGION_KEYWORDS: Record<string, string[]> = {
  "LAC": [
    "latin america", "latin american", "america latina", "américa latina", "latam", "lac",
    "caribbean", "caribe",
    "south america", "central america", "mesoamerica",
    "argentina", "bolivia", "brazil", "brasil",
    "chile", "colombia", "costa rica", "cuba",
    "dominican republic", "república dominicana", "ecuador", "el salvador",
    "guatemala", "haiti", "haití", "honduras",
    "jamaica", "mexico", "méxico", "nicaragua",
    "panama", "panamá", "paraguay", "peru", "perú",
    "uruguay", "venezuela",
    "barbados", "trinidad and tobago", "guyana", "suriname", "belize",
    "andean", "mercosur", "cono sur",
  ],
  "OECD": [
    "oecd", "united states", "canada", "germany", "france", "united kingdom",
    "japan", "korea", "australia", "italy", "spain", "netherlands",
    "sweden", "norway", "finland", "denmark",
  ],
  "High-income": ["high-income", "high income", "developed country", "advanced economy"],
  "Low- and middle-income": [
    "low-income", "low income", "middle-income", "middle income",
    "developing country", "lmic",
  ],
  "Sub-Saharan Africa": [
    "africa", "kenya", "nigeria", "ethiopia", "tanzania", "uganda", "ghana",
    "senegal", "south africa", "rwanda", "zambia", "malawi", "mozambique",
  ],
  "MENA": [
    "middle east", "north africa", "mena", "egypt", "morocco", "tunisia",
    "jordan", "lebanon", "iran", "iraq", "saudi arabia", "uae",
  ],
  "South Asia": [
    "south asia", "india", "pakistan", "bangladesh", "sri lanka", "nepal", "bhutan",
  ],
  "East Asia & Pacific": [
    "east asia", "china", "vietnam", "indonesia", "philippines", "thailand",
    "malaysia", "cambodia", "laos", "myanmar",
  ],
};

const LAC_REGEX = buildKeywordRegex(REGION_KEYWORDS["LAC"]);

function buildKeywordRegex(keywords: string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

export interface RerankWeights {
  similarity: number;
  rigor: number;
  recency: number;
  region: number;
  /** Age-normalized citation rate. Small precision-layer signal — breaks
   *  ties among already-relevant papers without overriding semantic match. */
  citation: number;
  /** FTS rank from match_works_v2 (ts_rank_cd). Small weight so vector-dominant
   *  ranking stays primary; surfaces papers whose exact keywords match but
   *  whose vector similarity is borderline. */
  fts: number;
}

export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  // BO-optimised 2026-05-29 (hyde-default target): protects causal% while improving
  // keyword matching. fts 0.05→0.147 surfaces exact-vocab papers; rigor 0.15→0.160
  // preserves IADB causal quality vs old; sim 0.50→0.428 reflects fts overlap.
  // Switch to BO-base-default (sim:0.327 fts:0.311) if HyDE stays off long-term.
  similarity: 0.428,
  citation:   0.157,
  rigor:      0.160,
  recency:    0.021,
  region:     0.087,
  fts:        0.147,
};

/** Per-channel rerank weights — BO-optimised 2026-05-29.
 *  Used by rerankInterleaved() for multi-channel queries so each channel
 *  scores the pool with its own true weights rather than a blended compromise.
 *  Single-channel queries still pass these via rerankWeightsOverride from the
 *  frontend; this copy lives server-side so the interleave path can use them
 *  without an extra round-trip. Keep in sync with channelsToRerankWeights() in App.tsx. */
export const CHANNEL_RERANK_WEIGHTS: Record<string, Partial<RerankWeights>> = {
  causal:        { similarity: 0.282, citation: 0.196, rigor: 0.250, recency: 0.021, region: 0.146, fts: 0.105 },
  foundational:  { similarity: 0.213, citation: 0.633, rigor: 0.038, recency: 0.022, region: 0.023, fts: 0.071 },
  recent:        { similarity: 0.496, citation: 0.217, rigor: 0.031, recency: 0.203, region: 0.030, fts: 0.023 },
  lac:           { similarity: 0.223, citation: 0.079, rigor: 0.024, recency: 0.023, region: 0.600, fts: 0.051 },
};

/**
 * Multi-channel round-robin interleave.
 *
 * Ranks the same paper pool once per active channel using that channel's true
 * weights, then merges with round-robin: causal-1, found-1, recent-1,
 * causal-2, found-2, recent-2, … Each paper appears once (first channel that
 * surfaces it wins; subsequent appearances are skipped).
 *
 * This avoids the "averaged weights" problem where citation dominates
 * everything when causal + foundational + recent are all selected. Instead
 * each channel contributes ~1/N of the final evidence pool.
 *
 * Channel order: causal first (highest rigor priority for IADB), then
 * foundational, recent, lac — matches the UI checkbox order.
 *
 * Unknown channel names fall back to DEFAULT_RERANK_WEIGHTS silently.
 */
export function rerankInterleaved(
  papers: Paper[],
  filters: RerankFilters | undefined,
  query: string,
  channels: string[],
): Paper[] {
  if (channels.length === 0) return papers;

  // Normalise channel order to the preferred priority
  const ORDER = ["causal", "foundational", "recent", "lac"];
  const sorted = [...channels].sort(
    (a, b) => (ORDER.indexOf(a) === -1 ? 99 : ORDER.indexOf(a))
           - (ORDER.indexOf(b) === -1 ? 99 : ORDER.indexOf(b)),
  );

  // Rank the pool independently for each channel
  const rankings: Paper[][] = sorted.map((ch) => {
    const weights = CHANNEL_RERANK_WEIGHTS[ch]
      ? { ...DEFAULT_RERANK_WEIGHTS, ...CHANNEL_RERANK_WEIGHTS[ch] }
      : DEFAULT_RERANK_WEIGHTS;
    return rerankMerged(papers, filters, { query, weights });
  });

  // Round-robin interleave with dedup by paper id
  const seen = new Set<string>();
  const result: Paper[] = [];
  const ptrs = rankings.map(() => 0);

  while (result.length < papers.length) {
    let anyAdded = false;
    for (let r = 0; r < rankings.length; r++) {
      // Advance past already-selected papers
      while (ptrs[r] < rankings[r].length && seen.has(rankings[r][ptrs[r]].id ?? "")) {
        ptrs[r]++;
      }
      if (ptrs[r] < rankings[r].length) {
        const paper = rankings[r][ptrs[r]];
        const key = paper.id ?? paper.canonical_doi ?? String(ptrs[r]);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(paper);
          anyAdded = true;
        }
        ptrs[r]++;
      }
    }
    if (!anyAdded) break; // all rankings exhausted
  }

  return result;
}

// Normalization ceiling for citation rate (citations / paper-age-in-years).
// Top economics journals see 100-300 cites/year for landmark papers; 500 is a
// generous cap so the log-saturation tail stays meaningful through the field.
const CITATION_RATE_CEILING = 500;
const CITATION_RATE_LOG_CEILING = Math.log(1 + CITATION_RATE_CEILING);

interface ResolvedRegionMatcher {
  /** Regex over title+abstract+geography. Null when region weight is 0. */
  regex: RegExp | null;
  /** Effective region weight (0 when user picked Global or all regions). */
  weight: number;
  /** Label for log diagnostics. */
  label: string;
}

/**
 * Resolve the region matcher and effective weight from user filters + query.
 *
 * Rules (2026-05-09 — gate region weight on actual region intent):
 *   - User picks Global / all regions → weight 0 (explicit no-region intent)
 *   - User picks specific region(s) → use those keywords, weight = baseWeight
 *   - No filter, query mentions LAC → use LAC keywords, weight = baseWeight
 *   - No filter, query doesn't mention LAC → weight 0 (no region intent)
 *
 * The previous default ("LAC always, even without region intent") silently
 * pushed canonical global papers (Bhalotra, Aizer, Anderberg) out of top-20
 * for non-LAC queries because every direct-LAC paper got +baseWeight on
 * composite. With this gate, region weight only activates when the user (or
 * the query itself) signals regional intent.
 */
function resolveRegionMatcher(
  filters: RerankFilters | undefined,
  baseWeight: number,
  query?: string,
): ResolvedRegionMatcher {
  const regions = filters?.regions ?? [];

  if (regions.length === 0) {
    // No filter — derive intent from query text. queryMentionsLAC matches
    // explicit country/region terms (e.g., "AI in Latin America", "Brazil
    // RCT"). Generic queries ("gender violence + labor") do not mention LAC
    // and should not get the LAC bias.
    if (query && queryMentionsLAC(query)) {
      return { regex: LAC_REGEX, weight: baseWeight, label: "LAC (query-implied)" };
    }
    return { regex: null, weight: 0, label: "no region intent (weight=0)" };
  }

  const lower = regions.map((r) => r.toLowerCase());

  // User explicitly picked Global → no regional weighting.
  if (lower.some((r) => r === "global" || r === "any" || r === "world")) {
    return { regex: null, weight: 0, label: "global (weight=0)" };
  }

  const allKnown = Object.keys(REGION_KEYWORDS);
  const allSelected = allKnown.every((k) => regions.includes(k));
  if (allSelected) {
    return { regex: null, weight: 0, label: "all regions (weight=0)" };
  }

  // Build union of selected regions' keywords. Unknown regions fall through
  // as a single literal (lowercased). Filters out empties.
  const merged: string[] = [];
  for (const r of regions) {
    const kws = REGION_KEYWORDS[r];
    if (kws && kws.length > 0) merged.push(...kws);
    else if (r) merged.push(r.toLowerCase());
  }

  if (merged.length === 0) {
    return { regex: LAC_REGEX, weight: baseWeight, label: "LAC (fallback)" };
  }

  return {
    regex: buildKeywordRegex(merged),
    weight: baseWeight,
    label: regions.join("+"),
  };
}

function regionMatchScore(paper: Paper, regex: RegExp | null): number {
  if (!regex) return 0;
  const haystack = [
    paper.title ?? "",
    paper.abstract ?? "",
    Array.isArray(paper.geography) ? paper.geography.join(" ") : "",
  ].join(" ");
  return regex.test(haystack) ? 1 : 0;
}

function rigorScore(paper: Paper): number {
  const sms = Number(paper.sms_level ?? paper.smsLevel ?? 0);
  if (!Number.isFinite(sms) || sms < 1) return 0;
  return Math.min(sms, 5) / 5;
}

function recencyScore(paper: Paper): number {
  const year = Number(
    paper.year ?? paper.publication_year ?? paper.publicationDate?.slice?.(0, 4) ?? 0,
  );
  if (!Number.isFinite(year) || year < 1900) return 0;
  const currentYear = new Date().getUTCFullYear();
  const age = Math.max(0, currentYear - year);
  // 25-year window: paper from this year = 1.0, 25+ years old = 0.
  return Math.max(0, 1 - age / 25);
}

function similarityScore(paper: Paper): number {
  const sim = Number(paper.similarity ?? 0);
  if (Number.isFinite(sim) && sim > 0) return Math.min(1, sim);
  // Option A (2026-05-21): BM25-only papers arrive with similarity=0 because
  // match_works_v2's FULL OUTER JOIN includes FTS-only hits that never had a
  // vector match. The 0.50·sim weight crushes them even when their ftsRank is
  // high. Grant a synthetic similarity capped at 0.45 (just below the vector
  // threshold) so they can compete without displacing strong vector hits.
  // Primary beneficiaries: Spanish-language LAC institutional documents and
  // keyword-specific policy reports that nomic embeddings underperform on.
  const fts = Number(paper.ftsRank ?? paper.fts_rank ?? 0);
  if (Number.isFinite(fts) && fts > 0) return Math.min(0.45, fts * 1.8);
  return 0;
}

/**
 * FTS rank score from match_works_v2's ts_rank_cd column. ts_rank_cd produces
 * non-negative floats; for typical queries values land in [0, 1] but can
 * spike higher on tight matches — clip to [0, 1] so the weight contribution
 * stays comparable to similarityScore.
 */
function ftsScore(paper: Paper): number {
  const raw = Number(paper.ftsRank ?? paper.fts_rank ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

/**
 * Directness bonus from the per-paper classification computed during retrieval
 * (directIndirectClassifier.ts). Phase 1.4b — soft signal, not hard exclusion.
 *
 * Maps:
 *   direct-lac     → +0.10  (strongest — on-topic AND geography-matched)
 *   direct-global  → +0.07  (on-topic, global)
 *   indirect       → 0      (adjacent — left visible by default)
 *   excluded       → -0.15  (off-topic — penalised but not removed; still
 *                            visible in broader/all-evidence mode)
 *
 * Returned as raw score points (added directly to composite), not a [0,1]
 * factor — the classification is categorical, not continuous.
 */
function directnessScore(paper: Paper): number {
  const c = String(paper.classification ?? "");
  if (c === "direct-lac") return 0.10;
  if (c === "direct-global") return 0.07;
  if (c === "indirect") return 0;
  if (c === "excluded") return -0.15;
  return 0; // unknown / unclassified → neutral
}

/**
 * Phase 1.4f — review / synthesis role bonus.
 *
 * Detect via either:
 *   - methodology_design = "Review" (20% of classified papers — reliable)
 *   - title patterns: "systematic review", "meta-analysis",
 *     "literature review", "evidence synthesis", "handbook of",
 *     "annual review of" (catches uncategorized reviews and book chapters)
 *
 * Small bonus (+0.04) so 1-3 topically-relevant reviews float into top-20
 * without crowding out the primary empirical evidence. Reviews are
 * exceptionally useful for IADB analysts (and for the upcoming JEL lit
 * review output mode) — they distill a literature in one paper.
 *
 * Diagnostic showed avg 0.45 reviews in top-20 across 22 queries. Goal:
 * push that toward 1-3 without hurting canary_top20.
 */
const REVIEW_TITLE_PATTERN =
  /\b(systematic|literature|meta[\s-]?analy[sz]is|narrative)\s+(review|analysis)\b|\bmeta[\s-]analys[ie]s\b|\bevidence\s+synthesis\b|\bhandbook\s+of\b|\bannual\s+review\s+of\b|\bscoping\s+review\b|\bumbrella\s+review\b/i;

function reviewBonus(paper: Paper): number {
  const md = String(paper.methodology_design ?? "").toLowerCase();
  if (md === "review") return 0.025;
  const title = String(paper.title ?? "");
  if (title && REVIEW_TITLE_PATTERN.test(title)) return 0.025;
  return 0;
}

/**
 * Phase 1.4c (causal_strength bonus) — NOT SHIPPED.
 *
 * Investigated 2026-05-15. We tried two versions in eval:
 *   v1: high+0.05, moderate+0.02, signal-0.05  → canary_top20 -0.034
 *   v2: signal-0.05 only (no boost)           → canary_top20 -0.017
 * Both regressed the eval. Root cause: the causal_strength column is
 * only 60% populated AND the classifier appears to over-tag working
 * papers (IADB / NBER / RePEc) as "signal" even when they're rigorous
 * empirical work. Demoting them drops real canonicals from top-20.
 *
 * Until the causal_strength labels are cleaned up (re-extracted with a
 * better classifier or merged with sms_level), this signal is too
 * noisy to use as a ranking input. Re-evaluate after evidence-card
 * extraction reaches good coverage — cards will give a fresh
 * causal-strength derivation we can trust.
 */

/**
 * Age-normalized citation rate, log-scaled to [0, 1].
 *
 * Why age-normalized: raw citation counts punish recent papers — a 2024 RCT
 * with 30 cites can be more important to its field than a 1995 review with
 * 300. Citations per year of age levels the comparison.
 *
 * Why log-scaled: the citation distribution is heavy-tailed; without log the
 * top 1% papers dominate the score. log(1+rate) compresses the tail so a
 * landmark 200 cites/yr paper gets ~5× the boost of a typical 5 cites/yr
 * paper, not 40×.
 *
 * The 500 cites/yr ceiling sets log-saturation. Above the ceiling the score
 * is clipped to 1.0 — preventing one mega-citation outlier (e.g., AlphaFold
 * with thousands of cites/yr) from overwhelming the composite.
 *
 * Returns 0 when citations are missing/zero or the paper has no year.
 */
function citationScore(paper: Paper): number {
  const citations = Number(paper.citation_count ?? paper.citationCount ?? 0);
  if (!Number.isFinite(citations) || citations <= 0) return 0;
  const year = Number(
    paper.year ?? paper.publication_year ?? paper.publicationDate?.slice?.(0, 4) ?? 0,
  );
  if (!Number.isFinite(year) || year < 1900) return 0;
  const age = Math.max(1, new Date().getUTCFullYear() - year + 1);
  const rate = citations / age;
  const scaled = Math.log(1 + rate) / CITATION_RATE_LOG_CEILING;
  return Math.max(0, Math.min(1, scaled));
}

/**
 * Reorder a relevance-qualified paper list by composite score, descending.
 * Returns a new array. Does not mutate input. Does not drop any papers —
 * order only.
 *
 * When `region` weight is 0 (user picked Global), redistributes that 0.05
 * onto similarity so weights still sum to 1.0 and the score stays comparable.
 */
export function rerankMerged(
  papers: Paper[],
  filters?: RerankFilters,
  options?: { query?: string; weights?: RerankWeights },
): Paper[] {
  const weights = options?.weights ?? DEFAULT_RERANK_WEIGHTS;
  const matcher = resolveRegionMatcher(filters, weights.region, options?.query);

  // If region weight collapsed to 0, give it to similarity so the user still
  // gets a 1.0-summed score and doesn't suddenly see less relevant ranking.
  const effectiveSim = matcher.weight === 0
    ? weights.similarity + weights.region
    : weights.similarity;

  const scored = papers.map((paper) => {
    const sim = similarityScore(paper);
    const rig = rigorScore(paper);
    const rec = recencyScore(paper);
    const reg = regionMatchScore(paper, matcher.regex);
    const cit = citationScore(paper);
    const fts = ftsScore(paper);
    // Phase 1.4b directness + 1.4f review-role bonus — categorical bonuses
    // added directly to composite (not weighted-factor) since they're
    // discrete labels rather than continuous metrics.
    const dir = directnessScore(paper);
    const rev = reviewBonus(paper);
    const score =
      effectiveSim * sim +
      weights.rigor * rig +
      weights.recency * rec +
      matcher.weight * reg +
      weights.citation * cit +
      weights.fts * fts +
      dir +
      rev;
    // Attach the composite score for downstream selectTopKDiverse to use as
    // a trade-off baseline against crowding penalties. Mutation is consistent
    // with the existing pattern (classifyAll mutates paper.classification).
    (paper as Paper)._compositeScore = score;
    return { paper, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ paper }) => paper);
}

/**
 * Detect whether a query is about Latin America / the Caribbean.
 * Used to gate the Spanish/Portuguese variant in query expansion.
 */
export function queryMentionsLAC(query: string): boolean {
  return LAC_REGEX.test(query);
}

// ---------------------------------------------------------------------------
// Density-aware top-K selection (Phase 1.4)
// ---------------------------------------------------------------------------
//
// rerankMerged() above produces a pure score-sorted list. That order is
// optimal for "does this paper match" but ignores three real issues:
//
//   1. Duplicates / version collapse — q06 ("immigration and native wages")
//      returns Card 1990 in 3 forms (the Mariel paper, the AER version, an
//      NBER WP) all in top-20. That's one finding eating three slots.
//   2. Source / venue crowding — q03 ("AI on labor in LAC") top-20 includes
//      8 "Digital Economy" / "Digital Health" papers from a handful of
//      bibliometric journals. Same finding repeated.
//   3. Methodology cluster — dense topics return 12+ observational papers
//      in a row; one well-designed RCT or review buried beneath.
//
// The fix is a greedy top-K selector that runs AFTER the composite score:
// walk the pool in score order, track what's already selected, apply soft
// penalties to candidates whose signal is over-represented. Selection
// becomes "highest score among remaining, minus crowding penalties earned
// from what's already in the set."
//
// Phased rollout (this file is built up incrementally — see commits):
//   Phase 1.4a (here): duplicate / version collapse only
//   Phase 1.4d: venue_kind soft crowding
//   Phase 1.4e: source_family soft crowding (waits on backfill)
//   Phase 1.4f: review/synthesis role slot
//   Phase 1.4g: weak-method clustering
//
// IMPORTANT: scripts/eval-gold.mjs mirrors this selection logic. If you
// add a penalty term here, mirror it there and re-pin baseline.json.

/** Selection pool taken from the top of rerankMerged. ~150 gives the diverse
 *  selector enough breadth to swap a duplicate at position 5 for a varied
 *  paper at position 35 without leaving the relevance-qualified tier. */
export const DEFAULT_SELECTION_POOL_SIZE = 200;

function normDoiKey(doi: string | null | undefined): string {
  if (!doi) return "";
  return String(doi).toLowerCase().trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
}

/**
 * Normalize a title for duplicate detection. Strips working-paper qualifiers
 * (NBER WP, IZA DP, SSRN, CESifo), preprint markers, accents, punctuation,
 * leading articles, and collapses whitespace. The result is a comparison key,
 * not display text.
 */
function normTitleKey(title: string | null | undefined): string {
  if (!title) return "";
  return String(title)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Working-paper series qualifiers that vary between WP and journal versions:
    .replace(/\bnber\s+working\s+paper\s+(no\.?\s+)?\d+\b/g, "")
    .replace(/\biza\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, "")
    .replace(/\bssrn\s+\d+\b/g, "")
    .replace(/\bcesifo\s+(working\s+paper|wp)\s+(no\.?\s+)?\d+\b/g, "")
    .replace(/\bcepr\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, "")
    .replace(/\(working\s+paper\)/g, "")
    .replace(/\(preprint\)/g, "")
    .replace(/\(revised\)/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SelectTopKResult {
  selected: Paper[];
  /** How many candidates were skipped because their DOI/title key matched
   *  one already selected. Useful as an eval metric — non-zero means
   *  rerankMerged was putting duplicates in the user-visible window. */
  duplicatesSkipped: number;
}

/**
 * Phase 1.4d (venue_kind crowding) — INVESTIGATED, DROPPED.
 *
 * The venue_kind column is 100% populated but the distribution is 91%
 * "journal" (from a 50k-row sample). Any meaningful crowding penalty on
 * the dominant value forced top-20 toward low-relevance papers in minority
 * categories (working_paper_series, institutional_publication) — i.e.,
 * "artificial diversity" not "prevent pathological domination." Tested
 * version (0.02 per excess paper) regressed canary_top20 0.254 → 0.186.
 *
 * The signal we actually want is at the `venue` granularity (specific
 * journal name) — top-20 already has avg 14.68 unique venues, so the
 * remaining 5 collisions are usually natural (same topic → same journals),
 * not pathological.
 *
 * Note on `source_family`: nulls are by design (many venues don't map to
 * a defined source_family). It should NOT be used as an important ranking
 * signal — at best a light auxiliary penalty on the ~7-10% of papers that
 * carry a value.
 *
 * Keeping the no-op stub here so the greedy-selection loop still has the
 * penalty hook for Phase 1.4g (weak-method crowding) which uses the same
 * shape but on a different field.
 */
function venueKindCrowdingPenalty(_paper: Paper, _counts: Map<string, number>): number {
  return 0;
}

/**
 * Phase 1.4g — weak-method crowding penalty.
 *
 * methodology_design distribution (in classified ~60% of corpus):
 *   Observational  31%  ← weak (penalize crowding)
 *   Review         21%  (boosted by reviewBonus, not penalized here)
 *   Theoretical     8%  ← weak (no empirical content)
 *   Descriptive     8%  ← weak (no causal claim)
 *   RCT             7%
 *   Qualitative     6%
 *   DiD             4%
 *   IV              3%
 *   Other / Survey  3%
 *
 * Goal: prevent top-20 from being 12+ observational/descriptive papers,
 * which the user named as a real failure mode in dense topics. Do NOT
 * penalize repeated RCT/DiD/IV/RDD — those are high-quality causal
 * evidence and clustering them is the correct outcome.
 *
 * Soft penalty starts after 4 weak-method papers in selected set, to give
 * room for typical retrieval (where observational often dominates the
 * pool). +0.015 per excess weak-method paper, capped at 0.06. Never
 * excludes — a weak-method paper with 0.06+ relevance lead still wins.
 */
const WEAK_METHODS = new Set(["observational", "theoretical", "descriptive"]);

function weakMethodCrowdingPenalty(paper: Paper, counts: Map<string, number>): number {
  const md = String(paper.methodology_design ?? "").toLowerCase();
  if (!WEAK_METHODS.has(md)) return 0;
  const count = counts.get("__weak__") ?? 0;
  if (count < 3) return 0; // first 4 weak-method papers: free
  const excess = count - 2; // 1 at count=3, 2 at count=4, ...
  return Math.min(0.015 * excess, 0.06);
}

/**
 * Greedy top-K selection over a score-sorted candidate pool.
 *
 * Combines:
 *   Phase 1.4a — duplicate / version collapse (hard skip)
 *   Phase 1.4d — venue_kind soft crowding penalty
 *
 * Algorithm: at each position 1..k, walk the remaining candidates, compute
 * effective_score = composite_score - crowding_penalties, pick the highest.
 * Update crowding counters from the picked paper. Duplicates are hard-skipped
 * (effective_score = -∞ equivalent).
 *
 * Complexity: O(k * pool_size). With k=100 and pool=150 that's 15k score
 * evaluations per query — negligible.
 */
export function selectTopKDiverse(
  papers: Paper[],
  k: number,
): SelectTopKResult {
  // Pass 1 (1.4a): linear walk through score-sorted papers, collapse
  // duplicates. First occurrence wins. This is decoupled from crowding so
  // we can't accidentally count the same duplicate multiple times (a bug
  // we hit when mutating remaining during iteration).
  const dedupedPool: Paper[] = [];
  const seenDois = new Set<string>();
  const seenTitleKeys = new Set<string>();
  let duplicatesSkipped = 0;

  for (const p of papers) {
    const doi = normDoiKey(p.canonical_doi ?? p.canonicalDoi ?? p.doi);
    const titleKey = normTitleKey(p.title);
    if ((doi && seenDois.has(doi)) || (titleKey && seenTitleKeys.has(titleKey))) {
      duplicatesSkipped++;
      continue;
    }
    dedupedPool.push(p);
    if (doi) seenDois.add(doi);
    if (titleKey) seenTitleKeys.add(titleKey);
  }

  // Pass 2 (1.4d+): greedy crowding-aware selection over the deduped pool.
  // At each position, walk remaining candidates, compute
  // effective_score = composite_score - crowding_penalty, pick max.
  const selected: Paper[] = [];
  const venueKindCounts = new Map<string, number>();
  const methodCounts = new Map<string, number>();
  const remaining = new Set<number>(dedupedPool.map((_, i) => i));

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestEffective = -Infinity;

    for (const i of remaining) {
      const p = dedupedPool[i];
      const base = Number(p._compositeScore ?? 0);
      const crowding =
        venueKindCrowdingPenalty(p, venueKindCounts) +
        weakMethodCrowdingPenalty(p, methodCounts);
      const effective = base - crowding;
      if (effective > bestEffective) {
        bestEffective = effective;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    const picked = dedupedPool[bestIdx];
    selected.push(picked);
    remaining.delete(bestIdx);

    const vk = picked.venue_kind ?? picked.venueKind ?? null;
    if (vk) {
      const key = String(vk);
      venueKindCounts.set(key, (venueKindCounts.get(key) ?? 0) + 1);
    }
    const md = String(picked.methodology_design ?? "").toLowerCase();
    if (WEAK_METHODS.has(md)) {
      methodCounts.set("__weak__", (methodCounts.get("__weak__") ?? 0) + 1);
    }
  }

  return { selected, duplicatesSkipped };
}
