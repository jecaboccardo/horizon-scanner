import { populationMatcher } from './populationExpander.ts';
import { passesGate } from "./relevanceBackbone.ts";

/**
 * supabase/functions/_shared/rerank.ts
 *
 * Composite-score rerank applied AFTER the per-facet relevance gate
 * (directIndirectClassifier). The gate already filtered out off-topic papers
 * — anything reaching this function has cleared the geometric-mean threshold
 * on every required facet. This rerank only orders the qualified pool.
 *
 * NOTE (2026-07-08): scripts/eval-gold.mjs no longer mirrors the scoring — it
 * now IMPORTS the real rerankUnified/orderByChannel/selectTopKDiverse from this
 * file and replays the production ranking path directly. If you change scoring
 * here, just re-run the eval and re-pin evals/baseline.json (no mirror to sync).
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
  /** Population focus chips from the search-clarifier UI.
   *  Used for a soft ADDITIVE boost — never a filter/drop. */
  populationFocus?: string[];
}

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

// ── Relevance gate (2026-06-14, FLAG-GATED, default OFF until eval-validated) ──
// Root cause it fixes: the P0 citation gate in rerankMerged lets any paper
// classified `direct-*` ESCAPE citation damping AND collect the +0.07/+0.10
// directness bonus. directIndirectClassifier mislabels some genuinely off-topic
// LOW-cosine papers as `direct-global` (live example: a cosine-0.385 "Multiple
// Intelligences" book, 13,737 cites), so their citation rides into the top-50
// over on-topic papers (de Hoyos 2018, cosine 0.795, SMS5, was dropped). This
// gate makes the escape cosine-aware: a REAL (non-synthetic) vector hit whose
// raw cosine is below RELEVANCE_FLOOR cannot be treated as on-topic regardless
// of its classifier label, and loses its positive directness bonus — UNLESS it
// qualifies for the foundational escape (highly-cited pre-2020 paper just below
// the floor, so seminal-but-moderate-cosine canon is not gated out). Synthetic-
// similarity channel papers are untouched (their `similarity` is a placeholder,
// not a cosine; the existing isSynthetic branch already governs their topicality).
// Diagnostics + multi-query validation: memory
// project-rerank-relevance-gate-finding-2026-06-14.
function readBoolEnv(key: string): boolean {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  const v = (denoEnv && typeof denoEnv.get === "function")
    ? denoEnv.get(key)
    // deno-lint-ignore no-explicit-any
    : (globalThis as any).process?.env?.[key];
  return v === "1" || v === "true";
}
const RELEVANCE_GATE_ON = readBoolEnv("RELEVANCE_GATE_RAW_COSINE");
export interface BackboneConfig { on: boolean; gateJoint: boolean; gateFloors: boolean; escapeDelta: number; }
/**
 * Relevance-backbone feature config (2026-06-15). Master flag RELEVANCE_BACKBONE
 * enables all three sub-toggles; each sub-flag can also be set independently
 * (used by the offline ablation rig to measure toggles in isolation).
 *   RB_GATE_JOINT  — cosine-gate multiplier on rerankHybrid joint/time-floor
 *   RB_GATE_FLOORS — foundational + region floors honour passesGate
 *   RB_ESCAPE_TIGHT — tighten the foundational escape (0.10 → 0.05)
 */
export function backboneConfig(): BackboneConfig {
  const master = readBoolEnv("RELEVANCE_BACKBONE");
  return {
    on: master,
    gateJoint: master || readBoolEnv("RB_GATE_JOINT"),
    gateFloors: master || readBoolEnv("RB_GATE_FLOORS"),
    escapeDelta: readBoolEnv("RB_ESCAPE_TIGHT") ? 0.05 : 0.10,
  };
}
const GATE_FAIL_MULT = 0.05; // hard damping for real-vector papers that fail the cosine gate
const RELEVANCE_FLOOR = 0.50;         // raw query·paper cosine below this = not a real topical match
const RELEVANCE_FLOOR_ESCAPE = 0.40;  // foundational-escape lower bound for highly-cited pre-2020 canon
// Channel-surfaced papers carry a SYNTHETIC similarity placeholder (not a real
// cosine); the raw-cosine gate must not fire on them. Module-level (was rebuilt
// per-paper inside rerankMerged).
const SYNTHETIC_SRCS = new Set([
  "topic_geo_channel", "foundational_channel_sql", "foundational_channel_fts",
  "causal_channel", "recent_channel",
]);

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

// ── UX region buckets (wired to works.ux_region, 2026-06-13) ──────────────────
// The 6 region options the SearchClarifier offers map 1:1 to these buckets; an
// EXPLICIT region pick is matched against a paper's ux_region (derived from its
// geography[] — accurate + precomputed) instead of the old keyword regex, which
// had no keyword list at all for USA/Europe/Asia (they fell through to matching
// the literal lowercased key). The region filter stays SOFT (boost + floor in
// retrieval.ts, never a hard exclude) — global canon still surfaces.
//
// 🔁 Country→bucket map MUST stay in sync with scripts/_ux-region-derive.mjs
// (the column's source of truth) and supabase/migrations/20260613000001. The UX
// "United States" option maps to 'USA and Canada' (US+Canada grouped). Papers
// matching no bucket have ux_region=['Global'] in the DB.
const UX_REGION_BY_COUNTRY = new Map<string, string>();
const _addUx = (bucket: string, countries: string[]) =>
  countries.forEach((c) => UX_REGION_BY_COUNTRY.set(c.toLowerCase(), bucket));
_addUx("LAC", ["Brazil","Mexico","Colombia","Argentina","Chile","Peru","Ecuador","Bolivia","Uruguay","Paraguay","Venezuela","Costa Rica","Panama","Honduras","Guatemala","El Salvador","Nicaragua","Dominican Republic","Haiti","Jamaica","Trinidad and Tobago","Barbados","Guyana","Suriname","Belize","LAC","Central America","Caribbean","Latin America","Latin America and the Caribbean","Latin America and Caribbean","South America"]);
_addUx("Sub-Saharan Africa", ["Nigeria","Kenya","South Africa","Ethiopia","Ghana","Tanzania","Uganda","Africa"]);
_addUx("South & Southeast Asia", ["India","Pakistan","Bangladesh","Sri Lanka","Indonesia","Vietnam","Thailand","Philippines","Malaysia","Singapore","South Asia","Southeast Asia"]);
_addUx("USA and Canada", ["United States","Canada","US","USA"]);
_addUx("Europe & Central Asia", ["United Kingdom","Germany","France","Italy","Spain","Portugal","Netherlands","Sweden","Norway","Denmark","Finland","Switzerland","Austria","Belgium","Ireland","Greece","Poland","Turkey","Russia","Ukraine","Europe","UK"]);
_addUx("MENA", ["Egypt","Morocco","Middle East"]);

const UX_BUCKETS = new Set([
  "LAC", "Sub-Saharan Africa", "South & Southeast Asia",
  "USA and Canada", "Europe & Central Asia", "MENA",
]);

/** Derive a paper's UX region buckets from its geography[] (mirrors the
 *  precomputed works.ux_region column). Papers with no mapped country → []
 *  here (treated as 'Global' / out-of-region for any specific selection). */
export function uxRegionsOf(geography?: string[] | null): string[] {
  const out = new Set<string>();
  for (const tag of geography ?? []) {
    const b = UX_REGION_BY_COUNTRY.get(String(tag).toLowerCase());
    if (b) out.add(b);
  }
  return [...out];
}

/** Map a filters.regions value to its UX bucket name. Legacy/UI 'United States'
 *  → 'USA and Canada'; recognised buckets pass through; anything else → null. */
export function toUxBucket(region: string): string | null {
  const r = String(region ?? "").trim();
  if (r.toLowerCase() === "united states") return "USA and Canada";
  return UX_BUCKETS.has(r) ? r : null;
}

/** The set of UX buckets a region selection resolves to (empty = no specific
 *  region / global / all). Used by the region floor + boost. */
export function selectedUxBuckets(regions?: string[] | null): string[] {
  const out = new Set<string>();
  for (const r of regions ?? []) {
    const b = toUxBucket(r);
    if (b) out.add(b);
  }
  return [...out];
}

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

/** Additive score bonus when a paper's text matches the population focus chips.
 *  Sized ≤ region weight (0.087) so it reorders ties but cannot override a
 *  meaningfully better paper. NEVER used as a filter — non-matching papers stay. */
export const POPULATION_BOOST = 0.05;

/** Per-channel rerank weights — BO-optimised 2026-05-29.
 *  Used by rerankHybrid() (the active multi-channel path) so each channel scores
 *  the pool with its own true weights rather than a blended compromise.
 *  (rerankInterleaved — the prior multi-channel path — is retained for eval/probe
 *  scripts only; it is NOT called from any production path.)
 *  Single-channel queries still pass these via rerankWeightsOverride from the
 *  frontend; this copy lives server-side so the hybrid path can use them without
 *  an extra round-trip. Keep in sync with channelsToRerankWeights() in App.tsx. */
export const CHANNEL_RERANK_WEIGHTS: Record<string, Partial<RerankWeights>> = {
  // rigor 0.250→0.400 funded entirely from citation (0.196→0.046), keeping
  // similarity/region/recency/fts intact ("variant C", 2026-06-02). Chosen by the
  // cosine-relevance "rigorous-AND-relevant" eval (probe-causal-relevance-variants.mjs):
  // it maximises SMS≥4 papers that are ALSO topically relevant (true query·paper
  // cosine ≥ 0.6) in the top-20 — 17.3→18.8 such papers — with no loss of mean
  // relevance (meanCos of the SMS≥4 papers stays ~0.71). Beats OPT2 because it does
  // NOT cut similarity. NOTE: this dips sparse gold-canary recall, which is expected/
  // acceptable for a rigor channel — judge rigor changes by the cosine-relevance
  // metric, NOT all-canary recall. See report Part 5. Sum = 1.000.
  causal:        { similarity: 0.282, citation: 0.046, rigor: 0.400, recency: 0.021, region: 0.146, fts: 0.105 },
  // Variant-E (2026-06-10): rigor 0.038→0.080 funded from recency (0.022→0).
  // Eval-validated: canary_top20 0.308→0.323, 0 regressions across 24 gold queries.
  // Jensen 2010 (QJE, cit=1029) moves from #8 (accidental LAC hit) to #2 (correct
  // foundational placement). Recency weight is zero because foundational papers are
  // pre-2020 by definition — the weight did nothing, so funding rig from it is free.
  foundational:  { similarity: 0.213, citation: 0.633, rigor: 0.080, recency: 0.000, region: 0.023, fts: 0.071 },
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
 *
 * ⚠️ DEPRECATED for production (2026-06-11): rerankHybrid() is the live
 * multi-channel path (causal-mult × max-time × regionBoost). rerankInterleaved
 * is retained ONLY because eval/probe scripts (eval-phases, eval-fix1, probe-*)
 * still import it for historical baselines — do NOT wire it back into retrieval.
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
    // V3: foundational gets the pre-2020 age preference (foundational-only).
    const ranked = rerankMerged(papers, filters, { query, weights, agePreference: ch === "foundational" });
    if (ch !== "foundational") return ranked;
    // Variant-E foundational bonus/penalty (2026-06-10):
    // - Concept-match bonus: papers whose fts_rank > 0 (matched the focused concept
    //   terms used as query_text — e.g. "returns information schooling") get a small
    //   proportional boost capped at 0.10. Rewards on-topic seminal papers.
    // - Non-match penalty: papers with fts_rank=0 get their composite score
    //   multiplied by 0.88. Demotes off-topic mega-cited papers that share embedding
    //   space with the query but don't match concept terms (AI-in-education, school
    //   readiness classics, COVID papers). Never drops papers — order only.
    return ranked.map((p) => {
      const fts = ftsScore(p);
      let s = Number((p as Paper)._compositeScore ?? 0);
      s += Math.min(0.10, fts * 2.4); // concept-match bonus (proportional, cap 0.10)
      if (fts === 0) s *= 0.88;       // non-match penalty (multiplicative, never 0)
      (p as Paper)._compositeScore = s;
      return p;
    }).sort((a, b) => Number((b as Paper)._compositeScore ?? 0) - Number((a as Paper)._compositeScore ?? 0));
  });

  // --- Proportional slot allocation (Fix1, 2026-06-10) ---
  // Problem with strict 1/N round-robin: a channel that contributed only 1%
  // of the pool still gets 1/N ≈ 25% of the top-20 slots, crowding out
  // channels that contributed much more. Example: recent channel adds 6/734
  // papers (1%) but steals 5/20 slots from foundational (8% contribution),
  // pushing q09's Hoddinott from #3 to #35.
  //
  // Fix: allocate the first TOPK_FAIR slots proportionally to each channel's
  // pool contribution (floor: 1 slot each so no channel is silenced).
  // Remaining positions use the existing round-robin so every paper is ordered.
  const TOPK_FAIR = 20;
  const SOURCE_TO_CHANNEL: Record<string, string> = {
    causal_channel: "causal",
    foundational_channel_hyde: "foundational",
    foundational_channel_fts: "foundational",
    foundational_channel_sql: "foundational",
    recent_channel: "recent",
    topic_geo_channel: "lac",
  };
  const contrib: Record<string, number> = {};
  for (const ch of sorted) contrib[ch] = 0;
  for (const p of papers) {
    const ch = SOURCE_TO_CHANNEL[String(p._retrievalSource ?? "")];
    if (ch && contrib[ch] !== undefined) contrib[ch]++;
  }
  const totalPool = papers.length || 1;
  const slots = sorted.map((ch) => Math.max(1, Math.round(TOPK_FAIR * contrib[ch] / totalPool)));

  // Round-robin interleave: respect per-channel slot budgets for the first
  // TOPK_FAIR positions, then continue equally for the rest.
  const seen = new Set<string>();
  const result: Paper[] = [];
  const ptrs = rankings.map(() => 0);
  const used = slots.map(() => 0);

  while (result.length < papers.length) {
    let anyAdded = false;
    // If ALL channels have exhausted their proportional budgets while still inside
    // the TOPK_FAIR window, fall through to unconstrained round-robin. This happens
    // when most papers came from the main vector search (no channel-specific
    // _retrievalSource tag) so contrib=0 for every channel → slots=[1,1,1] → loop
    // would otherwise break after adding exactly N-channels papers (bug: pool=3).
    const anySlotLeft = sorted.some((_, i) => used[i] < slots[i]);
    for (let r = 0; r < rankings.length; r++) {
      // Within the first TOPK_FAIR slots, skip this channel if it has budget
      // remaining elsewhere (enforce proportional allocation). If all budgets
      // are exhausted, anySlotLeft=false and we skip this guard entirely.
      if (result.length < TOPK_FAIR && anySlotLeft && used[r] >= slots[r]) continue;
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
          used[r]++;
          anyAdded = true;
        }
        ptrs[r]++;
      }
    }
    if (!anyAdded) break; // all rankings genuinely exhausted
  }

  return result;
}

// ---------------------------------------------------------------------------
// rerankHybrid — multi-channel ranking (2026-06-11, lac→soft-boost same day)
//
// ⚠️ EVAL/ABLATION TOOLING ONLY (as of 2026-07-08). This function and
// rerankMerged() are NO LONGER wired into the production runtime — retrieval.ts
// ranks exclusively via rerankUnified(). They are retained solely as the baseline
// for the offline eval/ablation/probe harnesses (rerank-ablation.ts,
// rerank-multiquery-eval.ts, eval-gold.mjs, probe-*.mjs) and the rerank unit
// tests. Do NOT re-import them into the hot path. NOTE: eval-gold.mjs still mirrors
// this legacy path, so the ship-gate eval measures the legacy reranker, not
// rerankUnified — migrate the gate before deleting these functions.
//
// Replaces rerankInterleaved as the multi-channel entry point.
//
// Mental model:
//   • causal: quality dimension — when selected, it multiplies the joint score
//     (a paper that isn't rigorous can't ride citation/recency to the top).
//   • region: PRIORITIZATION, never exclusion — driven by the user's region
//     FILTER (filters.regions), NOT a channel. ANY selected region (LAC or
//     Sub-Saharan Africa or Asia …) is treated identically: a multiplier
//     (1 + REGION_PRIORITY × region_match) lifts in-region papers above
//     comparable out-of-region papers but keeps global canon (Jensen,
//     Hanushek — region_match=0) fully in the running at their base score.
//     The earlier harmonic-mean AND semantics zeroed out all global
//     foundational papers whenever a region was selected — wrong: users
//     selecting foundational+region want the global canon WITH the region
//     prioritized. (LAC is no longer special: it used to be a soft channel
//     while every other region was a hard `return false` exclude in
//     passesQualityFilters; that asymmetry silently dropped on-topic canon
//     like Jensen for a LAC info-on-returns query. Unified 2026-06-12.)
//   • time channels (foundational, recent): mutually exclusive time windows;
//     a paper is either pre-2020 seminal OR post-2020 frontier, not both →
//     OR semantics via max.
//
// When BOTH foundational and recent are active (time tension):
//   Each time channel gets a guaranteed floor of FLOOR_PCT × n papers,
//   selected by time_score × causal mult × region boost. Remaining slots
//   filled by the joint score. Prevents foundational vanishing when recent
//   dominates.
//
// Single channel: delegates to rerankMerged unchanged (region handled by the
// additive region weight + the region representation floor in retrieval.ts).
// ---------------------------------------------------------------------------

const TIME_CHANNELS = new Set(["foundational", "recent"]);

/** Region prioritization strength: an in-region paper gets a 1.6× multiplier on
 *  its base score; out-of-region papers keep 1.0×. Prioritizes the selected
 *  region (region-DOMINANT, reinforced by the region floor in retrieval.ts)
 *  without ever zeroing anyone out — global canon still ranks at base score. */
const REGION_PRIORITY = 0.6;

export function rerankHybrid(
  papers: Paper[],
  filters: RerankFilters | undefined,
  query: string,
  channels: string[],
  /** Final evidence cap — used to size the time-channel floors. Default 50. */
  evidenceCap: number = 50,
): Paper[] {
  // Single channel: use that channel's weights directly (unchanged behaviour).
  // NOTE: the RB_GATE_JOINT cosine-gate (gateMult below) covers only the
  // multi-channel joint path — the case the de Hoyos bug + ablation exercise.
  // Single-channel still relies on rerankMerged's own RELEVANCE_GATE_RAW_COSINE
  // gate. Unifying single-channel under the RB gate is a tracked follow-up
  // (it shifts the region-less path eval-gold exercises → needs the eval gate).
  if (channels.length <= 1) {
    const ch = channels[0];
    return rerankMerged(papers, filters, {
      query,
      weights: ch && CHANNEL_RERANK_WEIGHTS[ch]
        ? { ...DEFAULT_RERANK_WEIGHTS, ...CHANNEL_RERANK_WEIGHTS[ch] }
        : undefined,
      agePreference: ch === "foundational",
    });
  }

  const hasCausal = channels.includes("causal");
  const timeChs   = channels.filter((c) => TIME_CHANNELS.has(c));

  // Region prioritization is driven by the region FILTER, not a channel. Any
  // selected region (LAC or other) resolves to a keyword regex; in-region
  // papers get a ≥1 multiplier, out-of-region papers keep 1.0 (never excluded).
  // Only an EXPLICIT region pick activates the strong multiplier — query-implied
  // LAC (resolveRegionMatcher gives weight>0 when the query text mentions LAC)
  // keeps only the pre-existing additive region weight, so "no region selected"
  // stays truly global (no lean). This also makes the change a no-op on the
  // region-less eval/canary set.
  const _regionMatcher = resolveRegionMatcher(filters, DEFAULT_RERANK_WEIGHTS.region, query);
  const regionActive   = (filters?.regions?.length ?? 0) > 0 && _regionMatcher.weight > 0;
  const timeTension = timeChs.length > 1; // foundational + recent both active

  const _cfg = backboneConfig();
  const _topCos = papers.reduce((m, p) => Math.max(m, Number(p.similarity ?? 0)), 0);
  const gateMult = (p: Paper): number => {
    if (!_cfg.gateJoint) return 1;
    const ok = passesGate({
      cosine: Number(p.similarity ?? 0),
      citations: Number(p.citation_count ?? p.citationCount ?? 0),
      year: Number(p.year ?? p.publication_year ?? 0),
      topCos: _topCos,
      isSynthetic: SYNTHETIC_SRCS.has(String(p._retrievalSource ?? "")),
      fts: Number(p.fts_rank ?? 0),
    }, _cfg.escapeDelta);
    return ok ? 1 : GATE_FAIL_MULT;
  };

  // Compute per-channel composite scores by running rerankMerged for each channel.
  // rerankMerged mutates _compositeScore — capture into a separate Map each time.
  const chScores = new Map<string, Map<string, number>>();
  for (const ch of channels) {
    rerankMerged(papers, filters, {
      query,
      weights: { ...DEFAULT_RERANK_WEIGHTS, ...(CHANNEL_RERANK_WEIGHTS[ch] ?? {}) },
      agePreference: ch === "foundational",
    });
    const snap = new Map<string, number>();
    for (const p of papers) snap.set(p.id ?? "", Number((p as Paper)._compositeScore ?? 0));
    chScores.set(ch, snap);
  }

  const getScore = (p: Paper, ch: string): number =>
    chScores.get(ch)?.get(p.id ?? "") ?? 0;

  // Region boost — prioritizes, never excludes (multiplier ≥ 1 for everyone).
  const regionBoost = (p: Paper): number =>
    regionActive ? 1 + REGION_PRIORITY * regionMatchScore(p, _regionMatcher) : 1;

  // Joint score: causal_mult × max(time scores) × lac_boost.
  // "Rigorous (if causal asked) AND excellent in at least one selected time
  //  window, with LAC papers lifted above comparable global papers."
  const jointScore = (p: Paper): number => {
    const cs = hasCausal ? getScore(p, "causal") : 1.0;
    const ts = timeChs.length === 0 ? 1.0
      : Math.max(...timeChs.map((c) => getScore(p, c)));
    return cs * ts * regionBoost(p) * gateMult(p);
  };

  if (!timeTension) {
    // No time tension: pure joint ordering.
    return [...papers]
      .map((p) => ({ p, s: jointScore(p) }))
      .sort((a, b) => b.s - a.s)
      .map(({ p }) => p);
  }

  // Hybrid mode: time tension (foundational + recent both selected).
  // Give each time channel a floor of ~20% of the final evidence cap (10/50),
  // selected by time_score × causal mult × lac boost. Remaining positions
  // filled by the joint score.
  const FLOOR_PER_TIME_CH = Math.max(5, Math.round(evidenceCap * 0.20));
  const seen = new Set<string>();
  const result: Paper[] = [];

  for (const tCh of timeChs) {
    [...papers]
      .filter((p) => !seen.has(p.id ?? ""))
      .map((p) => ({
        p,
        s: getScore(p, tCh) * (hasCausal ? getScore(p, "causal") : 1.0) * regionBoost(p) * gateMult(p),
      }))
      .sort((a, b) => b.s - a.s)
      .slice(0, FLOOR_PER_TIME_CH)
      .forEach(({ p }) => {
        seen.add(p.id ?? "");
        result.push(p);
      });
  }

  // Fill remaining positions by joint score.
  [...papers]
    .filter((p) => !seen.has(p.id ?? ""))
    .map((p) => ({ p, s: jointScore(p) }))
    .sort((a, b) => b.s - a.s)
    .forEach(({ p }) => result.push(p));

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
  /** UX buckets the EXPLICIT region pick resolves to (wired to ux_region).
   *  Non-empty → match via uxRegionsOf(geography); empty → fall back to regex
   *  (query-implied LAC). */
  buckets: string[];
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
      return { regex: LAC_REGEX, weight: baseWeight, buckets: [], label: "LAC (query-implied)" };
    }
    return { regex: null, weight: 0, buckets: [], label: "no region intent (weight=0)" };
  }

  const lower = regions.map((r) => r.toLowerCase());

  // User explicitly picked Global → no regional weighting.
  if (lower.some((r) => r === "global" || r === "any" || r === "world")) {
    return { regex: null, weight: 0, buckets: [], label: "global (weight=0)" };
  }

  // Wired to ux_region (2026-06-13): an explicit region pick resolves to UX
  // buckets matched against the paper's geography-derived ux_region — accurate
  // for ALL regions (the old keyword regex had no list for USA/Europe/Asia).
  const buckets = selectedUxBuckets(regions);

  // All 6 buckets selected → no regional lean (treat as global).
  if (buckets.length >= UX_BUCKETS.size) {
    return { regex: null, weight: 0, buckets: [], label: "all regions (weight=0)" };
  }

  if (buckets.length === 0) {
    // Unrecognised region(s) — fall back to LAC keyword regex (legacy behaviour).
    return { regex: LAC_REGEX, weight: baseWeight, buckets: [], label: "LAC (fallback)" };
  }

  return {
    regex: null,
    weight: baseWeight,
    buckets,
    label: buckets.join("+"),
  };
}

/** Region match: 1 if the paper is in any selected region, else 0.
 *  Explicit region pick → match via ux_region buckets (geography-derived).
 *  Query-implied LAC (no filter) → regex over title+abstract+geography. */
function regionMatchScore(paper: Paper, matcher: ResolvedRegionMatcher): number {
  if (matcher.buckets.length > 0) {
    const paperBuckets = uxRegionsOf(paper.geography as string[] | undefined);
    return paperBuckets.some((b) => matcher.buckets.includes(b)) ? 1 : 0;
  }
  if (!matcher.regex) return 0;
  const haystack = [
    paper.title ?? "",
    paper.abstract ?? "",
    Array.isArray(paper.geography) ? paper.geography.join(" ") : "",
  ].join(" ");
  return matcher.regex.test(haystack) ? 1 : 0;
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
  let base: number;
  if (Number.isFinite(sim) && sim > 0) {
    base = Math.min(1, sim);
  } else {
    // Option A (2026-05-21): FTS-only papers (Postgres ts_rank_cd, loosely
    // "BM25" — NOT Okapi BM25) arrive with similarity=0 because
    // match_works_v2's FULL OUTER JOIN includes FTS-only hits that never had a
    // vector match. The 0.50·sim weight crushes them even when their ftsRank is
    // high. Grant a synthetic similarity capped at 0.45 (just below the vector
    // threshold) so they can compete without displacing strong vector hits.
    // NOTE: this branch is COMPOSITE-PATH only — dormant under RB_UNIFIED=1
    // (prod), where rerankUnified attaches a real cosine to every candidate.
    // Primary beneficiaries: Spanish-language LAC institutional documents and
    // keyword-specific policy reports that nomic embeddings underperform on.
    const fts = Number(paper.ftsRank ?? paper.fts_rank ?? 0);
    base = (Number.isFinite(fts) && fts > 0) ? Math.min(0.45, fts * 1.8) : 0;
  }
  // Layer 2 floor (2026-06-02): keyword/channel-surfaced papers carry a
  // synthetic similarity (causal slice 0.44, recent 0.42, FTS cap 0.45) that
  // sits below the real cosine (~0.6–0.7) of recent vector hits. Since every
  // channel weights similarity 0.21–0.28, that cap buries SEMINAL high-rigor
  // papers that only match by keyword (no vector hit, vocabulary gap) — e.g.
  // the landmark cash-transfer RCTs (SMS5, 164–281 cites) were dropped from the
  // top-100 even when present in the pool. Floor synthetic similarity at 0.60
  // when the paper is independently high-rigor so rigor/citation can carry it.
  // Trigger on RIGOR ONLY — NOT citation — so off-topic mega-cited papers
  // (Lancet/ACS Nano, SMS≤2) are NOT floored and stay catchable by the P0
  // citation gate in rerankMerged. Real vector hits (base > 0.46) are untouched.
  if (base > 0 && base <= 0.46) {
    const sms = Number(paper.sms_level ?? paper.smsLevel ?? 0);
    if (sms >= 4) base = Math.max(base, 0.60);
  }
  return base;
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
  options?: { query?: string; weights?: RerankWeights; agePreference?: boolean },
): Paper[] {
  const weights = options?.weights ?? DEFAULT_RERANK_WEIGHTS;
  // === V3 (foundational age preference): pre-2020 +bonus, 2020+ −penalty. Only
  // when caller declares the channel foundational; no-op for causal/recent/lac. ===
  const agePref = options?.agePreference === true;
  const AGE_BONUS = 0.05;
  const AGE_PENALTY = 0.05;
  const matcher = resolveRegionMatcher(filters, weights.region, options?.query);

  // Population focus boost — computed ONCE per rerank call.
  // Inline array-guard: accept string | string[] | undefined robustly.
  const _pf = filters?.populationFocus;
  const popFocus: string[] = Array.isArray(_pf) ? _pf : (_pf ? [_pf as string] : []);
  const popRe = populationMatcher(popFocus);

  // If region weight collapsed to 0, give it to similarity so the user still
  // gets a 1.0-summed score and doesn't suddenly see less relevant ranking.
  const effectiveSim = matcher.weight === 0
    ? weights.similarity + weights.region
    : weights.similarity;

  const scored = papers.map((paper) => {
    const sim = similarityScore(paper);
    const rig = rigorScore(paper);
    const rec = recencyScore(paper);
    const reg = regionMatchScore(paper, matcher);
    const cit = citationScore(paper);
    const fts = ftsScore(paper);
    // Phase 1.4b directness + 1.4f review-role bonus — categorical bonuses
    // added directly to composite (not weighted-factor) since they're
    // discrete labels rather than continuous metrics.
    // Relevance gate (flag-gated): a real (non-synthetic) vector hit whose raw
    // cosine is below the floor is not a genuine topical match — even if the
    // classifier labeled it `direct`. When it fails, it (1) cannot use the
    // direct-class on-topic escape from the P0 citation gate below, and (2)
    // loses its positive directness bonus. Foundational escape spares highly-
    // cited pre-2020 canon sitting just under the floor.
    const rawCos = Number(paper.similarity ?? 0);
    const isSyntheticSrc = SYNTHETIC_SRCS.has(String(paper._retrievalSource ?? ""));
    const citForGate = Number(paper.citation_count ?? paper.citationCount ?? 0);
    const yrForGate = Number(paper.year ?? paper.publication_year ?? paper.publicationDate?.slice?.(0, 4) ?? 0);
    const foundEscape = citForGate >= 75 && yrForGate >= 1900 && yrForGate < 2020 && rawCos >= RELEVANCE_FLOOR_ESCAPE;
    const gateFails = RELEVANCE_GATE_ON && !isSyntheticSrc && rawCos > 0 && rawCos < RELEVANCE_FLOOR && !foundEscape;

    const dir = gateFails ? Math.min(0, directnessScore(paper)) : directnessScore(paper);
    const rev = reviewBonus(paper);
    // V3 age nudge (foundational-only; agePref=false → 0, no-op elsewhere)
    let ageAdj = 0;
    if (agePref) {
      const yr = Number(paper.year ?? paper.publication_year ?? paper.publicationDate?.slice?.(0, 4) ?? 0);
      if (Number.isFinite(yr) && yr >= 1900) ageAdj = yr < 2020 ? AGE_BONUS : -AGE_PENALTY;
    }
    // Population focus boost — ADDITIVE ONLY; non-matching papers are NOT dropped.
    // popRe is null when no focus is set → boost is always 0, identical behavior.
    const popHit = popRe && popRe.test(
      `${paper.title ?? ''} ${paper.abstract ?? ''} ${Array.isArray(paper.geography) ? paper.geography.join(' ') : ''}`,
    );
    const popBoost = popHit ? POPULATION_BOOST : 0;

    // P0 citation relevance gate (2026-06-02): a topically-weak paper must not
    // ride raw citation count into the top. This is what let the foundational
    // channel (citation weight 0.633) surface off-topic mega-cited papers — The
    // Lancet GBD (13,895c), ACS Nano nanozyme papers, PRISMA (13,026c) — into an
    // economics brief. "Topically weak" = low (post-Layer-2-floor) similarity
    // AND not classified as a direct topical match AND weak full-text rank.
    // Seminal on-topic papers are unaffected: SMS≥4 papers are floored to 0.60
    // by Layer 2, on-topic papers classify "direct-*", and real keyword hits
    // (Spanish/LAC FTS Option-A docs) carry ftsRank > 0 — each escapes the gate.
    const cls = String(paper.classification ?? "");
    // === V1 (P0 gate ignores synthetic similarities) ===
    // Keyword/topic-channel papers carry a SYNTHETIC similarity placeholder
    // (topic_geo 0.55, found_sql 0.45, found_fts 0.72, causal 0.44, recent 0.42),
    // not a real query·paper cosine. The base gate trips only on sim<0.50, so
    // synthetic 0.55 (and Layer-2-floored 0.60) sail past it → off-topic
    // mega-cited biomed/ML papers ride citation=0.633 into foundational top-20.
    // V1: synthetic-similarity papers are gate-eligible regardless of the
    // placeholder value; they ESCAPE only if genuinely on-topic (direct-* class
    // OR real ftsRank ≥ 0.20). Real vector papers keep the original sim<0.50 rule.
    const isSynthetic = isSyntheticSrc;
    // gateFails (flag-gated) forces a low-cosine real-vector paper off-topic
    // even when mislabeled `direct`, so its citation gets damped below.
    const onTopic = !gateFails && (cls.startsWith("direct") || fts >= 0.20);
    const topicallyWeak = isSynthetic
      ? !onTopic
      : (gateFails || (sim < 0.50 && !cls.startsWith("direct") && fts < 0.20));
    const citFactor = topicallyWeak ? 0.20 : 1.0;
    const score =
      effectiveSim * sim +
      weights.rigor * rig +
      weights.recency * rec +
      matcher.weight * reg +
      weights.citation * cit * citFactor +
      weights.fts * fts +
      dir +
      rev +
      ageAdj +
      popBoost;
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
// rerankUnified — relevance-first unified reranker (2026-06-15, Tasks U2+U3)
//
// Replaces the multi-stream channel model for the RELEVANCE_BACKBONE path.
// Channels are BOUNDED MULTIPLICATIVE BOOSTS — they only ever lift a paper,
// never drop it. Off-topic papers sink by having low cosine; the boosts for
// causal/foundational/recent/region only matter when cosine is meaningful.
//
//   score = clamp(realCosine, 0, 1) × (1 + Σ active boosts)
//
// Order only — drops nothing.
// ---------------------------------------------------------------------------

export interface BoostProfile {
  causal: number;
  foundational: number;
  recent: number;
  region: number;
}

export const BOOST_PROFILES: Record<string, BoostProfile> = {
  conservative: { causal: 0.30, foundational: 0.20, recent: 0.15, region: 0.30 },
  moderate:     { causal: 0.50, foundational: 0.30, recent: 0.20, region: 0.60 },
  aggressive:   { causal: 0.80, foundational: 0.50, recent: 0.30, region: 1.00 },
};

// Per-user learned methodology-domain weight (RB_DOMAIN_WEIGHTS, default OFF).
// Closes the learning-agent loop: `domain_weights.weight` ∈ [0.5, 2.0], centered
// at 1.0, is folded into the unified score as a BOUNDED ADDITIVE boost — the same
// "boosts reorder, never gate" contract as causal/foundational/region:
//   mult += scale × clamp(weight − 1, −0.5, +1.0)
// A maxed weight (2.0) lifts a paper of that methodology by ≤ +scale; a min (0.5)
// trims it. It reorders WITHIN the relevance-gated pool and can never float an
// off-topic paper over an on-topic one (cos still dominates). Env-tunable scale.
export function domainWeightBoostScale(): number {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  // deno-lint-ignore no-explicit-any
  const raw = (denoEnv?.get?.("RB_DOMAIN_WEIGHT_BOOST")) ?? (globalThis as any).process?.env?.RB_DOMAIN_WEIGHT_BOOST;
  const v = Number(raw ?? 0.15);
  return Number.isFinite(v) && v >= 0 ? v : 0.15;
}

// Per-user POSITIVE feedback boost (RB_PROMOTE_FEEDBACK, default OFF). A paper the
// user liked/saved/added on a semantically-similar past query (see promoteFilter.ts)
// gets a bounded, relevance-ramp-gated lift: mult += scale × querySim × ramp(cos).
// Reorders within the relevant pool — never pins, never floats off-topic papers.
export function promoteFeedbackBoostScale(): number {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  // deno-lint-ignore no-explicit-any
  const raw = (denoEnv?.get?.("RB_PROMOTE_BOOST")) ?? (globalThis as any).process?.env?.RB_PROMOTE_BOOST;
  const v = Number(raw ?? 0.25);
  return Number.isFinite(v) && v >= 0 ? v : 0.25;
}

export function unifiedProfileName(): string {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  // deno-lint-ignore no-explicit-any
  const v = (denoEnv?.get?.("RB_BOOST_PROFILE")) ?? (globalThis as any).process?.env?.RB_BOOST_PROFILE;
  // Default = conservative (chosen 2026-06-15): same on-topic foundational canon
  // as moderate/aggressive (Jensen 2010 #3, 6 genuine seminal papers, 0 off-topic
  // leaks) with the highest meanCos (0.637) and rigor (SMS≥4=27). Env-overridable.
  return (v && BOOST_PROFILES[v]) ? v : "conservative";
}

function envNum(key: string, def: number): number {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  // deno-lint-ignore no-explicit-any
  const raw = (denoEnv?.get?.(key)) ?? (globalThis as any).process?.env?.[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

// Region-boost relevance ramp (2026-06-16). The region boost must only lift
// papers that are ALREADY topically relevant. Without this, a weakly-on-topic
// in-region paper (e.g. an adjacent LAC health-systems paper at cos~0.52) gets
// multiplied by (1 + region) ABOVE a more-relevant global paper at cos~0.68 —
// the evidence-table LAC-noise mechanism. The ramp tapers the region multiplier
// from 0 (at/below LO) to full (at/above HI), so off-topic in-region papers keep
// only their raw cosine rank while genuine on-topic LAC papers still get
// prioritized. Set RB_REGION_RAMP_HI<=LO (or RB_REGION_RAMP=0) to disable (=old
// flat boost). LO/HI are env-tunable for eval; absolute points are a first cut —
// qwen cosines are query-relative, so this may need to become pool-relative.
const REGION_RAMP_LO = () => envNum("RB_REGION_RAMP_LO", 0.50);
const REGION_RAMP_HI = () => envNum("RB_REGION_RAMP_HI", 0.65);
function regionRelevanceRamp(cos: number): number {
  const lo = REGION_RAMP_LO(), hi = REGION_RAMP_HI();
  if (hi <= lo) return 1; // disabled → flat boost (pre-2026-06-16 behavior)
  return Math.max(0, Math.min(1, (cos - lo) / (hi - lo)));
}

/**
 * Unified relevance-first reranker (2026-06-15). relevance = REAL query·paper
 * cosine (paper.realCosine — attached upstream via cosineForIds; falls back to
 * paper.similarity for real-vector hits). Channels are BOUNDED MULTIPLICATIVE
 * BOOSTS gated to the SELECTED channels/region — they only ever lift a paper,
 * never drop it. No gate, no floor. Off-topic papers sink by ranking.
 *   score = clamp(cos,0,1) × (1 + Σ active boosts)
 * Order only — drops nothing.
 */
export function rerankUnified(
  papers: Paper[],
  filters: RerankFilters | undefined,
  channels: string[],
  profileName?: string,
  domainWeights?: Map<string, number> | null,
  promoteWorkIds?: Map<string, number> | null,
): Paper[] {
  const P = BOOST_PROFILES[profileName ?? unifiedProfileName()] ?? BOOST_PROFILES.moderate;
  const matcher = resolveRegionMatcher(filters, DEFAULT_RERANK_WEIGHTS.region, undefined);
  const regionActive = (filters?.regions?.length ?? 0) > 0 && matcher.weight > 0;
  const hasCausal = channels.includes("causal");
  const hasFound  = channels.includes("foundational");
  // Per-user learned methodology-domain weights (keys lowercased). Active only
  // when a non-empty map is passed (gated by RB_DOMAIN_WEIGHTS in retrieval.ts).
  const dwScale = (domainWeights && domainWeights.size > 0) ? domainWeightBoostScale() : 0;
  // Per-user positive feedback (liked/saved/added on a similar past query).
  const promoteScale = (promoteWorkIds && promoteWorkIds.size > 0) ? promoteFeedbackBoostScale() : 0;
  // Recency is a HARD YEAR FILTER (2026-06-17), not a scoring boost — "recent" →
  // filter_min_year=2020. So recency no longer lifts ranking (everything in the
  // table already clears the year filter). P.recent is retained but unused here.

  const scored = papers.map((paper) => {
    const cos = Math.max(0, Math.min(1, Number(paper.realCosine ?? paper.similarity ?? 0)));
    let mult = 1;
    if (hasCausal) mult += P.causal * (Math.min(5, Number(paper.sms_level ?? paper.smsLevel ?? 0)) / 5);
    if (hasFound)  mult += P.foundational * citationScore(paper);
    // Region boost gated by a cosine relevance ramp — only lifts in-region papers
    // that are already on-topic (stops adjacent LAC papers leapfrogging a more
    // relevant global paper on the region multiplier alone). See regionRelevanceRamp.
    if (regionActive) mult += P.region * regionMatchScore(paper, matcher) * regionRelevanceRamp(cos);
    // Per-user learned methodology-domain boost (bounded; reorders, never gates).
    // GATED by the SAME cosine relevance ramp as the region boost: a low-cosine
    // paper of a favored methodology gets ~zero lift, so the boost reorders WITHIN
    // the relevant pool and can't float an off-topic paper on methodology alone.
    // (Without the ramp the boost floated cos<0.45 junk + evicted strongly-relevant
    // papers — measured in scripts/probe-domain-weight-boost.mjs, 2026-06-25.)
    if (dwScale > 0) {
      const md = String(paper.methodology_design ?? "").toLowerCase().trim();
      const w = md ? domainWeights!.get(md) : undefined;
      if (typeof w === "number") mult += dwScale * Math.max(-0.5, Math.min(1.0, w - 1)) * regionRelevanceRamp(cos);
    }
    // Per-user positive-feedback boost (ramp-gated, same as above). The user
    // endorsed THIS paper on a similar query → lift it within the relevant pool.
    if (promoteScale > 0) {
      const sim = promoteWorkIds!.get(paper.id);
      if (typeof sim === "number") mult += promoteScale * sim * regionRelevanceRamp(cos);
    }
    const score = cos * mult;
    (paper as Paper)._unifiedScore = score;
    return { paper, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ paper }) => paper);
}

/**
 * Channel-aware DISPLAY order for the final evidence table (2026-06-15).
 * Membership is decided by rerankUnified's score; this only reorders for
 * display so the table reflects the user's channel intent. 'lac'/region is a
 * filter, not a sort driver. A SINGLE active quality/time channel sorts by its
 * signal (causal→SMS, foundational→citations, recent→year), tie-broken by
 * unified score. Multiple (or none) → score.
 */
const _SORT_CHANNELS = new Set(["causal", "foundational", "recent"]);
export function orderByChannel(evidence: Paper[], channels: string[]): Paper[] {
  const active = channels.filter((c) => _SORT_CHANNELS.has(c));
  const byScore = (p: Paper) => Number(p._unifiedScore ?? p._compositeScore ?? 0);
  const out = [...evidence];
  if (active.length === 1) {
    const ch = active[0];
    const key = ch === "causal"
      ? (p: Paper) => Number(p.sms_level ?? p.smsLevel ?? 0)
      : ch === "foundational"
        ? (p: Paper) => Number(p.citation_count ?? p.citationCount ?? 0)
        : (p: Paper) => Number(p.year ?? p.publication_year ?? 0);
    out.sort((a, b) => (key(b) - key(a)) || (byScore(b) - byScore(a)));
  } else {
    out.sort((a, b) => byScore(b) - byScore(a));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quota reorder (2026-06-24, RB_QUOTA) — relevance + per-channel representation.
//
// rerankUnified scores `cos × (1 + boosts)`. For a region query the region boost
// (×1.30 for in-region papers at cos≥0.65) lifts ~50 LAC papers above a non-region
// global canon paper at higher RAW cosine — e.g. Jensen 2010 (cos 0.785, no region
// boost → score 0.785) is buried below in-region papers at cos 0.60 (0.60×1.30=0.78)
// and falls out of the top-50, so the relevance floor (which only TRIMS the 50,
// never ADDs) can't recover it.
//
// Fix: guarantee the top-`relevanceK` papers by RAW cosine — and the top-`channelK`
// per ACTIVE channel — appear in the selection pool head, so boosts REORDER the
// table but never EVICT the most-relevant papers or a channel's best. Floors, not
// caps; a paper satisfying several quotas counts once. Returns the SAME papers,
// reordered so mandated ones lead (in score order); selection + dedup run downstream
// unchanged. Display order (orderByChannel) and the relevance floor are applied after,
// so a mandated high-cosine paper survives the floor and shows at its score position.
// ---------------------------------------------------------------------------
const _QUOTA_SOURCE_TO_CHANNEL: Record<string, string> = {
  causal_channel: "causal",
  foundational_channel_hyde: "foundational",
  foundational_channel_fts: "foundational",
  foundational_channel_sql: "foundational",
  recent_channel: "recent",
  topic_geo_channel: "lac",
};
export function quotaReorder(
  ranked: Paper[],          // sorted desc by _unifiedScore (boosted)
  activeChannels: string[],
  relevanceK: number,       // guarantee top-relevanceK by RAW cosine
  perChannelK: number,      // guarantee top-perChannelK per active channel (score order)
): Paper[] {
  if (relevanceK <= 0 && perChannelK <= 0) return ranked;
  const cosOf = (p: Paper) => Number(p.realCosine ?? p.similarity ?? 0);
  const mandated = new Set<string>();
  // 1. Relevance quota: the top-relevanceK by RAW cosine can never be evicted by boosts.
  if (relevanceK > 0) {
    [...ranked].sort((a, b) => cosOf(b) - cosOf(a)).slice(0, relevanceK).forEach((p) => mandated.add(p.id));
  }
  // 2. Per-channel quota: each active channel's top-perChannelK by score (region is a
  //    boost, not a _retrievalSource tag, so it is covered by the relevance quota +
  //    boost ordering, not here).
  if (perChannelK > 0) {
    for (const ch of activeChannels) {
      let n = 0;
      for (const p of ranked) {
        if (n >= perChannelK) break;
        if (_QUOTA_SOURCE_TO_CHANNEL[String((p as Paper)._retrievalSource ?? "")] === ch) {
          mandated.add(p.id);
          n++;
        }
      }
    }
  }
  if (mandated.size === 0) return ranked;
  const head = ranked.filter((p) => mandated.has(p.id)); // score order preserved
  const tail = ranked.filter((p) => !mandated.has(p.id));
  return [...head, ...tail];
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
      // _unifiedScore is what the prod path (rerankUnified, RB_UNIFIED=1) writes;
      // _compositeScore is the legacy/rollback path (rerankMerged/rerankHybrid).
      // Reading only _compositeScore here made every base 0 under RB_UNIFIED, which
      // turned the soft crowding penalties into absolute hard demotions.
      const base = Number(p._unifiedScore ?? p._compositeScore ?? 0);
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
