/**
 * supabase/functions/_shared/retrieval.ts
 *
 * Phase 2+3: Live retrieval orchestrator with SMS classification.
 *
 * planSearchIntent — builds structured query metadata.
 * retrieveWorks   — async fan-out to Semantic Scholar, Exa, and OpenAlex in parallel.
 *                   Deduplicates results, classifies methodology (SMS), upserts to
 *                   works table, and returns a structured retrieval result.
 */

// decomposeQuery is retained for the multi-vector RECALL recovery path (sparse
// queries) — it is NOT classifier-only. The direct/indirect/excluded classifier
// (classifyAll / trained RF / LLM judge / attachFacetSimilarities) was removed
// 2026-06-17 in the relevance-first redesign.
import { decomposeQuery } from "./queryFacets.ts";
import { searchSemanticScholar } from "./semanticScholarClient.ts";
import { searchExa } from "./exaClient.ts";
import { searchOpenAlex } from "./openAlexClient.ts";
import { searchCrossref } from "./crossrefClient.ts";
import { searchWorldBank } from "./worldBankClient.ts";
import { searchIdbPublications } from "./idbPublicationsClient.ts";
import { searchLocalCorpus, searchLocalCorpusMulti, type PreFilters, cosineForIds } from "./vectorSearch.ts";
import { deterministicExpand, expandQuery } from "./queryExpander.ts";
import { crawlCitations } from "./citationCrawler.ts";
import { searchSimilarPapers } from "./ssRecommender.ts";
import { createEmbeddingClient, buildEmbeddingText } from "./embeddingClient.ts";
import { computeUserDislikeFilter } from "./dislikeFilter.ts";
import { computeUserPromoteFilter } from "./promoteFilter.ts";
import { deduplicatePapers } from "./dedup.ts";
import { classifyPaper } from "./smsClassifier.ts";
import { lookupJournalRankings } from "./journalRankings.ts";
import { adminClient } from "./supabase.ts";
import { selectTopKDiverse, DEFAULT_SELECTION_POOL_SIZE, rerankUnified, orderByChannel, unifiedProfileName, quotaReorder } from "./rerank.ts";
import { retrieveByTopicAndGeography, retrieveByCausalChannel, retrieveByRecentChannel, retrieveByFoundationalChannel, toFtsTerms } from "./topicGeoChannel.ts";
import { generateHydeAbstract } from "./hydeClient.ts";
import { crossEncoderRerank } from "./crossEncoder.ts";
import { filterDeniedVenuePapers } from "./venueDenylist.ts";
import { withPopulationTerms as _withPopulationTerms } from "./retrievalPopulation.ts";

// ---------------------------------------------------------------------------
// Evidence-table cap — SINGLE SOURCE OF TRUTH.
// The number of papers that make it into the user-visible evidence table
// (searchRun.evidenceWorkIds). synthesis.ts imports this as the default
// SYNTHESIS_EVIDENCE_CAP so the brief synthesis always considers EVERY paper
// shown in the table — the two can never silently diverge. (User instruction:
// "synthesis should be over all in evidence table".) Do not redefine this
// number anywhere else; import it.
// ---------------------------------------------------------------------------
export const EVIDENCE_TABLE_CAP = 50;

// ---------------------------------------------------------------------------
// Population expansion helper — re-exported from retrievalPopulation.ts so
// unit tests can import it without the full retrieval.ts dep graph (Supabase
// client, Deno env, etc.).
// ---------------------------------------------------------------------------
export { withPopulationTerms } from "./retrievalPopulation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchFilters {
  topics?: string[];
  regions?: string[];
  methodology?: string[];
  timePeriod?: string;
  startDate?: string;
  endDate?: string;
  // Quality filters — papers must pass ALL active filters to be evidence
  smsLevels?: number[];        // e.g. [3,4,5] — only these SMS levels are evidence
  // deprecated — kept for back-compat with legacy saved runs; not used in retrieval
  absRatings?: string[];       // e.g. ['3','4','4*'] — only these ABS ratings
  // deprecated — kept for back-compat with legacy saved runs; not used in retrieval
  repecBands?: string[];       // e.g. ['top_5','top_5_10','top_10_25']
  // Active retrieval channels (Q1 of the search-intent card). Mirrors the
  // top-level `channels` override on the request body — VALID_CHANNEL_IDS.
  channels?: string[];         // 'causal' | 'foundational' | 'recent' | 'lac'
  // Document-type filter — works.publication_type enum values. Empty/undefined
  // = no filter (ALL document types). See buildPreFiltersFromSearchFilters.
  publicationTypes?: string[];
  // Chip-bar additions (2026-05-04). Tier filter checks paper.venue against the
  // ABS-aligned journal lists embedded below. Tier 5 = "All other indexed" =
  // any venue not in tiers 1–4. Excluded individual journals override their tier.
  journalTiers?: number[];
  excludedJournalsByTier?: Record<string, string[]>;
  // Source pickers (2026-05-07). Match against paper.venue / paper.source via
  // hint lists below. When institutionalSources includes IADB or WB, the live
  // WB/IDB API clients fire even in corpus-only mode.
  workingPaperSources?: string[];     // NBER | SSRN | OECD_WP | WB_WP | IZA | CEPR_REPEC | RePEc legacy
  institutionalSources?: string[];    // IADB | WB | OECD | OTHER
  // Opt-in (2026-06-26): also include journal articles in venues with no ABS
  // rating (unranked/regional/specialist). Additive to the tier/source pickers.
  includeUnranked?: boolean;
  // Direct vs Indirect evidence filter (2026-05-07).
  //   direct   — only papers that match every facet of the query
  //   both     — direct + indirect (SEMANTIC DEFAULT — when absent the server
  //              applies "both"; an old run / re-render that omits the field
  //              must NOT silently skip the classification filter)
  //   all      — show everything including loose matches
  // Requires ENABLE_FACET_RETRIEVAL=true; otherwise classification is skipped
  // and this filter has no effect.
  evidenceMatch?: "direct" | "both" | "all";
  // Population soft-signal (Q6 of the search-clarifier card). Chip labels from
  // POPULATION_GROUPS in types.ts. May also arrive as a legacy string — inlined
  // array-guard in retrieveWorks() because retrieval.ts cannot import types.ts
  // across the Deno/TSX boundary.
  populationFocus?: string[] | string;
}

// Active retrieval channels (Q1 of the search-intent card). Keep in sync with
// VALID_CHANNEL_IDS in types.ts (cross-runtime files can't share an import).
export const VALID_CHANNEL_IDS = ["causal", "foundational", "recent", "lac"] as const;

// Source hint maps (lowercased substring match against `${venue} ${source}`).
const WORKING_PAPER_HINTS: Record<string, string[]> = {
  NBER: ["nber", "national bureau of economic research"],
  SSRN: ["ssrn"],
  IZA: ["iza"],
  // WB and OECD outputs covered by institutional checks — no separate WP entries.
  CEPR_REPEC: ["cepr", "repec", "ideas", "econpapers"],
  // Legacy saved filters: keep broad RePEc behavior for existing users.
  RePEc: ["repec", "ideas", "econpapers"],
};

const WORKING_PAPER_SOURCE_FAMILIES: Record<string, string[]> = {
  NBER: ["NBER"],
  SSRN: ["SSRN"],
  IZA: ["IZA"],
  CEPR_REPEC: ["CEPR", "RePEc"],
  RePEc: ["RePEc"],
};

const INSTITUTIONAL_HINTS: Record<string, string[]> = {
  // "idb" catches "IDB Publication", "IDB Working Paper" etc. (common in corpus without "iadb")
  IADB: ["iadb", "idb", "inter-american development bank", "publications.iadb", "idb publications", "idb working paper"],
  // "policy research working paper" catches WB Policy Research WPs whose venue omits "world bank"
  WB: ["world bank", "policy research working paper", "open knowledge repository", "worldbank.org", "the world bank economic review", "the world bank research observer"],
  OECD: ["oecd", "organisation for economic co-operation"],
  IMF: ["imf", "international monetary fund", "imf working paper", "imf working papers"],
  OTHER: ["cepal", "eclac", "unesco", "unicef", "ilo", "undp"],
  // Development-evidence centers (opt-in add-ons, 2026-06-26). source_family is null
  // for these openalex-imported rows, so we match on their distinctive venue text
  // (venue = "CGD/J-PAL/IPA Working Paper"). Specific patterns only — never a bare
  // "ipa" (would match "municipal", "participation", etc.).
  CGD: ["cgd working paper", "center for global development"],
  JPAL: ["j-pal", "jameel poverty action"],
  IPA: ["ipa working paper", "innovations for poverty action"],
};

const INSTITUTIONAL_SOURCE_FAMILIES: Record<string, string[]> = {
  IADB: ["IADB"],
  WB: ["World Bank"],
  OECD: ["OECD"],
  IMF: ["IMF"],
  OTHER: ["ECLAC", "UNESCO", "UNICEF", "ILO", "UNDP"],
};

// Region label → keyword list. Matched against title+abstract text.
const REGION_KEYWORDS: Record<string, string[]> = {
  // Synced to the canonical REGION_KEYWORDS["LAC"] in rerank.ts (incl. Spanish
  // variants + all countries) so region FILTERING matches the same papers region
  // SCORING does. Guarded by scripts/check-invariants.mjs — keep identical.
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
  "OECD": ["oecd", "united states", "canada", "germany", "france", "united kingdom", "japan", "korea", "australia", "italy", "spain", "netherlands", "sweden", "norway", "finland", "denmark"],
  "High-income": ["high-income", "high income", "developed country", "advanced economy"],
  "Low- and middle-income": ["low-income", "low income", "middle-income", "middle income", "developing country", "lmic"],
  "Sub-Saharan Africa": ["africa", "kenya", "nigeria", "ethiopia", "tanzania", "uganda", "ghana", "senegal", "south africa", "rwanda", "zambia", "malawi", "mozambique"],
  "MENA": ["middle east", "north africa", "mena", "egypt", "morocco", "tunisia", "jordan", "lebanon", "iran", "iraq", "saudi arabia", "uae"],
  "South Asia": ["south asia", "india", "pakistan", "bangladesh", "sri lanka", "nepal", "bhutan"],
  "East Asia & Pacific": ["east asia", "china", "vietnam", "indonesia", "philippines", "thailand", "malaysia", "cambodia", "laos", "myanmar"],
  // Keys used by the search clarifier region presets:
  "South & Southeast Asia": ["south asia", "southeast asia", "india", "pakistan", "bangladesh", "sri lanka", "nepal", "vietnam", "indonesia", "philippines", "thailand", "malaysia", "cambodia", "myanmar"],
  "United States": ["united states", "u.s.", "usa", "u.s.a."],
  "Europe & Central Asia": ["europe", "european union", "germany", "france", "united kingdom", "spain", "italy", "poland", "ukraine", "netherlands", "sweden", "norway", "finland", "denmark", "central asia", "kazakhstan", "uzbekistan"],
};
/**
 * Translate user-visible SearchFilters into SQL pre-filter params for match_works_v2.
 *
 * Only fires when the user made a genuinely selective choice — partial selections.
 * "All selected" (e.g. smsLevels=[0..5]) and empty arrays both return undefined
 * so the server applies its own defaults (year≥2010, sms≥2) via DEFAULT_PRE_FILTERS.
 *
 * Venue is the one axis where explicit user intent (journalTiers, institutionalSources,
 * workingPaperSources) becomes a hard SQL predicate — matching the design contract:
 * "venue is never a default hard pre-filter, but always respected when user selects it."
 */
/**
 * Default source set as a HARD filter (2026-06-17). When the user opens NO source
 * picker (all three source keys absent), default to the credible UNION
 * {ABS tiers 1–3} ∪ {IADB,WB,IMF,OECD} ∪ {NBER,IZA,CEPR_REPEC,SSRN} and treat it as
 * a hard filter (passesQualityFilters + buildPreFilters both read these keys). An
 * explicit pick on ANY of the three is respected as-is (the SourcesQuestion sends the
 * full custom set when the user customizes). RB_NO_SOURCE_DEFAULT=1 disables.
 * ⚠️ Stacks with the relevance floor — a relevant paper in an untiered/regional venue
 * is dropped by default; the user accepted this (quality-by-default). Validate vs the
 * recall instrument when tuning.
 */
function resolveSourceDefaults(filters: SearchFilters): SearchFilters {
  const off = (typeof Deno !== "undefined" ? Deno.env.get("RB_NO_SOURCE_DEFAULT") : (globalThis as any).process?.env?.RB_NO_SOURCE_DEFAULT) === "1";
  if (off) return filters;
  const hasJ = Array.isArray(filters.journalTiers) && filters.journalTiers.length > 0;
  const hasI = Array.isArray(filters.institutionalSources);
  const hasW = Array.isArray(filters.workingPaperSources);
  if (hasJ || hasI || hasW) return filters; // user customized — respect exactly
  return {
    ...filters,
    journalTiers: [1, 2, 3],
    institutionalSources: ["IADB", "WB", "IMF", "OECD"],
    workingPaperSources: ["NBER", "IZA", "CEPR_REPEC", "SSRN"],
  };
}

function buildPreFiltersFromSearchFilters(filters: SearchFilters): PreFilters | undefined {
  // 2026-05-13: when any venue category is set, treat MISSING (absent / undefined)
  // sibling category keys as "use App.tsx defaults" rather than "explicitly empty."
  //
  // Bug pattern this fixes: the UI sometimes serialises a filter as
  //   { topics, journalTiers: [1,2], evidenceMatch: 'direct', ... }
  // — without the `workingPaperSources` or `institutionalSources` keys at all.
  // Previously this triggered a hard SQL venue filter that ONLY matched tier-1/2
  // journals (since hasWpFilter/hasInstitFilter both evaluated false on undefined).
  // NBER + SSRN + IADB papers were silently gated out, even though the user
  // expected them included (those are App.tsx default source selections).
  //
  // New semantic:
  //   - key absent / undefined  → use the App.tsx default set ([NBER,SSRN] / [IADB])
  //   - key present, empty []   → user explicitly excluded that category (respect)
  //   - key present, non-empty  → use as-is
  // RB_NO_SOURCE_DEFAULT=1: only the IMPLICIT DEFAULT source set becomes a SOFT ranking
  // signal — an EXPLICIT user selection is ALWAYS honored as a hard filter (the user
  // asked for it). Two layers cooperate:
  //   • resolveSourceDefaults() skips INJECTING journalTiers/inst/wp defaults when the
  //     flag is set, so a no-pick search arrives here with those keys ABSENT.
  //   • buildPreFilters has its OWN hardcoded inst/wp default fallback — suppress ONLY
  //     that fallback under the flag (→ [] when not explicitly chosen), so it stops
  //     emitting filter_venue_patterns/source_families for a default search and gating
  //     the candidate vector arm (the half-implemented bug that dropped high-cosine
  //     canon like Jensen 2010). An EXPLICIT selection (wpExplicit/instExplicit) is
  //     used regardless of the flag. journalTiers is only ever set by an explicit pick
  //     under the flag (resolveSourceDefaults injected nothing), so it self-respects.
  //     2026-06-24.
  const _noSrcDefault = (typeof Deno !== "undefined" ? Deno.env.get("RB_NO_SOURCE_DEFAULT") : (globalThis as any).process?.env?.RB_NO_SOURCE_DEFAULT) === "1";
  const wpExplicit   = Array.isArray(filters.workingPaperSources);
  const instExplicit = Array.isArray(filters.institutionalSources);
  const wp   = wpExplicit   ? filters.workingPaperSources!   : (_noSrcDefault ? [] : (["NBER", "IZA", "CEPR_REPEC", "SSRN"] as string[]));
  const inst = instExplicit ? filters.institutionalSources! : (_noSrcDefault ? [] : (["IADB", "WB", "IMF", "OECD"]      as string[]));

  const hasJournalFilter = !!(filters.journalTiers && filters.journalTiers.length > 0 && filters.journalTiers.length < 5);
  const hasInstitFilter  = inst.length > 0;
  const hasWpFilter      = wp.length > 0;
  const hasVenueFilter   = hasJournalFilter || hasInstitFilter || hasWpFilter;

  const hasSmsFilter  = !!(filters.smsLevels && filters.smsLevels.length > 0 && filters.smsLevels.length < 6);
  // Document-type filter. EMPTY [] and UNDEFINED both mean "no document-type
  // filter — allow ALL types" (the UI sends [] when no group is selected); only
  // a partial selection (>0 and < the 11 enum values) becomes a hard SQL
  // predicate. Selecting every type is also "no filter".
  const pubTypes = filters.publicationTypes ?? [];
  const hasPubFilter  = !!(pubTypes && pubTypes.length > 0 && pubTypes.length < 11);
  const hasTimeFilter = filters.timePeriod === "custom" || filters.timePeriod === "recent" || filters.timePeriod === "last-5" || filters.timePeriod === "2000+";

  if (!hasVenueFilter && !hasSmsFilter && !hasPubFilter && !hasTimeFilter) {
    return undefined; // no explicit user choice — let server defaults apply
  }

  const pf: PreFilters = {};

  // Time → year range
  if (hasTimeFilter) {
    if (filters.timePeriod === "custom") {
      if (filters.startDate) pf.filter_min_year = new Date(filters.startDate).getFullYear();
      if (filters.endDate)   pf.filter_max_year = new Date(filters.endDate).getFullYear();
    } else if (filters.timePeriod === "recent") {
      pf.filter_min_year = 2020;
    } else if (filters.timePeriod === "2000+") {
      pf.filter_min_year = 2000;
    } else if (filters.timePeriod === "last-5") {
      pf.filter_min_year = new Date().getFullYear() - 5;
    }
  }

  // SMS: use the minimum selected level as the soft lower bound
  if (hasSmsFilter) {
    pf.filter_sms_min = Math.min(...filters.smsLevels!);
  }

  // Publication types → direct pass-through
  if (hasPubFilter) {
    pf.filter_publication_types = pubTypes;
  }

  // Venue: translate tier lists + institution/WP hints → exact + ILIKE patterns
  if (hasVenueFilter) {
    const venueExact: string[] = [];
    const venuePatterns: string[] = [];
    const sourceFamilies: string[] = [];

    if (hasJournalFilter) {
      for (const tier of filters.journalTiers!) {
        venueExact.push(...(TIER_VENUES[tier] ?? []));
      }
    }
    if (hasInstitFilter) {
      for (const src of inst) {
        sourceFamilies.push(...(INSTITUTIONAL_SOURCE_FAMILIES[src] ?? []));
        for (const h of INSTITUTIONAL_HINTS[src] ?? []) venuePatterns.push(`%${h}%`);
      }
    }
    if (hasWpFilter) {
      for (const src of wp) {
        sourceFamilies.push(...(WORKING_PAPER_SOURCE_FAMILIES[src] ?? []));
        for (const h of WORKING_PAPER_HINTS[src] ?? []) venuePatterns.push(`%${h}%`);
      }
    }
    if (venueExact.length   > 0) pf.filter_venue_exact    = [...new Set(venueExact)];
    if (venuePatterns.length > 0) pf.filter_venue_patterns = [...new Set(venuePatterns)];
    if (sourceFamilies.length > 0) pf.filter_source_families = [...new Set(sourceFamilies)];
    // Opt-in: also let unranked-venue journal articles through the venue gate.
    // Only meaningful while a venue filter is active (otherwise everything passes).
    if (filters.includeUnranked) pf.filter_include_unranked = true;
  }

  return Object.keys(pf).length > 0 ? pf : undefined;
}

const matchesAnyHint = (haystack: string, hints: string[]): boolean => {
  if (!haystack) return false;
  return hints.some((h) => haystack.includes(h));
};

function matchesWorkingPaperSource(paper: Paper, sourceId: string): boolean {
  const sourceFamilies = WORKING_PAPER_SOURCE_FAMILIES[sourceId] ?? [];
  if (sourceFamilies.length > 0 && sourceFamilies.includes(String(paper.sourceFamily ?? paper.source_family ?? ""))) {
    return true;
  }
  const haystack = `${paper.venue ?? ""} ${paper.source ?? ""} ${paper.url ?? ""}`.toLowerCase();
  if (!haystack) return false;

  if (sourceId === "CEPR_REPEC") {
    if (haystack.includes("cepr")) return true;
    const isRepec = String(paper.source ?? "").toLowerCase() === "repec" ||
      haystack.includes("ideas.repec.org") ||
      haystack.includes("econpapers.repec.org");
    if (!isRepec) return false;
    const namedElsewhere = [
      "nber",
      "national bureau of economic research",
      "ssrn",
      "oecd",
      "open knowledge repository",
      "world bank working paper",
      "policy research working paper",
      "iza",
    ].some((hint) => haystack.includes(hint));
    return !namedElsewhere;
  }

  const hints = WORKING_PAPER_HINTS[sourceId] ?? [sourceId.toLowerCase()];
  return matchesAnyHint(haystack, hints);
}

// Embedded venue → tier lookup. Mirrors data/journal-tiers.json. Kept inline
// here so the edge function has no JSON-import dependency (Deno requires
// `with { type: "json" }` which complicates bundling).
const TIER_VENUES: Record<number, string[]> = {
  1: [
    "American Economic Review", "The Quarterly Journal of Economics", "Econometrica",
    "Journal of Political Economy", "The Review of Economic Studies",
  ],
  2: [
    "Journal of Economic Literature", "The Journal of Economic Perspectives",
    "The Review of Economics and Statistics", "The Economic Journal",
    "Journal of the European Economic Association", "American Economic Journal Applied Economics",
    "American Economic J.: Economic Policy", "American Economic Journal Economic Policy",
    "American Economic Journal Macroeconomics", "American Economic Journal Microeconomics",
    "Journal of Econometrics", "Journal of International Economics", "International Economic Review",
    "Journal of Labor Economics", "Journal of Public Economics", "Journal of Development Economics",
    "The Journal of Human Resources", "Journal of Health Economics",
    "Brookings Papers on Economic Activity", "Journal of Monetary Economics", "Journal of Economic Theory",
    "Games and Economic Behavior", "RAND Journal of Economics", "Journal of Industrial Economics",
    "Journal of Urban Economics", "European Economic Review", "Journal of Financial Economics",
    "The Journal of Finance", "Review of Financial Studies", "Journal of Accounting and Economics",
    "Journal of Accounting Research", "American Political Science Review",
    "American Journal of Political Science", "World Politics", "International Organization",
    "The Journal of Politics",
    // Economic history — ABS 4; both name variants present in corpus
    "The Economic History Review", "Economic History Review",
    "The Journal of Economic History", "Journal of Economic History",
    // Industrial relations — ABS 4 per rankings table (were misclassified in tier 3)
    "British Journal of Industrial Relations", "Industrial Relations",
    // Public administration — ABS 4★ per rankings table
    "Public Administration Review",
  ],
  3: [
    "World Development", "The Journal of Development Studies", "Journal of Population Economics",
    "Health Economics", "Journal of Economic Behavior & Organization", "Labour Economics",
    "Economic Development and Cultural Change", "The World Bank Economic Review",
    "American Journal of Agricultural Economics", "Journal of Agricultural Economics",
    "Journal of Comparative Economics",
    "Industrial and Labor Relations Review", "ILR Review",  // ILR Review = renamed ILRR
    "Annual Review of Economics", "Annual Review of Political Science",
    "Review of Development Economics", "Journal of Policy Analysis and Management",
    "Education Finance and Policy", "Economic Policy", "Review of Economic Dynamics",
    "Journal of Economic Surveys", "Oxford Economic Papers", "Oxford Review of Economic Policy",
    "Journal of Applied Econometrics", "Economic Inquiry", "Empirical Economics",
    "Macroeconomic Dynamics", "Public Finance Review", "National Tax Journal",
    "Cambridge Journal of Economics",
    "Explorations in Economic History", "Industrial Relations: A Journal of Economy and Society",
    "Education Economics", "Economics of Education Review",
    "Review of International Economics", "Journal of International Money and Finance",
    "American Journal of Health Economics", "Health Affairs", "Health Policy and Planning",
    "Comparative Political Studies", "International Studies Quarterly",
    "British Journal of Political Science", "Political Analysis",
    "Energy Economics", "Resource and Energy Economics",
    "Journal of Environmental Economics and Management", "Land Economics", "Food Policy",
    "Agricultural Economics", "Demography", "Journal of Risk and Insurance", "Real Estate Economics",
    // ABS 3 additions (from abs_rankings, confirmed corpus presence)
    "Ecological Economics", "Environmental and Resource Economics",
    "Development and Change",
    "Economics Letters",
    "Regional Science and Urban Economics",
    "Journal of Economic Growth", "Journal of Economic Dynamics and Control",
    "Review of Income and Wealth",
    "Oxford Bulletin of Economics and Statistics",
    "Econometrics Journal",
    "European Review of Agricultural Economics",
    "Economica",
    "Journal of Institutional Economics",
    "IMF Economic Review",
    "Journal of Human Capital",
    "Canadian Journal of Economics",
    "European Journal of Industrial Relations",
    "Social Choice and Welfare",
    // AEJ colon-variant names (abs_rankings uses colon, we also need no-colon in tier 2)
    "American Economic Journal: Economic Policy",
    "American Economic Journal: Microeconomics",
    "American Economic Journal: Applied Economics",
    "American Economic Journal: Macroeconomics",
    "American Economic Review: Insights",
  ],
  4: [
    "Public Choice", "Journal of Public Policy", "Latin American Research Review",
    "Journal of Latin American Studies", "Latin American Politics and Society",
    "Population and Development Review", "The World Bank Research Observer",
    "CEPAL Review", "Journal of African Economies",
    "Asian Economic Journal", "Journal of Asian Economics", "Eastern European Economics",
    "World Trade Review", "International Tax and Public Finance", "Public Sector Economics",
    "Journal of Population Research", "Population Studies", "Latin American Economic Review",
    "Cuadernos de Economía", "Economía", "Revista de Economía Política",
    "Estudios Económicos", "El Trimestre Económico", "Revista de Economía y Estadística",
  ],
};

const NORMALIZE_VENUE = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

const VENUE_TO_TIER = new Map<string, number>();
for (const [tierStr, venues] of Object.entries(TIER_VENUES)) {
  const tier = Number(tierStr);
  for (const v of venues) VENUE_TO_TIER.set(NORMALIZE_VENUE(v), tier);
}

const getTierForVenue = (venue: string | null | undefined): number => {
  if (!venue) return 5;
  return VENUE_TO_TIER.get(NORMALIZE_VENUE(venue)) ?? 5;
};

interface SearchIntent {
  entities: string[];
  synonyms: string[];
  geography: string[];
  timeframe: string;
  methodologyFocus: string[];
}

export interface CoverageStats {
  universeCount: number;
  retrievedCount: number;
  admissibleCount: number;
  evidenceCount: number;
  signalCount: number;
  // Facet-retrieval telemetry. Optional — only populated when ENABLE_FACET_RETRIEVAL=true.
  // (Direct/Indirect classifier counts removed 2026-07-08 — the classifier was retired
  // 2026-06-17, so these were always undefined; the live direct/indirect pills in the UI
  // come from per-row evidenceMatch, not these counts.)
  excludedByFacets?: number;
  facetLabels?: string[];   // e.g. ["gender", "migration", "geography"]
  /** Count of papers suppressed because the user thumbs-down'd them on a
   *  semantically-similar past query (cosine sim >= 0.85). */
  hiddenByFeedback?: number;
}

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

function normalizeGenericTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericNonPrimaryPaper(paper: Paper): boolean {
  const title = normalizeGenericTitle(paper.title);
  return (
    paper.publication_type === "commentary" ||
    paper.publicationType === "commentary" ||
    paper.venue_kind === "commentary" ||
    paper.venueKind === "commentary" ||
    paper.raw_data?.excluded_from_evidence === true ||
    /^(general discussion|comments? and discussion|discussion|editors?'?\s+introduction|introduction|front matter|back matter|book reviews?)$/.test(title)
  );
}

const LAZY_EVIDENCE_CARD_ENQUEUE_LIMIT = 50;

interface RetrievalResult {
  candidates: Paper[];
  evidence: Paper[];
  /** Pre-ranked extended evidence (papers ~51–200) for the "load more" path;
   *  stored in search_runs.extended_evidence_work_ids. Empty on the early-return
   *  (zero-result) path. */
  extended?: Paper[];
  /** Diagnostic funnel dump: the full ranked pool before diverse top-K selection.
   *  Only populated when the caller passes `includeSelectionPool: true`. */
  selectionPool?: Paper[];
  signals: Paper[];
  coverage: CoverageStats;
  retrievalNotes: string[];
  // Direct/Indirect classification metadata (2026-05-07). Only populated when
  // ENABLE_FACET_RETRIEVAL=true. Each evidence/candidate paper has
  // `evidenceMatch` and `facetsMatched` attached as fields too — these
  // top-level counts are for the coverage card.
  facetCounts?: { direct: number; indirect: number; excluded: number };
  facets?: Array<{ label: string; expansion: string[] }>;
  /** Per-phase timing log; only populated for diagnostic runs. */
  perfLog?: Array<{ phase: string; dt: number; total: number; extra: string }>;
  classCounts?: { directLac: number; directGlobal: number; indirect: number; excluded: number };
  /** Channel-of-origin map: workId -> channel ids (causal/recent/foundational/lac)
   *  that actually surfaced the paper. ADDITIVE telemetry — does not affect
   *  ranking or which papers are returned. Plain vector/FTS papers have no entry. */
  workChannels?: Record<string, string[]>;
  /** Cosine summary over the evidence set for the pilot monitor (design spec §6).
   *  Read-only signal; persisted on search_runs. null when no evidence has a cosine. */
  topCosine?: number | null;
  meanCosine?: number | null;
}

interface RetrieveWorksOptions {
  // deno-lint-ignore no-explicit-any
  supabaseClient?: any | null;
  existingUrls?: string[];
  /** Per-request HyDE override — bypasses ENABLE_HYDE env when force=true. */
  hydeOverride?: { force?: boolean; disable?: boolean; threshold?: number; limit?: number };
  /** Per-request cross-encoder override — bypasses ENABLE_CROSS_ENCODER env. */
  crossEncoderOverride?: { force?: boolean; disable?: boolean; topN?: number };
  /** Per-request facet-retrieval override — bypasses ENABLE_FACET_RETRIEVAL env. */
  facetRetrievalOverride?: { force?: boolean; disable?: boolean };
  /** Per-request LLM-judge classifier override — bypasses LLM_JUDGE_CLASSIFIER /
   *  LLM_JUDGE_CAP / LLM_JUDGE_RF_FALLBACK_THRESHOLD env. Used by latency-sweep
   *  probes to A/B different settings without redeploying. force/disable flip
   *  the classifier itself; cap sets the max RF-uncertain papers judged;
   *  threshold sets the RF top-prob cutoff for triggering the judge. */
  llmJudgeOverride?: { force?: boolean; disable?: boolean; cap?: number; threshold?: number };
  /** @deprecated No longer wired into retrieval — it only affected the retired
   *  legacy rerankMerged path (removed 2026-07-08). The live reranker is
   *  `rerankUnified`, tuned via BOOST_PROFILES, not per-key composite weights.
   *  Field kept so old harness callers don't fail to typecheck; it is ignored. */
  rerankWeightsOverride?: Record<string, number> | null;
  /** Diagnostic: when true, the result carries `selectionPool` — the full ranked
   *  pool (~top DEFAULT_SELECTION_POOL_SIZE) before diverse top-K selection. Used by
   *  the eval/funnel bench; off by default (no cost). */
  includeSelectionPool?: boolean;
  /** Active Q2 channels from the search intent card.
   *  'causal'  → parallel SMS≥4 channel (guarantees high-rigor papers)
   *  'recent'  → parallel year≥2020 channel (guarantees new working papers)
   *  'lac'     → topicGeoChannel runs with boosted limit (300 vs 200)
   *  'foundational' → focused HyDE channel (sim=0.79 floor) + citation boost weights */
  channelsOverride?: string[] | null;
  /** Authenticated user id. When present, papers the user has thumbs-down'd
   *  on semantically similar past queries are suppressed from the result. */
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// planSearchIntent — unchanged from Phase 1
// ---------------------------------------------------------------------------

export function planSearchIntent(
  query: string,
  filters: SearchFilters = {}
): SearchIntent {
  const normalized = query.toLowerCase();
  const topics = Array.isArray(filters.topics) ? filters.topics : [];
  const entities = Array.from(
    new Set([...topics, ...extractTokens(normalized)])
  );
  const synonyms: string[] = [];
  if (entities.includes("ai"))
    synonyms.push("artificial intelligence", "automation");
  if (entities.includes("labor")) synonyms.push("employment", "workforce");

  return {
    entities,
    synonyms,
    geography: Array.isArray(filters.regions) ? filters.regions : [],
    timeframe:
      filters.timePeriod === "recent"
        ? "Recent"
        : filters.timePeriod === "2000+"
          ? "2000+"
          : filters.timePeriod === "custom"
            ? `${filters.startDate} to ${filters.endDate}`
            : "All",
    methodologyFocus: Array.isArray(filters.methodology)
      ? filters.methodology
      : [],
  };
}

// ---------------------------------------------------------------------------
// retrieveWorks — async fan-out with dedup + upsert
// ---------------------------------------------------------------------------

/**
 * Retrieve, deduplicate, and persist papers for a given query.
 */
export async function retrieveWorks(
  query: string,
  filters: SearchFilters = {},
  { supabaseClient = null, existingUrls = [], hydeOverride, crossEncoderOverride, facetRetrievalOverride, llmJudgeOverride, channelsOverride, userId = null, includeSelectionPool = false }: RetrieveWorksOptions = {}
): Promise<RetrievalResult> {
  const client = supabaseClient ?? adminClient;
  filters = resolveSourceDefaults(filters); // default source set = hard UNION filter (2026-06-17)
  let deniedVenueDropped = 0;
  const dropDeniedVenues = (papers: Paper[], label: string): Paper[] => {
    const kept = filterDeniedVenuePapers(papers);
    const dropped = papers.length - kept.length;
    if (dropped > 0) {
      deniedVenueDropped += dropped;
      console.log(`[retrieval] Dropped ${dropped} denylisted venue paper(s) from ${label}`);
    }
    return kept;
  };
  const yearStart = resolveYearStart(filters);
  const startPublishedDate = `${yearStart}-01-01`;

  // ---------------------------------------------------------------------------
  // Phase timer (added 2026-05-11). Logs `[perf]` markers at every major
  // boundary so we can see where the 40s retrieval budget actually goes.
  // Also pushes to _perfLog array, returned in retrieval result so eval bench
  // can read timings without VPS log access.
  // ---------------------------------------------------------------------------
  const _perfT0 = Date.now();
  let _perfLast = _perfT0;
  const _perfLog: { phase: string; dt: number; total: number; extra: string }[] = [];
  const perf = (phase: string, extra = "") => {
    const now = Date.now();
    const dt = now - _perfLast;
    const total = now - _perfT0;
    _perfLast = now;
    _perfLog.push({ phase, dt, total, extra });
    console.log(`[perf] phase=${phase} dt=${dt}ms total=${total}ms ${extra}`);
  };
  // Sub-phase recorder for operations inside parallel promises. Records the
  // operation's own duration (`opMs`) without advancing _perfLast, so the
  // outer phase markers still reflect wall-clock segments.
  const subPhase = (name: string, opMs: number, extra = "") => {
    _perfLog.push({ phase: `  ${name}`, dt: opMs, total: Date.now() - _perfT0, extra });
  };

  // Evidence base mode. Default: corpus-only — the 256k curated corpus is now
  // wide enough to be the headline product. Live APIs (SS/OA/CR/WB/IDB/Exa)
  // dragged in low-quality drift (Mali RCTs surfacing on AI-LAC queries, open
  // web blogs, etc.) and added 5–10s of latency. To re-enable live APIs, set
  // EVIDENCE_LIVE_APIS=true in the env. Buzz / grey-lit signals run on a
  // separate code path (see /api/signals) and never enter the evidence table.
  const USE_LIVE_APIS = (
    typeof Deno !== "undefined"
      ? Deno.env.get("EVIDENCE_LIVE_APIS")
      : (globalThis as any).process?.env?.EVIDENCE_LIVE_APIS
  ) === "true";

  // Unified reranker (formerly gated by RB_UNIFIED, retired 2026-07-08). The
  // reranker is `rerankUnified` (relevance × bounded boosts, no drop) + the
  // cosine relevance floor + `orderByChannel` for channel-aware display order.
  // The legacy rerankHybrid/rerankMerged path + its three evidence floors are no
  // longer wired into the runtime — they remain in rerank.ts as eval/ablation
  // tooling only. Rollback is `git revert`, not an env flip.

  // Detect historical-depth intent: when query asks about long-run trends or
  // pre-2010 evidence, we'll fire an additional parallel sweep with an older
  // yearStart to backfill the gap left by the corpus's last-15-year bias.
  // Only meaningful when live APIs are enabled.
  const historicalYearStart = USE_LIVE_APIS ? detectHistoricalIntent(query) : null;
  if (historicalYearStart !== null) {
    console.log(`[retrieval] historical intent detected, fallback yearStart=${historicalYearStart}`);
  }

  // ---------------------------------------------------------------------------
  // Step 1: Fire corpus search + query expansion simultaneously.
  // Corpus doesn't need expanded variants — semantic + BM25 on the original
  // query is sufficient and starts ~1s earlier than before.
  // ---------------------------------------------------------------------------
  // Inline array-guard: populationFocus may be string[], a legacy string, or
  // undefined. retrieval.ts cannot import types.ts across the Deno/TSX boundary.
  const popFocus: string[] = Array.isArray(filters?.populationFocus)
    ? (filters.populationFocus as string[])
    : (filters?.populationFocus ? [(filters.populationFocus as unknown as string)] : []);
  const primaryQuery = _withPopulationTerms(sanitizeQueryForSearch(query), popFocus);
  // Corpus query: same population augmentation applied to the RAW query (no
  // sanitization change — only adds population terms so the vector embed and
  // FTS filter gain the extra signal without altering existing query semantics).
  const corpusQuery = _withPopulationTerms(query, popFocus);

  // ---------------------------------------------------------------------------
  // User-feedback suppression (2026-05-12).
  // Fire in parallel with everything else: embed the current query, then look
  // up the user's thumbs-down history and compute cosine sim. Papers the user
  // disliked on a semantically-similar past query get filtered out before
  // the final ranking. Cheap (~100ms embed + small Postgres scan) and never
  // blocks if it fails — opens to empty exclusion set on any error.
  // ---------------------------------------------------------------------------
  // Embed the current query ONCE; both the dislike filter and the positive
  // promote filter consume it (avoids a double embed).
  const feedbackQEmbPromise: Promise<number[] | null> = userId
    ? (async () => {
        try { const ec = createEmbeddingClient(); if (!ec) return null; return (await ec.embedText(primaryQuery, "query")) ?? null; }
        catch { return null; }
      })()
    : Promise.resolve(null);

  const dislikeFilterPromise: Promise<{ excludedWorkIds: Set<string>; hiddenCount: number }> =
    userId
      ? (async () => {
          try {
            const qEmb = await feedbackQEmbPromise;
            if (!qEmb) return { excludedWorkIds: new Set<string>(), hiddenCount: 0 };
            return computeUserDislikeFilter(client, userId, qEmb);
          } catch {
            return { excludedWorkIds: new Set<string>(), hiddenCount: 0 };
          }
        })()
      : Promise.resolve({ excludedWorkIds: new Set<string>(), hiddenCount: 0 });

  // Per-user POSITIVE feedback (RB_PROMOTE_FEEDBACK, default OFF): papers the user
  // liked/saved/added on a semantically-similar past query → bounded rerank boost
  // in rerankUnified. Read-only; shares the query embed above; empty on any error.
  const RB_PROMOTE_FEEDBACK =
    (typeof Deno !== "undefined" ? Deno.env.get("RB_PROMOTE_FEEDBACK") : (globalThis as any).process?.env?.RB_PROMOTE_FEEDBACK) === "1";
  const promoteFilterPromise: Promise<Map<string, number>> =
    (RB_PROMOTE_FEEDBACK && userId)
      ? (async () => {
          try {
            const qEmb = await feedbackQEmbPromise;
            if (!qEmb) return new Map<string, number>();
            return (await computeUserPromoteFilter(client, userId, qEmb)).promoteWorkIds;
          } catch {
            return new Map<string, number>();
          }
        })()
      : Promise.resolve(new Map<string, number>());

  // ---------------------------------------------------------------------------
  // Per-user learned methodology-domain weights (RB_DOMAIN_WEIGHTS, default OFF).
  // Closes the learning-agent loop: approved `domain_weights` rows become a
  // BOUNDED rerank boost in rerankUnified (keyed by works.methodology_design).
  // Fire in parallel; opens to null (no boost) on any error or empty result.
  // ---------------------------------------------------------------------------
  const RB_DOMAIN_WEIGHTS =
    (typeof Deno !== "undefined" ? Deno.env.get("RB_DOMAIN_WEIGHTS") : (globalThis as any).process?.env?.RB_DOMAIN_WEIGHTS) === "1";
  const domainWeightsPromise: Promise<Map<string, number> | null> =
    (RB_DOMAIN_WEIGHTS && userId)
      ? (async () => {
          try {
            const { data } = await client
              .from("domain_weights")
              .select("domain, weight")
              .eq("user_id", userId);
            if (!data || data.length === 0) return null;
            const m = new Map<string, number>();
            for (const r of data as Array<{ domain: string | null; weight: number | null }>) {
              if (r.domain && typeof r.weight === "number") {
                m.set(String(r.domain).toLowerCase().trim(), r.weight);
              }
            }
            return m.size > 0 ? m : null;
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null);

  // Corpus-first retrieval: the local corpus (227k+ papers, SMS classified,
  // journal rankings, topic tags) is our most curated source. We pull a wide
  // soft-cap of relevant papers above the similarity threshold; live APIs
  // exist to fill gaps the corpus doesn't cover yet.
  const CORPUS_LIMIT = parseInt(
    (typeof Deno !== "undefined" ? Deno.env.get("CORPUS_LIMIT") : (globalThis as any).process?.env?.CORPUS_LIMIT) || "800",
    10,
  );

  // Multi-vector retrieval (2026-05-07): when facet retrieval is enabled and
  // Qwen returns ≥2 facets, run a per-facet cosine search in parallel and
  // union the results. This avoids the bag-of-tokens cosine bias that drops
  // truly multi-facet papers below the candidate cut. Single-vector cosine
  // remains the fallback (1-facet queries, Qwen errors, flag-off).
  // Per-request override wins. Otherwise env-flag (default on).
  const ENABLE_FACETS_RETRIEVAL = facetRetrievalOverride?.disable === true
    ? false
    : facetRetrievalOverride?.force === true
      ? true
      : ((typeof Deno !== "undefined"
          ? Deno.env.get("ENABLE_FACET_RETRIEVAL")
          : (globalThis as any).process?.env?.ENABLE_FACET_RETRIEVAL) !== "false");

  // HyDE threshold + limit are env-tunable for the threshold sweep. Per-request
  // overrides win over env (lets eval scripts A/B without env flips).
  const HYDE_THRESHOLD = hydeOverride?.threshold ?? parseFloat(
    (typeof Deno !== "undefined" ? Deno.env.get("HYDE_THRESHOLD") : (globalThis as any).process?.env?.HYDE_THRESHOLD) || "0.40",
  );
  const HYDE_LIMIT = hydeOverride?.limit ?? parseInt(
    (typeof Deno !== "undefined" ? Deno.env.get("HYDE_LIMIT") : (globalThis as any).process?.env?.HYDE_LIMIT) || "200",
    10,
  );

  // Threshold for the adaptive path (2026-05-11): if single-vector returns
  // at least this many candidates, we skip decomposeQuery + multi-vector
  // entirely — saves ~8s on easy queries. If single-vector falls short,
  // we still fire decomposeQuery + multi-vector to recover hard queries.
  // Tunable via SINGLE_VECTOR_SUFFICIENT_THRESHOLD env. Default 200 is
  // conservative — gold queries q01/q02/q03 all return ~488 single-vector.
  const SINGLE_VECTOR_SUFFICIENT_THRESHOLD = parseInt(
    (typeof Deno !== "undefined"
      ? Deno.env.get("SINGLE_VECTOR_SUFFICIENT_THRESHOLD")
      : (globalThis as any).process?.env?.SINGLE_VECTOR_SUFFICIENT_THRESHOLD) || "200",
    10,
  );

  // Shared decomposeQuery promise — fired once per retrieveWorks() call and
  // shared between (a) the corpus escalation path, (b) the classification
  // step downstream. Without this sharing the classification step would
  // pay the ~8s Qwen call when the corpus path short-circuits, negating
  // the adaptive optimization. The decomposeQuery internal LRU cache helps
  // for repeat queries across requests; this helps within a single request.
  let _sharedDecomposePromise: ReturnType<typeof decomposeQuery> | null = null;
  const getQueryFacets = () => {
    if (!_sharedDecomposePromise) {
      const _dt = Date.now();
      _sharedDecomposePromise = decomposeQuery(query).then((qf) => {
        subPhase("decomposeQuery(shared)", Date.now() - _dt, `facets=${qf.facets.length}`);
        return qf;
      });
    }
    return _sharedDecomposePromise;
  };

  // Eager decomposeQuery fire REMOVED 2026-06-17: the classifier (its only
  // unconditional consumer) is gone, so decomposeQuery now runs LAZILY — only on
  // the sparse-query escalation path (single-vector < threshold). Easy queries
  // (the common case) no longer pay a wasted per-query Qwen decompose call.

  // Translate user-visible SearchFilters → SQL pre-filter params for match_works_v2.
  // Undefined = no explicit user choice; server applies its own defaults.
  const userPreFilters = buildPreFiltersFromSearchFilters(filters);
  if (userPreFilters) {
    console.log("[retrieval] user pre-filters active:", JSON.stringify(Object.keys(userPreFilters)));
  }

  // Phase 1.2 (2026-05-15): query-class-aware year floor relaxation.
  // When the query has historical intent ("long-run", "since 1990", "meta-analysis",
  // etc.), the user's default 2020 startDate from App.tsx silently excludes the
  // foundational papers the query is asking for (Card 1990, Schultz 2004, Heckman
  // 2009, etc.). canonical-position-probe-2026-05-12 named this as the dominant
  // pre-2010 recall failure. detectHistoricalIntent already runs above for the
  // OpenAlex/Crossref fallback path — apply it to the local corpus pre-filter
  // too. User intent (custom date range) is respected as a HARD lower bound.
  if (userPreFilters && historicalYearStart !== null && userPreFilters.filter_min_year != null
      && userPreFilters.filter_min_year > historicalYearStart) {
    console.log(
      `[retrieval] historical intent → relaxing filter_min_year ${userPreFilters.filter_min_year} → ${historicalYearStart}`,
    );
    userPreFilters.filter_min_year = historicalYearStart;
  }

  // Return type intentionally inferred — single-vector and multi-vector
  // return different shapes. (The multi-vector facetEmbeddings are no longer
  // consumed by a classifier post-pass — classifier removed 2026-06-17 — but
  // they remain part of the multi-vector recall result shape.)
  const corpusPromise = (async () => {
    // Concept terms for FTS component: focused 3-word discriminative phrase
    // so websearch_to_tsquery ANDs fewer terms and on-topic seminal papers
    // (e.g. Jensen 2010) get a non-zero fts_rank instead of being excluded
    // by the full NL question's long AND chain. The vector embedding still
    // uses the full query; only the FTS side benefits from the shorter terms.
    const ftsQuery = toFtsTerms(query);
    if (!ENABLE_FACETS_RETRIEVAL) {
      const _t = Date.now();
      const r = await searchLocalCorpus(corpusQuery, { limit: CORPUS_LIMIT, threshold: 0.50, preFilters: userPreFilters, ftsQuery });
      subPhase("corpus.singleVector", Date.now() - _t, `papers=${r.papers.length} embed=${r.embedTimeMs ?? "?"}ms rpc=${r.rpcTimeMs ?? "?"}ms`);
      return r;
    }

    // Adaptive path: try single-vector first. If it returns enough candidates,
    // we skip the 8s decomposeQuery + multi-vector work entirely. Otherwise
    // we fall through to the original multi-vector path for sparse queries.
    try {
      const _singleT = Date.now();
      const singleResult = await searchLocalCorpus(corpusQuery, { limit: CORPUS_LIMIT, threshold: 0.50, preFilters: userPreFilters, ftsQuery });
      subPhase("corpus.singleVector(adaptive)", Date.now() - _singleT, `papers=${singleResult.papers.length} embed=${singleResult.embedTimeMs ?? "?"}ms rpc=${singleResult.rpcTimeMs ?? "?"}ms`);

      if (singleResult.papers.length >= SINGLE_VECTOR_SUFFICIENT_THRESHOLD) {
        subPhase("corpus.adaptive.shortCircuit", 0, `papers=${singleResult.papers.length} threshold=${SINGLE_VECTOR_SUFFICIENT_THRESHOLD}`);
        return singleResult;
      }

      // Sparse query — single-vector under threshold. Fire decomposeQuery +
      // multi-vector to recover. Same path as before, just gated.
      subPhase("corpus.adaptive.escalate", 0, `singleVector=${singleResult.papers.length} < threshold=${SINGLE_VECTOR_SUFFICIENT_THRESHOLD}`);

      const decomposePromise = getQueryFacets();
      const _hydeT = Date.now();
      const hydePromise = generateHydeAbstract(query, {
        force: hydeOverride?.force === true,
        disable: hydeOverride?.disable === true,
      }).then((h) => {
        subPhase("hyde", Date.now() - _hydeT, `result=${h ? `${h.text.length}chars` : "skipped"}`);
        return h;
      });
      const [qf, hyde] = await Promise.all([decomposePromise, hydePromise]);
      if (qf.facets.length < 2) {
        // Even decomposeQuery says it's a single-facet query. Keep the
        // single-vector result we already have rather than re-fetch.
        subPhase("corpus.adaptive.keepSingle", 0, `facets=${qf.facets.length}`);
        return singleResult;
      }
      const facetInputs = qf.facets.map((f) => ({
        label: f.label,
        text: `${f.label} ${f.expansion.slice(0, 12).join(" ")}`,
      }));
      const _multiT = Date.now();
      const r = await searchLocalCorpusMulti(facetInputs, corpusQuery, {
        limit: CORPUS_LIMIT,
        perFacetLimit: 200,
        threshold: 0.45,
        hyde: hyde ? { text: hyde.text, threshold: HYDE_THRESHOLD, limit: HYDE_LIMIT } : null,
        preFilters: userPreFilters,
      });
      subPhase("corpus.multiVector", Date.now() - _multiT, `facets=${facetInputs.length} papers=${r.papers.length}`);

      // 🔑 Merge the single-vector (WHOLE-QUERY) results back in — escalation must
      // ADD recall, not REPLACE it. The per-facet search broadens along sub-topics
      // but can MISS a paper with a strong holistic-query cosine that doesn't rank
      // within any single facet's top-perFacetLimit. Concrete incident (2026-06-19):
      // "From Chalkboards to Chatbots" (De Simone et al. 2025, wb:40014259) has a
      // whole-query cosine of 0.675 (rank #11 in the single-vector result) for the
      // query "Can AI-driven education interventions improve student learning
      // outcomes?", yet was absent from the facet pool — so the survey omitted the
      // flagship paper on its own topic. `singleResult` is already computed; union
      // its papers (by id) so the holistic top matches are never discarded.
      const _mergeSingle = (typeof Deno !== "undefined" ? Deno.env.get("RB_MERGE_SINGLE") : (globalThis as any).process?.env?.RB_MERGE_SINGLE) !== "0";
      const _seen = new Set(r.papers.map((p) => p.id));
      const _fromSingle = _mergeSingle ? singleResult.papers.filter((p) => !_seen.has(p.id)) : [];
      // singleResult embedded `corpusQuery` (the whole-query vector) — carry it so
      // the downstream realCosine pass reuses it instead of re-embedding. The
      // multi-facet `r` has no whole-query embedding of its own.
      const _wholeQEmb = singleResult.queryEmbedding ?? r.queryEmbedding;
      if (_fromSingle.length > 0) {
        const merged = r.papers.concat(_fromSingle);
        subPhase("corpus.multiVector.mergeSingle", 0, `multi=${r.papers.length} +single=${_fromSingle.length} => ${merged.length}`);
        return { ...r, papers: merged, vectorCount: merged.length, queryEmbedding: _wholeQEmb };
      }
      return { ...r, queryEmbedding: _wholeQEmb };
    } catch (err) {
      console.error("[retrieval] adaptive corpus path failed, falling back:", (err as Error).message);
      return searchLocalCorpus(corpusQuery, { limit: CORPUS_LIMIT, threshold: 0.50, preFilters: userPreFilters, ftsQuery });
    }
  })();
  const _expansionT = Date.now();
  // Corpus-only mode: the Gemini-expanded `variants` are consumed ONLY by the
  // live-API fan-out below (dead when USE_LIVE_APIS is off); the only live
  // consumers are the boostMetaAnalyses boolean and a notes line, both of which
  // deterministicExpand derives from the query text. Skipping the LLM call
  // removes one blocking Gemini round-trip from every search.
  const expansionPromise = USE_LIVE_APIS
    ? expandQuery(query).then((r) => {
        subPhase("expandQuery", Date.now() - _expansionT, `variants=${r.variants.length} method=${r.method}`);
        return r;
      })
    : Promise.resolve(deterministicExpand(query));

  // ---------------------------------------------------------------------------
  // Step 2: Await expansion. When live APIs are enabled, fan out to SS/OA/CR
  // per variant; otherwise just resolve corpus and skip the live fetch tier.
  // ---------------------------------------------------------------------------
  const expanded = await expansionPromise;
  const variants = expanded.variants;

  console.log(`[retrieval] mode=${USE_LIVE_APIS ? "corpus+live" : "corpus-only"}, ${expanded.method} expansion: ${variants.length} variants`);

  // Live API quotas trimmed: live APIs supplement the corpus, they don't
  // dominate. Was 20/20/15 = 55 per variant; now 10/10/10 = 30 per variant.
  const PER_VARIANT = { ss: 10, oa: 10, cr: 10 };

  const allCalls: Promise<PromiseSettledResult<Paper[]>[]>[] = [];
  if (USE_LIVE_APIS) {
    for (let vi = 0; vi < variants.length; vi++) {
      const v = sanitizeQueryForSearch(variants[vi]);
      allCalls.push(
        Promise.allSettled([
          searchSemanticScholar(v, { limit: PER_VARIANT.ss, yearStart, token: null }).then((r) => r.papers),
          searchOpenAlex(variants[vi], { limit: PER_VARIANT.oa, yearStart }).then((r) => r.papers),
          searchCrossref(variants[vi], { limit: PER_VARIANT.cr, yearStart }).then((r) => r.papers),
        ]) as Promise<PromiseSettledResult<Paper[]>[]>
      );
    }
  }

  // Live APIs only fire when EVIDENCE_LIVE_APIS=true. The previous
  // institutional-source override (which fired live IDB/WB calls when the user
  // ticked those filter chips even in corpus-only mode) was removed
  // 2026-05-08. Reasoning: live results bypass our SMS/methodology tagging,
  // bypass embeddings, and can't be classified by the relevance gate —
  // breaking the corpus-only contract. If IADB/WB papers are missing, the fix
  // is targeted DOI ingest into the corpus, not a runtime backdoor.
  const primaryCalls: Promise<PromiseSettledResult<unknown>[]> = USE_LIVE_APIS
    ? Promise.allSettled([
        searchWorldBank(query, { limit: 15, yearStart }),
        searchIdbPublications(query, { limit: 15, yearStart }),
        searchExa(primaryQuery, { numResults: 15, startPublishedDate, excludeUrls: existingUrls }),
        searchOpenAlex(query, { limit: 1, yearStart }),
      ])
    : Promise.resolve([] as PromiseSettledResult<unknown>[]);

  const historicalCalls: Promise<PromiseSettledResult<Paper[]>[]> | null =
    USE_LIVE_APIS && historicalYearStart !== null
      ? (Promise.allSettled([
          searchOpenAlex(primaryQuery, { limit: 30, yearStart: historicalYearStart }).then((r) => r.papers),
          searchCrossref(primaryQuery, { limit: 25, yearStart: historicalYearStart }).then((r) => r.papers),
        ]) as Promise<PromiseSettledResult<Paper[]>[]>)
      : null;

  // Collect all results — corpus may already be done by now
  // Topic+geography parallel retrieval channel (Phase 1.5).
  // Vector retrieval misses ~95% of relevant papers on queries like
  // "AI and labor in LAC" — the corpus has ~500 such papers but vector
  // top-200 surfaces only ~30. The gap is structural (nomic embedding
  // under-performs on Spanish/Portuguese and specialty journals).
  // This channel does a deterministic SQL filter on scl_topics +
  // geography arrays and merges results into the corpus pool. Papers
  // get synthetic similarity=0.45 so they pass the relevance gate;
  // vector-strong papers (sim > 0.45) still outrank them on composite.
  const channels = channelsOverride ?? [];
  // Recall bump for the geography channel when the user has selected a region
  // (any region — LAC or other). Region is now a filter, not the `lac` channel,
  // so key the bump off filters.regions. (channels.includes("lac") kept for
  // back-compat with old saved runs that still carry the retired lac channel.)
  const regionSelected = (filters.regions?.length ?? 0) > 0 || channels.includes("lac");
  const topicGeoLimit = regionSelected ? 300 : 200;

  // Kill switch (RB_NO_TOPICGEO=1): skip the topic+geography channel entirely.
  // Read per-call so an A/B probe can flip it in-process; also a prod kill switch.
  // The relevance floor + qwen vector recall are the intended replacement — this
  // flag exists to measure whether topicGeo still earns its place post-qwen.
  const _noTopicGeo = ((typeof Deno !== "undefined" ? Deno.env.get("RB_NO_TOPICGEO") : (globalThis as any).process?.env?.RB_NO_TOPICGEO) === "1");

  const topicGeoPromise = _noTopicGeo
    ? Promise.resolve({ papers: [], topics: [] as string[], geographies: [] as string[], totalMatched: 0, searchTimeMs: 0 })
    : (async () => {
    const _t = Date.now();
    const r = await retrieveByTopicAndGeography(client, corpusQuery, {
      limit: topicGeoLimit,
      yearMin: userPreFilters?.filter_min_year,
      yearMax: userPreFilters?.filter_max_year,
    });
    subPhase(
      "corpus.topicGeoChannel",
      Date.now() - _t,
      `papers=${r.papers.length} topics=[${r.topics.join(",")}] geo=[${r.geographies.length}] totalMatched=${r.totalMatched ?? "?"}`,
    );
    return r;
  })();

  // Causal channel: guarantees SMS≥4 papers matching the topic context
  const causalChannelPromise = channels.includes("causal") ? (async () => {
    const _t = Date.now();
    const r = await retrieveByCausalChannel(client, corpusQuery, {
      limit: 60,
      yearMin: userPreFilters?.filter_min_year,
      yearMax: userPreFilters?.filter_max_year,
    });
    subPhase("corpus.causalChannel", Date.now() - _t, `papers=${r.papers.length}`);
    return r;
  })() : Promise.resolve({ papers: [], topics: [] });

  // Recent channel: guarantees 2020+ papers matching the topic context
  const recentChannelPromise = channels.includes("recent") ? (async () => {
    const _t = Date.now();
    const r = await retrieveByRecentChannel(client, corpusQuery, { limit: 50 });
    subPhase("corpus.recentChannel", Date.now() - _t, `papers=${r.papers.length}`);
    return r;
  })() : Promise.resolve({ papers: [], topics: [] });

  // Foundational channel: focused HyDE abstract → document embedding →
  // vector search at threshold=0.79. Bridges the vocabulary gap between
  // plain-language queries ("student learning → growth") and academic
  // foundational papers ("cognitive skills", "school quality", "GDP growth").
  // Only fires when user explicitly selects the Foundational channel.
  const foundationalChannelPromise = channels.includes("foundational") ? (async () => {
    const _t = Date.now();
    const r = await retrieveByFoundationalChannel(client, corpusQuery, { limit: 80 });
    subPhase("corpus.foundationalChannel", Date.now() - _t, `papers=${r.papers.length} hydeMs=${r.hydeMs ?? "?"}`);
    return r;
  })() : Promise.resolve({ papers: [] });

  const [variantResults, primaryResults, corpusResult, historicalResults, topicGeoResult, causalChannelResult, recentChannelResult, foundationalChannelResult] = await Promise.all([
    Promise.all(allCalls),
    primaryCalls,
    corpusPromise,
    historicalCalls ?? Promise.resolve(null),
    topicGeoPromise,
    causalChannelPromise,
    recentChannelPromise,
    foundationalChannelPromise,
  ]);
  perf("corpus+live+expansion", `corpus=${corpusResult.papers.length} topicGeo=${topicGeoResult.papers.length} causal=${causalChannelResult.papers.length} recent=${recentChannelResult.papers.length} foundational=${foundationalChannelResult.papers.length} variants=${variants.length}`);
  // Defense-in-depth (2026-06-24): a whole-query vector search returning ≤1 paper
  // over a ~488k corpus is ALWAYS an embedding failure (LLM/embedding proxy down) —
  // there is no legitimate query where the semantic arm returns nothing. Without
  // this, the pipeline silently degrades to FTS/citation-only and serves a
  // confident-looking but semantically-broken table (the 2026-06-24 outage). Flag
  // it so the brief/UI can warn instead of presenting keyword-only results as a
  // finished evidence set. Surfaced as a user-facing note once `notes` is built.
  const _degradedRecall = corpusResult.papers.length <= 1;
  if (_degradedRecall) {
    console.warn(`[retrieval] ⚠️ DEGRADED RECALL: whole-query vector returned ${corpusResult.papers.length} paper(s) over the full corpus — query embedding almost certainly failed (embedding service down). Results are FTS/citation-only and may miss semantically-relevant papers.`);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Collect all papers into source buckets for dedup
  // ---------------------------------------------------------------------------
  const allSsPapers: Paper[] = [];
  const allOaPapers: Paper[] = [];
  const allCrPapers: Paper[] = [];

  for (const variantSettled of variantResults) {
    const [ss, oa, cr] = variantSettled;
    if (ss.status === "fulfilled") allSsPapers.push(...ss.value);
    if (oa.status === "fulfilled") allOaPapers.push(...oa.value);
    if (cr.status === "fulfilled") allCrPapers.push(...cr.value);
  }

  // Merge historical-depth results (if fired) into the same buckets — dedup
  // happens downstream by DOI/title.
  if (historicalResults) {
    const [oaHist, crHist] = historicalResults;
    if (oaHist.status === "fulfilled") {
      allOaPapers.push(...oaHist.value);
      console.log(`[retrieval] historical OA: +${oaHist.value.length} papers`);
    }
    if (crHist.status === "fulfilled") {
      allCrPapers.push(...crHist.value);
      console.log(`[retrieval] historical CR: +${crHist.value.length} papers`);
    }
  }

  // corpusResult comes directly from corpusPromise (already awaited above).
  // In corpus-only mode, primaryResults is an empty array — destructure
  // defensively so the per-source results default to empty.
  const [wbSettled, idbSettled, exaSettled, oaUniverseSettled] = primaryResults as PromiseSettledResult<unknown>[];

  const wbResult = wbSettled?.status === "fulfilled"
    ? (wbSettled.value as { papers: Paper[]; total: number })
    : { papers: [] as Paper[], total: 0 };

  const idbResult = idbSettled?.status === "fulfilled"
    ? (idbSettled.value as { papers: Paper[]; total: number })
    : { papers: [] as Paper[], total: 0 };

  const exaResult = exaSettled?.status === "fulfilled"
    ? (exaSettled.value as { papers: Paper[] })
    : { papers: [] as Paper[] };

  allSsPapers.splice(0, allSsPapers.length, ...dropDeniedVenues(allSsPapers, "Semantic Scholar"));
  allOaPapers.splice(0, allOaPapers.length, ...dropDeniedVenues(allOaPapers, "OpenAlex"));
  allCrPapers.splice(0, allCrPapers.length, ...dropDeniedVenues(allCrPapers, "Crossref"));
  corpusResult.papers.splice(0, corpusResult.papers.length, ...dropDeniedVenues(corpusResult.papers, "local corpus"));
  topicGeoResult.papers.splice(0, topicGeoResult.papers.length, ...dropDeniedVenues(topicGeoResult.papers, "topic/geo corpus"));
  causalChannelResult.papers.splice(0, causalChannelResult.papers.length, ...dropDeniedVenues(causalChannelResult.papers, "causal channel"));
  recentChannelResult.papers.splice(0, recentChannelResult.papers.length, ...dropDeniedVenues(recentChannelResult.papers, "recent channel"));
  foundationalChannelResult.papers.splice(0, foundationalChannelResult.papers.length, ...dropDeniedVenues(foundationalChannelResult.papers, "foundational channel"));
  wbResult.papers.splice(0, wbResult.papers.length, ...dropDeniedVenues(wbResult.papers, "World Bank"));
  idbResult.papers.splice(0, idbResult.papers.length, ...dropDeniedVenues(idbResult.papers, "IADB"));
  exaResult.papers.splice(0, exaResult.papers.length, ...dropDeniedVenues(exaResult.papers, "Exa"));

  // In corpus-only mode, universe = corpus matches above the similarity
  // threshold (the full set of relevant papers in the curated base, before
  // the CORPUS_LIMIT cap). When live APIs are enabled, OpenAlex's reported
  // count is used as the broader proxy.
  const universeCount = USE_LIVE_APIS
    ? (oaUniverseSettled?.status === "fulfilled"
        ? (oaUniverseSettled.value as { count: number }).count
        : 0)
    : corpusResult.papers.length;

  // Check if all sources failed
  const totalPapers = allSsPapers.length + allOaPapers.length + allCrPapers.length +
    wbResult.papers.length + idbResult.papers.length + exaResult.papers.length + corpusResult.papers.length;

  if (totalPapers === 0) {
    return emptyResult([
      `Query expansion generated ${variants.length} variants but all sources returned zero results. Try broadening your query.`,
    ]);
  }

  console.log(`[retrieval] Raw papers: SS ${allSsPapers.length}, OA ${allOaPapers.length}, CR ${allCrPapers.length}, WB ${wbResult.papers.length}, IDB ${idbResult.papers.length}, Exa ${exaResult.papers.length}, Corpus ${corpusResult.papers.length}`);

  // Channel-of-origin accumulator (ADDITIVE telemetry — does NOT affect which
  // papers are kept or their order). Captures, per kept paper id, the UNION of
  // channel ids derived from `_retrievalSource` across the kept paper AND any
  // duplicate dropped in its favour during dedup (e.g. causal + lac). Plain
  // vector/FTS corpus papers carry no tag → no entry. Returned as `workChannels`
  // and persisted on the search_run so the frontend pills reflect the real
  // surfacing channel rather than a render-time recompute.
  const channelOriginMap = new Map<string, Set<string>>();

  // Dedup priority: CORPUS FIRST. Our corpus rows carry SMS levels, journal
  // rankings (ABS, RePEC), topic tags, and a stable canonical id — none of
  // which are present on raw live-API responses. When a paper exists in both
  // corpus and a live API, we want the corpus version to win so we don't
  // silently overwrite that metadata with a barer SS/OA row.
  let merged = deduplicatePapers([
    // Foundational channel goes FIRST when active: its HyDE similarities are
    // higher and more meaningful for foundational papers than raw-query cosine.
    // When the foundational channel is off, this array is empty — no effect.
    foundationalChannelResult.papers,
    corpusResult.papers,
    // Topic+geo channel goes second: papers in both pools keep their real vector sim.
    topicGeoResult.papers,
    // Causal/recent channels go after topicGeo — real sim wins if paper already found.
    causalChannelResult.papers,
    recentChannelResult.papers,
    allSsPapers,
    allOaPapers,
    allCrPapers,
    wbResult.papers,
    idbResult.papers,
    exaResult.papers,
  ], { channelMap: channelOriginMap });
  merged = merged.filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
  perf("dedup", `merged=${merged.length}`);

  // ---------------------------------------------------------------------------
  // Step 4: Citation graph + SS Recommendations — run in parallel.
  // These pull fresh papers from external APIs (Semantic Scholar) using the
  // current merged set as seeds.
  //
  // Citation graph is gated by ENABLE_CITATION_GRAPH (default true — probe on
  // 2026-05-13 recovered 6/20 missing canonicals across q05/q06/q10/q11,
  // including foundational papers that no other path reaches: Schultz 2004
  // PROGRESA — 0-char abstract + cosine sim 0.521, rank past 10,000 — is
  // recovered because modern CCT papers cite it. Avg graph latency 4s.
  // SS Recommendations is gated by the broader EVIDENCE_LIVE_APIS because it
  // has the same quality-drift concern as vanilla SS/OA search.
  //
  // Disable with ENABLE_CITATION_GRAPH=false if SS API rate limit becomes an
  // operational concern.
  // ---------------------------------------------------------------------------
  const existingIds = new Set(merged.map((p: Paper) => p.id).filter(Boolean));

  const ENABLE_CITATION_GRAPH = (
    (typeof Deno !== "undefined"
      ? Deno.env.get("ENABLE_CITATION_GRAPH")
      : (globalThis as any).process?.env?.ENABLE_CITATION_GRAPH) ?? "true"
  ) === "true";

  const emptyCrawl = { papers: [] as Paper[], seedCount: 0, linksExamined: 0, crawlTimeMs: 0 };
  const emptyRecommend = { papers: [] as Paper[], seedCount: 0, timeMs: 0 };
  const [crawlResult, recommendResult] = await Promise.all([
    ENABLE_CITATION_GRAPH ? crawlCitations(merged, existingIds) : Promise.resolve(emptyCrawl),
    USE_LIVE_APIS ? searchSimilarPapers(merged, existingIds, { limit: 30 }) : Promise.resolve(emptyRecommend),
  ]);
  perf("discovery", `crawl=${crawlResult.papers.length} rec=${recommendResult.papers.length}`);

  // Merge discovered papers: citations first (explicit links), then recommendations (semantic similarity)
  const discoveredPapers = dropDeniedVenues(
    [...crawlResult.papers, ...recommendResult.papers],
    "discovery",
  ).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
  if (discoveredPapers.length > 0) {
    const withDiscovered = deduplicatePapers([merged, discoveredPapers]);
    const added = withDiscovered.length - merged.length;
    merged = withDiscovered;
    merged = merged.filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
    if (added > 0) {
      console.log(`[retrieval] Discovery phase added ${added} papers (citations: ${crawlResult.papers.length}, recommendations: ${recommendResult.papers.length})`);
    }
  }

  // Classify methodology + look up journal rankings, then upsert
  if (merged.length > 0) {
    // De-dupe rows by id before upsert — Semantic Scholar bulk API can return duplicate
    // paperId values in the same response, which causes an ON CONFLICT ambiguity error.
    const rowMap = new Map<string, Paper>();
    for (const paper of merged) {
      if (!rowMap.has(paper.id)) rowMap.set(paper.id, paperToRow(paper));
    }

    // Batch journal ranking lookup (QUAL-02/QUAL-03) with match info (AUDIT-02).
    // Parallelized — was a sequential await in a for-loop, which scaled linearly
    // with result-set size (~30s on 300+ papers). Now all lookups race in
    // parallel via Promise.allSettled (failures don't poison the batch).
    const rows = [...rowMap.values()];
    try {
      const settled = await Promise.allSettled(
        rows.map((row) => lookupJournalRankings(row.venue)),
      );
      for (let i = 0; i < rows.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") {
          const jr = result.value;
          rows[i].abs_rating = jr.absRating;
          rows[i].repec_rank = jr.repecRank;
          rows[i].repec_percentile = jr.repecPercentile;
          rows[i].journal_match_info = jr.matchInfo ?? {};
        }
      }
    } catch (err) {
      console.error(
        "[retrieval] Journal ranking lookup error:",
        (err as Error).message
      );
    }
    perf("journal-rankings", `rows=${rows.length}`);

    // Copy classification + ranking scores back to merged papers
    // so quality filters can see them (merged papers are the source of truth for filtering)
    for (const paper of merged) {
      const row = rowMap.get(paper.id);
      if (row) {
        paper.sms_level = row.sms_level;
        paper.methodology_design = row.methodology_design;
        paper.causal_strength = row.causal_strength;
        paper.abs_rating = row.abs_rating;
        paper.repec_percentile = row.repec_percentile;
      }
    }

    // C2: Embed papers on retrieval — corpus grows with every search.
    // FIRE-AND-FORGET (2026-05-11): previously this blocked the critical path
    // for ~4s on a typical query. Embedding is for corpus growth, not the
    // user-visible response, so we kick it off without awaiting. A second
    // background upsert later writes the embedding column. The synchronous
    // upsert below still persists everything else.
    // Eval guard (RB_SKIP_CORPUS_GROWTH=1): skip BOTH the corpus-growth embedding
    // and the works-upsert below. Offline A/B probes call retrieveWorks hundreds
    // of times; without this they'd queue thousands of fire-and-forget embeds on
    // the shared GPU (the documented outage hazard) and write to prod `works`.
    // Prod never sets it — read per-call so a probe can flip it in-process.
    const _skipGrowth = ((typeof Deno !== "undefined" ? Deno.env.get("RB_SKIP_CORPUS_GROWTH") : (globalThis as any).process?.env?.RB_SKIP_CORPUS_GROWTH) === "1");

    const embeddingClient = createEmbeddingClient();
    if (embeddingClient && !_skipGrowth) {
      // paperToRow never carries an `embedding` key, so the old `!r.embedding`
      // filter matched EVERY row — re-embedding hundreds of already-embedded
      // corpus papers on each search (the documented shared-GPU outage hazard)
      // and stamping corpus_source='api_retrieval' over curated provenance.
      // Filter on the DB's actual state instead: embed only ids that are new to
      // `works` or whose stored embedding is null; skip noise-flagged rows so a
      // resurfacing denylisted paper is never re-embedded back into search.
      const embedCandidates = rows.filter((r) => r.id && r.title && r.abstract);
      if (embedCandidates.length > 0) {
        void (async () => {
          try {
            const candidateIds = embedCandidates.map((r) => r.id);
            const inDb = new Set<string>();
            const skip = new Set<string>();
            for (let i = 0; i < candidateIds.length; i += 200) {
              const batch = candidateIds.slice(i, i + 200);
              const { data: existRows } = await client
                .from("works")
                .select("id, is_noise")
                .in("id", batch);
              for (const r of existRows ?? []) {
                inDb.add(r.id);
                if (r.is_noise) skip.add(r.id);
              }
              const { data: embRows } = await client
                .from("works")
                .select("id")
                .in("id", batch)
                .not("embedding", "is", null);
              for (const r of embRows ?? []) skip.add(r.id);
            }
            const toEmbed = embedCandidates.filter((r) => !skip.has(r.id));
            if (toEmbed.length === 0) return;
            const texts = toEmbed.map((r) => buildEmbeddingText(r.title, r.abstract));
            const embeddings = await embeddingClient.embedBatch(texts, "document");
            // New rows carry provenance; existing rows get ONLY the embedding
            // column (never overwrite curated corpus_source). Separate upserts
            // because PostgREST requires uniform keys per payload.
            const newRows: Array<{ id: string; embedding: string; corpus_source: string }> = [];
            const fillRows: Array<{ id: string; embedding: string }> = [];
            for (let i = 0; i < toEmbed.length; i++) {
              if (!embeddings[i]) continue;
              const embedding = `[${embeddings[i]!.join(",")}]`;
              if (inDb.has(toEmbed[i].id)) fillRows.push({ id: toEmbed[i].id, embedding });
              else newRows.push({ id: toEmbed[i].id, embedding, corpus_source: "api_retrieval" });
            }
            if (newRows.length > 0) {
              await client.from("works").upsert(newRows, { onConflict: "id", ignoreDuplicates: false });
            }
            if (fillRows.length > 0) {
              await client.from("works").upsert(fillRows, { onConflict: "id", ignoreDuplicates: false });
            }
            const written = newRows.length + fillRows.length;
            if (written > 0) {
              console.log(`[retrieval] (async) Embedded ${written}/${toEmbed.length} papers for corpus growth (${embedCandidates.length - toEmbed.length} already embedded/skipped)`);
            }
          } catch (err) {
            console.error("[retrieval] (async) Embedding error:", (err as Error).message);
          }
        })();
        perf("embed-on-retrieval (fire-and-forget kicked off)", `candidates=${embedCandidates.length}`);
      }
    }

    // SMS-PRESERVATION (2026-06-01): paperToRow runs a keyword classifier that
    // returns null for papers without obvious methodology keywords in the
    // abstract. The upsert below (ignoreDuplicates:false) would otherwise
    // OVERWRITE an existing qwen_llm/manual SMS classification — or any
    // existing non-null sms_level — with keyword-null on every search. That
    // silently wiped rigor scores for re-retrieved papers. Fix: fetch existing
    // sms for these ids and never downgrade a populated/authoritative
    // classification. Keyword results only fill rows the DB still has as null.
    // CURATED-FIELD PRESERVATION (2026-06-01): paperToRow writes a full row
    // from the live-API paper, with null/empty/placeholder fallbacks for any
    // field the API didn't supply. With ignoreDuplicates:false the upsert then
    // OVERWRITES the existing corpus row — silently undoing backfilled metadata
    // (SMS, authors, citations, abstract, raw_data provenance) whenever a
    // already-curated paper resurfaces via discovery. Principle: for an
    // existing paper, only FILL GAPS — never replace a populated DB value with
    // an empty/null/placeholder from the live API.
    //
    // FIRE-AND-FORGET (2026-06-14): the preservation fetch + works upsert below
    // ran ~28-31s on the hot path for 1100+ wide rows (embedding +
    // embedding_nomic_old rollback column + raw_data jsonb), pushing
    // retrieveWorks past the 75s search timeout in api/index.ts → the SEARCH
    // itself failed → BOTH the brief and the "Generate Now" paper door bounced
    // back to the landing page. This write is a corpus SIDE-EFFECT (preserve
    // curated fields + persist new/changed papers); the user-facing results are
    // already built from `merged` (the score back-copy above runs BEFORE
    // preservation), so deferring it does NOT change what is returned. Same
    // fetch, same fill-gaps-only merge, same upsert — only the timing changed.
    // Golden rule intact. Mirrors the embedding fire-and-forget above.
    if (!_skipGrowth) void (async () => {
    try {
      const ids = rows.map((r) => r.id).filter(Boolean);
      const existing = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const { data } = await client
          .from("works")
          .select("id, sms_level, sms_method, methodology_design, causal_strength, sms_rationale, citation_count, abstract, authors, venue, title, year, canonical_doi, publication_date, journal_issn, open_access_pdf_url, fields_of_study, raw_data")
          .in("id", batch);
        for (const row of data ?? []) existing.set(row.id, row);
      }
      const isEmptyArr = (v: any) => !Array.isArray(v) || v.length === 0;
      const hasKeys = (v: any) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
      for (const row of rows) {
        const prev = existing.get(row.id);
        if (!prev) continue; // new paper — keep freshly classified/fetched values
        // SMS: preserve an existing classification as an ATOMIC unit — never
        // let the keyword scan null a known classification, and never glue a
        // preserved sms_level onto the freshly-computed keyword design/rationale.
        // (2026-07-15 desync incident: a prev qwen "SMS 5 / RCT" row was shown
        // with a fresh "survey of" SMS-1 rationale because design/rationale fell
        // back to `row.*` when prev.* was null.) If prev has a level, copy all
        // five fields from prev together; if a prev field is null, leave it null.
        if (prev.sms_level != null) {
          row.sms_level = prev.sms_level;
          row.sms_method = prev.sms_method;
          row.methodology_design = prev.methodology_design;
          row.causal_strength = prev.causal_strength;
          row.sms_rationale = prev.sms_rationale;
        }
        // Fill-gaps only: keep the DB value when the live row is null/empty/placeholder.
        if (row.citation_count == null && prev.citation_count != null) row.citation_count = prev.citation_count;
        if ((row.abstract == null || row.abstract === "") && prev.abstract) row.abstract = prev.abstract;
        if (isEmptyArr(row.authors) && !isEmptyArr(prev.authors)) row.authors = prev.authors;
        if (row.venue == null && prev.venue != null) row.venue = prev.venue;
        if ((row.title == null || row.title === "(untitled)") && prev.title) row.title = prev.title;
        if (row.year == null && prev.year != null) row.year = prev.year;
        if (row.canonical_doi == null && prev.canonical_doi != null) row.canonical_doi = prev.canonical_doi;
        if (row.publication_date == null && prev.publication_date != null) row.publication_date = prev.publication_date;
        if (row.journal_issn == null && prev.journal_issn != null) row.journal_issn = prev.journal_issn;
        if (row.open_access_pdf_url == null && prev.open_access_pdf_url != null) row.open_access_pdf_url = prev.open_access_pdf_url;
        if (isEmptyArr(row.fields_of_study) && !isEmptyArr(prev.fields_of_study)) row.fields_of_study = prev.fields_of_study;
        // raw_data: paperToRow always sets {} — never wipe existing provenance
        // (citation_count_observed_at, abstract_backfill, etc.).
        if (!hasKeys(row.raw_data) && hasKeys(prev.raw_data)) row.raw_data = prev.raw_data;
      }
    } catch (err) {
      console.error("[retrieval] curated-field preservation lookup failed (continuing):", (err as Error).message);
    }

    const { error: upsertError } = await client
      .from("works")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: false });

    if (upsertError) {
      console.error("[retrieval] (async) Works upsert error:", upsertError.message);
    } else {
      console.log(`[retrieval] (async) works-upsert persisted rows=${rows.length}`);
    }
    })();
    perf("works-upsert (fire-and-forget kicked off)", `rows=${rows.length}`);
  }

  // Filter out admin-excluded, noise, and shadow (duplicate) papers
  let candidates = merged;
  if (merged.length > 0) {
    const ids = merged.map((p: Paper) => p.id);
    const { data: excludedRows } = await client
      .from("works")
      .select("id")
      .in("id", ids)
      .or("excluded.eq.true,is_noise.eq.true,canonical_work_id.not.is.null");
    if (excludedRows && excludedRows.length > 0) {
      const excludedIds = new Set(excludedRows.map((r: Paper) => r.id));
      candidates = merged.filter((p: Paper) => !excludedIds.has(p.id));
    }
  }
  perf("excluded-filter", `candidates=${candidates.length}`);

  // Apply quality filters to split candidates into evidence.
  // If nothing passes filters, fall back to all candidates (don't show zero results
  // when we have papers — the filters were just too strict).
  // ---------------------------------------------------------------------------
  // Direct/indirect/excluded classifier REMOVED (2026-06-17, relevance-first
  // redesign — docs/superpowers/plans/2026-06-17-relevance-first-retrieval.md).
  // Membership is now decided by the cosine relevance floor in the RB_UNIFIED
  // path below (relevance = true query·paper cosine); the classifier no longer
  // computes or gates. These fields stay declared (always undefined for new
  // runs) so the response shape + old-saved-run coverage rendering are unchanged.
  // ---------------------------------------------------------------------------
  // Declared (never assigned for new runs) so the response shape + old-saved-run
  // coverage rendering are unchanged. `let` (not `const = undefined`) so the
  // union type — not the `never`-narrowed literal — survives the optional reads.
  // `let` without initializer keeps the union type for the optional reads in the
  // response object (a `const = undefined` would narrow to `never`).
  let facetCounts: { direct: number; indirect: number; excluded: number } | undefined;
  let queryFacetsForResult: Array<{ label: string; expansion: string[] }> | undefined;
  let classCounts: { directLac: number; directGlobal: number; indirect: number; excluded: number } | undefined;
  // Silence "assigned but never used" — they are read in the response object only.
  void facetCounts; void queryFacetsForResult; void classCounts;
  // evidenceMatch is dormant (breadth question Q5 dropped 2026-06-17); kept for
  // old saved runs. New runs leave it undefined → "both". No classifier filter runs.
  const evidenceMatchPref = filters.evidenceMatch ?? "both";

  // Resolve year window for in-memory filtering. Live APIs already enforce
  // yearStart at the source; this catches corpus papers (which have no
  // year-pushdown in the RPC) and stragglers from sources that ignored the param.
  const yearEnd = filters.timePeriod === "custom" && filters.endDate
    ? Number(String(filters.endDate).slice(0, 4)) || undefined
    : undefined;
  perf("classify+facet-filter", `candidates=${candidates.length}`);
  const filtered = candidates.filter((p: Paper) => passesQualityFilters(p, filters, yearStart, yearEnd));
  const filtersAreActive = hasActiveQualityFilters(filters);
  perf("quality-filter", `filtered=${filtered.length}`);

  // Display order (2026-05-09 — composite rerank within relevance-qualified pool):
  //   Stage 1 — relevance gate already happened (per-facet similarity gate
  //             in the classifier). Off-topic papers are already "excluded"
  //             or filtered out by the evidenceMatch toggle. The Maternal
  //             Labor Supply problem (commit 792d59b) is closed by the gate.
  //   Stage 2 — composite score over the qualified pool (DEFAULT_RERANK_WEIGHTS):
  //               0.50·similarity + 0.20·citation (age-normalised, log-scaled)
  //               + 0.15·rigor + 0.05·recency + 0.05·region + 0.05·fts
  //             (weights sum to 1.0; citation weight bumped 0.05→0.20 in
  //              Phase 1.3 on 2026-05-15 to rescue pre-2010 canonical papers)
  //             Filter-aware: region keyword set follows filters.regions
  //             (LAC default; user-picked region remaps; Global drops to 0).
  //             The cluster classification (direct-lac / direct-global /
  //             indirect) stays on each paper as metadata for UI badges
  //             but no longer hard-clusters the sort — canonical global
  //             papers can surface in top-20 when they're more on-topic
  //             than weaker LAC papers. See rerank.ts for the rationale.
  // EVIDENCE_TABLE_CAP is the module-level exported constant (top of file).
  // Phase 1.4 density-aware selection: rerankMerged sorts by composite
  // score; selectTopKDiverse then walks the top of that list and drops
  // duplicates / soft-penalises crowding (venue_kind, methodology, etc.).
  // Pool size 150 gives the diverse selector room to swap a duplicate at
  // position 5 for a varied paper at ~position 35 without leaving the
  // relevance-qualified tier.
  // Reranking: single-channel uses per-channel weights; multi-channel uses
  // rerankHybrid (causal=quality mult, time=max, lac=soft prioritization boost).
  // lac IS passed through (2026-06-11): in the hybrid it acts as a multiplier
  // (1 + LAC_PRIORITY × lac_score) so LAC papers are prioritized but global
  // canon (Jensen, Hanushek) is never excluded.
  const activeChannels = (channelsOverride ?? []);
  // RB_UNIFIED: attach real query·paper cosines (from DB) to each candidate.
  // Must happen BEFORE the dump (so the fixture carries realCosine) and BEFORE
  // _composite (so rerankUnified can read paper.realCosine). Falls back
  // gracefully on embed failure (copies paper.similarity).
  {
    try {
      // Reuse the query embedding already computed by the corpus search (same
      // `corpusQuery` text) instead of re-embedding — saves one LiteLLM round-trip
      // per search. Falls back to a fresh embed only if the corpus path didn't
      // surface a vector (FTS-only fallback, multi-facet with no whole-query embed,
      // or embed failure).
      let _qEmb: number[] | null =
        Array.isArray(corpusResult.queryEmbedding) && corpusResult.queryEmbedding.length
          ? corpusResult.queryEmbedding
          : null;
      if (_qEmb) {
        console.log(`[rb-unified] reusing corpus query embedding (no re-embed)`);
      } else {
        const _embClient = createEmbeddingClient();
        _qEmb = _embClient ? await _embClient.embedText(corpusQuery, "query") : null;
      }
      if (_qEmb && _qEmb.length) {
        const _ids = filtered.map((p: Paper) => String(p.id)).filter(Boolean);
        const _cosMap = await cosineForIds(client, _qEmb, _ids);
        for (const p of filtered) {
          const rc = _cosMap.get(String(p.id));
          const exact = typeof rc === "number";
          (p as Paper).realCosine = exact ? rc : Number(p.similarity ?? 0);
          // Mark whether realCosine is a GENUINE query·paper cosine vs a fallback
          // to the channel's synthetic `similarity` (e.g. foundational-FTS 0.72).
          // The relevance floor must not let a synthetic value set its threshold.
          (p as Paper & { _realCosExact?: boolean })._realCosExact = exact;
        }
        console.log(`[rb-unified] attached realCosine to ${_cosMap.size}/${_ids.length} candidates`);
      } else {
        console.warn("[rb-unified] query embed failed — realCosine falls back to similarity");
        for (const p of filtered) (p as Paper).realCosine = Number(p.similarity ?? 0);
      }
    } catch (e) { console.error("[rb-unified] realCosine attach failed:", (e as Error).message); }
  }
  // Offline-rig fixture dump (env-gated, NO behaviour change). Writes the
  // post-classification candidate pool (the exact input to rerank) so the
  // ablation rig replays rerankHybrid + floors faithfully without the embedding
  // endpoint. Set RB_DUMP_POOL=/abs/path.json on a single search; prod never sets it.
  const _dumpPath = (typeof Deno !== "undefined" ? Deno.env.get("RB_DUMP_POOL") : undefined);
  if (_dumpPath) {
    try {
      const _slim = filtered.map((p: Paper) => ({
        id: p.id, title: p.title, similarity: p.similarity, citation_count: p.citation_count,
        year: p.year, sms_level: p.sms_level, classification: p.classification,
        geography: p.geography, _retrievalSource: p._retrievalSource,
        fts_rank: p.fts_rank ?? p.ftsRank, methodology_design: p.methodology_design,
        realCosine: (p as Paper).realCosine,
      }));
      Deno.writeTextFileSync(_dumpPath, JSON.stringify({
        query, channels: activeChannels, regions: filters.regions ?? [], evidenceMatch: evidenceMatchPref, cap: EVIDENCE_TABLE_CAP, pool: _slim,
      }, null, 2));
      console.log(`[rb-dump] wrote ${_slim.length} candidates -> ${_dumpPath}`);
    } catch (e) { console.error("[rb-dump] failed:", (e as Error).message); }
  }

  const _domainWeights = await domainWeightsPromise;
  if (_domainWeights) console.log(`[domain-weights] applying ${_domainWeights.size} learned methodology weight(s) for user`);
  const _promoteWorkIds = await promoteFilterPromise;
  if (_promoteWorkIds.size > 0) console.log(`[promote-feedback] boosting ${_promoteWorkIds.size} paper(s) the user endorsed on a similar query`);
  const _composite = rerankUnified(filtered, filters as any, activeChannels, unifiedProfileName(), _domainWeights, _promoteWorkIds);
  console.log(`[retrieval] rerank mode=unified pool=${_composite.length}`);
  // Quota reorder (2026-06-24, RB_QUOTA, default OFF): guarantee the top-relevanceK
  // by RAW cosine + top-channelK per active channel lead the selection pool, so the
  // region boost reorders but never EVICTS high-cosine global canon (e.g. Jensen 2010
  // buried under boosted in-region papers).
  const _envNum = (k: string, d: number) => { const v = Number((typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k]) ?? d); return Number.isFinite(v) ? v : d; };
  const _quotaOn = ((typeof Deno !== "undefined" ? Deno.env.get("RB_QUOTA") : (globalThis as any).process?.env?.RB_QUOTA) === "1");
  const _rankedPool = _quotaOn
    ? quotaReorder(_composite, activeChannels, _envNum("RB_RELEVANCE_QUOTA_K", 25), _envNum("RB_CHANNEL_QUOTA_K", 12))
    : _composite;
  if (_quotaOn) console.log(`[quota] reordered pool: relevanceK=${_envNum("RB_RELEVANCE_QUOTA_K", 25)} channelK=${_envNum("RB_CHANNEL_QUOTA_K", 12)} channels=[${activeChannels.join(",")}]`);
  const _selectionPool = _rankedPool.slice(0, DEFAULT_SELECTION_POOL_SIZE);
  const _selection = selectTopKDiverse(_selectionPool, EVIDENCE_TABLE_CAP);
  if (_selection.duplicatesSkipped > 0) {
    console.log(
      `[retrieval] density-rerank dropped ${_selection.duplicatesSkipped} duplicate(s) from top-${EVIDENCE_TABLE_CAP}`,
    );
  }
  const evidence = _selection.selected;

  // Channel-aware display order. rerankUnified scores papers uniformly;
  // orderByChannel re-sorts the final evidence list so single-channel tables show
  // the most informative primary sort (foundational → citations desc, causal → SMS
  // desc, recent → year desc, multi-channel → _unifiedScore desc).
  {
    const _ordered = orderByChannel(evidence, activeChannels);
    evidence.splice(0, evidence.length, ..._ordered);

    // Relevance floor (2026-06-16): trim the table to papers whose REAL query
    // cosine clears RB_REL_FLOOR, so a thin-evidence query shows FEWER than the
    // cap instead of backfilling the 50 with off-topic papers. Consistent with the
    // cosine-relevance model (low cosine ⇒ don't show), NOT a channel gate. Always
    // keep at least RB_REL_MIN_KEEP top-ranked papers so a low-cosine query is never
    // gutted. Trimmed papers fall through to `extended` below (load-more still finds
    // them). Env-tunable; RB_REL_FLOOR=0 disables.
    // HYBRID floor (2026-06-17, validated via scripts/_recall-retention.ts): keep
    // papers with cosine ≥ max(ABS_MIN, topCos − Δ). The relative `topCos − Δ` term
    // adapts to query strength (qwen cosines are query-relative); ABS_MIN is the junk
    // floor. This is the MASTER precision mechanism (subsumes the region ramp and the
    // topicGeo FTS fix). Env: RB_REL_FLOOR (ABS_MIN, 0.45), RB_REL_DELTA (Δ, 0.15),
    // RB_REL_MIN_KEEP (8). RB_REL_FLOOR=0 disables.
    const _ev = (k: string, d: string) => Number((typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k]) ?? d);
    const _relAbsMin = _ev("RB_REL_FLOOR", "0.45");
    const _relDelta = _ev("RB_REL_DELTA", "0.15");
    const _relMinKeep = _ev("RB_REL_MIN_KEEP", "8");
    // STRICT (RB_REL_MINKEEP_STRICT=1): never backfill below the cosine floor. A query
    // the corpus can't answer returns a small honest table instead of being padded with
    // sub-floor papers (e.g. geo-channel LAC papers on an out-of-wheelhouse query — the
    // fl02 flood). The relative floor `topCos−0.15` still trims strong queries.
    const _strict = ((typeof Deno !== "undefined" ? Deno.env.get("RB_REL_MINKEEP_STRICT") : (globalThis as any).process?.env?.RB_REL_MINKEEP_STRICT) === "1");
    if (_relAbsMin > 0 && evidence.length > _relMinKeep) {
      const _cos = (p: Paper) => Number(p.realCosine ?? p.similarity ?? 0);
      // topCos over GENUINE cosines only — a paper carrying a synthetic channel
      // similarity (no embedding) must not inflate the threshold and trim real
      // vector hits. Fall back to all papers only if none have an exact cosine
      // (degraded embed path, where realCosine === similarity for everything).
      const _exact = evidence.filter((p: Paper) => (p as Paper & { _realCosExact?: boolean })._realCosExact);
      const _topPool = _exact.length > 0 ? _exact : evidence;
      const _top = _topPool.reduce((m: number, p: Paper) => Math.max(m, _cos(p)), 0);
      const _thr = Math.max(_relAbsMin, _top - _relDelta);
      const _above = evidence.filter((p: Paper) => _cos(p) >= _thr);
      // Non-strict fallback keeps the _relMinKeep MOST RELEVANT papers by cosine —
      // not evidence.slice(0,N), which under a single quality channel is the
      // display sort (most-cited / newest), i.e. exactly the off-topic-mega-cited
      // failure the floor exists to prevent. Select by cosine, but preserve the
      // channel display order in the kept subset.
      const _keepIds = new Set(
        [...evidence].sort((a, b) => _cos(b) - _cos(a)).slice(0, _relMinKeep).map((p) => p.id),
      );
      const _byCosDesc = evidence.filter((p: Paper) => _keepIds.has(p.id));
      const _keep = _strict ? _above : (_above.length >= _relMinKeep ? _above : _byCosDesc);
      if (_keep.length < evidence.length) {
        console.log(`[rel-floor] table ${evidence.length}→${_keep.length} (thr=${_thr.toFixed(3)}=max(${_relAbsMin}, ${_top.toFixed(3)}−${_relDelta}), minKeep=${_relMinKeep})`);
        evidence.splice(0, evidence.length, ..._keep);
      }
    }
  }

  // Extended evidence: next 150 papers from the ranked pool not selected in the
  // top-50. Stored in search_runs.extended_evidence_work_ids for cheap load-more
  // without re-running retrieval. Computed AFTER the balanced floor so swapped
  // papers land in the extended list, not duplicated.
  const _selectedIds = new Set(evidence.map((p) => p.id));
  const extended = _selectionPool.filter((p) => !_selectedIds.has(p.id)).slice(0, 150);

  // Cross-encoder pass (Qwen-as-judge). Flag-gated; graceful on failure (evidence
  // unchanged). Three modes, all DEFAULT OFF (eval before enabling — the judge adds
  // ~15-30s + chat-GPU load, the recurring contention risk):
  //   ENABLE_CROSS_ENCODER=true → full top-N rerank by judge score (original).
  //   RB_JUDGE_BAND=1           → (B) marginal-band judge: only re-score the
  //       CONTESTED cosine band [LO,HI); pin confident-high (cos≥HI) above in
  //       cosine order and confident-low (cos<LO) below. Spends the judge exactly
  //       where cosine is unreliable (measured: relevant/irrelevant overlap at
  //       cos 0.55-0.65), bounding cost to the uncertain middle.
  //   RB_COVERAGE_WARN=1        → (C) honesty signal: reuse the judge scores from
  //       B/CE (no extra calls) — if the TOP of the table is only weakly judged,
  //       emit a coverage warning instead of presenting thin evidence confidently.
  let lowEvidenceNote: string | null = null;
  let judgeDropped = 0; // (B) band papers dropped by the judge; feeds (C) thin-evidence
  let judgeBandSize = 0; // size of the judged band (drop denominator)
  try {
    const envGet = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k]);
    const ENV_ENABLE_CE = envGet("ENABLE_CROSS_ENCODER") === "true";
    const ENV_JUDGE_BAND = envGet("RB_JUDGE_BAND") === "1";
    const ceEnabled =
      crossEncoderOverride?.force === true ||
      ((ENV_ENABLE_CE || ENV_JUDGE_BAND) && crossEncoderOverride?.disable !== true);
    if (ceEnabled && evidence.length > 0) {
      const cos = (p: Paper) => Number((p as any).realCosine ?? p.similarity ?? 0);
      const t0 = Date.now();
      if (ENV_JUDGE_BAND) {
        // (B) marginal-band judge.
        const LO = parseFloat(envGet("RB_JUDGE_BAND_LO") ?? "0.50");
        const HI = parseFloat(envGet("RB_JUDGE_BAND_HI") ?? "0.70");
        // RB_JUDGE_DROP_THR (0-100, default 0=OFF=reorder-only): when set, band papers
        // the judge scores BELOW it are EXCLUDED from the table (dropped to `extended`/
        // load-more, NOT deleted — recoverable if the judge was wrong). Guards: only the
        // judged BAND can be dropped (confident-high cos≥HI is never judged/dropped);
        // unscored papers (judge failed) are KEPT (fail-safe).
        // CALIBRATED VALUE = 33 (probe-judge-drop-calibration.mjs, 2026-06-23): the
        // cross-encoder bins scores at 10/20/40/70 (10=off-topic, 40=tangential, 70=on-topic).
        // 33 drops the off-topic 10/20s and keeps 40+ (tangential papers are often genuinely
        // on-topic — e.g. info-intervention papers score 40). ce<50 OVER-TRIMS real evidence.
        // The explicit "high-cos ∧ low-judge" gate is EMPIRICALLY IDENTICAL to this (the
        // low-judge band papers ARE the high-cosine ones), so absolute-in-band is used.
        const DROP = parseFloat(envGet("RB_JUDGE_DROP_THR") ?? "0");
        // Cap the judged set to the top-MAX band papers by cosine. On a WEAK query the
        // whole table can fall in the band (q03: all 50 contested) → judging all 50 risks
        // the cross-encoder's batch timeout under GPU load (the smoke's 15s no-op). Judging
        // the top-MAX keeps cost flat; lower-cosine band papers stay un-judged (kept), and
        // "band ≫ MAX" is itself a thin-query signal C can read.
        // Band cap default 10 (≤1 cross-encoder batch): the judge runs on the most-
        // contested papers only, so cost stays flat and a weak query (whole table in
        // band) can't blow the batch budget. (Was 24.)
        const MAX = parseInt(envGet("RB_JUDGE_BAND_MAX") ?? "10", 10);
        // Judge backend defaults to GEMINI FLASH for B — off the local GPU, so it can't
        // hit the 15s Qwen timeout under embed/chat contention. RB_JUDGE_BACKEND=qwen reverts.
        const judgeBackend = (envGet("RB_JUDGE_BACKEND") === "qwen" ? "qwen" : "gemini") as "qwen" | "gemini";
        const above = evidence.filter((p) => cos(p) >= HI);
        const bandAll = evidence.filter((p) => cos(p) >= LO && cos(p) < HI).sort((a, b) => cos(b) - cos(a));
        const below = evidence.filter((p) => cos(p) < LO);
        const toJudge = bandAll.slice(0, MAX);
        const bandRest = bandAll.slice(MAX); // un-judged, kept in cosine order
        const rerankedJudge = toJudge.length > 1 ? await crossEncoderRerank(query, toJudge, { topN: toJudge.length, backend: judgeBackend }) : toJudge;
        judgeBandSize = toJudge.length;
        // RB_JUDGE_DROP_ONLY=1 (with DROP>0): use the judge ONLY to REMOVE the
        // high-disagreement band papers (cosine in [LO,HI) says maybe-relevant, judge
        // says off-topic) and leave the ENTIRE rest of the table in its original order.
        // No relevance reorder, no cosine-bucket re-splice — so channel-signature papers
        // (rigor/seminal/LAC) are NEVER demoted. The A/B (2026-06-23) showed the reorder,
        // not the drop, is what collapsed channel integrity; this isolates the drop.
        const dropOnly = envGet("RB_JUDGE_DROP_ONLY") === "1";
        if (DROP > 0 && dropOnly) {
          // Match by ID, not object identity — crossEncoderRerank returns NEW
          // objects, so a Set of those never matched `evidence` and the
          // calibrated drop silently no-op'd (while still logging "N removed").
          // Also propagate the judge scores onto the ORIGINAL objects so the
          // coverage-warn block below can read them.
          const scoreById = new Map(rerankedJudge.map((p) => [String(p.id), Number((p as any).crossEncoderScore)]));
          for (const p of evidence) {
            const s = scoreById.get(String(p.id));
            if (s != null && Number.isFinite(s)) (p as any).crossEncoderScore = s;
          }
          const dropIds = new Set(
            rerankedJudge.filter((p) => {
              const s = Number((p as any).crossEncoderScore);
              return Number.isFinite(s) && s < DROP; // off-topic disagreement (unscored kept, fail-safe)
            }).map((p) => String(p.id)),
          );
          judgeDropped = dropIds.size;
          if (dropIds.size) {
            const kept = evidence.filter((p) => !dropIds.has(String(p.id)));
            // Dropped ≠ deleted: judged-off-topic papers land at the END of the
            // extended (load-more) list, as the drop contract documents.
            extended.push(...evidence.filter((p) => dropIds.has(String(p.id))));
            evidence.splice(0, evidence.length, ...kept);
          }
          console.log(`[retrieval] judge-band (drop-only): judged ${toJudge.length} of ${bandAll.length} contested (cap ${MAX}); ${judgeDropped} removed<${DROP}, original order preserved; in ${Date.now() - t0}ms`);
        } else {
          let keptJudge = rerankedJudge;
          if (DROP > 0) {
            keptJudge = rerankedJudge.filter((p) => {
              const s = Number((p as any).crossEncoderScore);
              return !Number.isFinite(s) || s >= DROP; // keep unscored (fail-safe) + on-topic
            });
            judgeDropped = rerankedJudge.length - keptJudge.length;
            // Same recoverability contract as drop-only: dropped → end of load-more.
            if (judgeDropped > 0) {
              const keptIds = new Set(keptJudge.map((p) => String(p.id)));
              extended.push(...rerankedJudge.filter((p) => !keptIds.has(String(p.id))));
            }
          }
          evidence.splice(0, evidence.length, ...above, ...keptJudge, ...bandRest, ...below);
          console.log(`[retrieval] judge-band: judged ${toJudge.length} of ${bandAll.length} contested (cap ${MAX}); ${above.length} pinned high, ${bandRest.length} band-unjudged, ${below.length} low, ${judgeDropped} dropped<${DROP}; in ${Date.now() - t0}ms`);
        }
      } else {
        const ENV_CE_TOP_N = parseInt(envGet("CROSS_ENCODER_TOP_N") ?? "50", 10);
        const topN = crossEncoderOverride?.topN ?? (Number.isFinite(ENV_CE_TOP_N) ? ENV_CE_TOP_N : 50);
        const reranked = await crossEncoderRerank(query, evidence, { topN });
        evidence.splice(0, evidence.length, ...reranked);
        console.log(`[retrieval] cross-encoder reranked top-${topN} in ${Date.now() - t0}ms`);
      }
      // (C) coverage/honesty signal — reuses crossEncoderScore (0-100) attached above,
      // so it costs ZERO extra LLM calls. If the strongest evidence is only weakly
      // judged, the corpus likely lacks good direct evidence (the q03 "digital health"
      // pattern: papers clear the cosine floor at ~0.60 but the judge rates them ~0).
      if (envGet("RB_COVERAGE_WARN") === "1") {
        const WARN_THR = parseFloat(envGet("RB_COVERAGE_WARN_THR") ?? "45"); // 0-100 scale
        const topScores = evidence.slice(0, 10)
          .map((p) => Number((p as any).crossEncoderScore))
          .filter((s) => Number.isFinite(s));
        const meanTop = topScores.length >= 5
          ? topScores.reduce((a, b) => a + b, 0) / topScores.length
          : null;
        // Fire if survivors are weak (meanTop<THR) OR the judge dropped most of the
        // contested band (≥60%) — both mean "the corpus lacks good direct evidence",
        // independent of how clean the post-drop survivors look (the drop guard).
        const heavyDrop = judgeBandSize >= 5 && judgeDropped / judgeBandSize >= 0.6;
        if ((meanTop != null && meanTop < WARN_THR) || heavyDrop) {
          const detail = meanTop != null ? `mean relevance ${meanTop.toFixed(0)}/100` : `${judgeDropped}/${judgeBandSize} contested papers judged off-topic`;
          lowEvidenceNote = `Limited directly-relevant evidence: the strongest matches for this query are only weakly on-topic (${detail}). The corpus may lack direct evidence on this exact question — treat conclusions cautiously and consider broadening the query.`;
          console.log(`[retrieval] coverage-warn: meanTop=${meanTop?.toFixed(1) ?? "n/a"} dropped=${judgeDropped}/${judgeBandSize} → thin-evidence note`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[retrieval] cross-encoder failed, evidence unchanged: ${msg}`);
  }
  if (evidence.length > 0) {
    const lacCount = evidence.slice(0, 30).filter((p: Paper) => {
      const text = `${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
      return /\b(latin america|caribbean|mexico|brazil|argentina|chile|colombia|peru|costa rica|jamaica)\b/i.test(text);
    }).length;
    console.log(`[retrieval] Reranked ${evidence.length} evidence papers; ${lacCount}/30 top results mention LAC.`);
  }

  const notes = buildRetrievalNotes(
    { papers: allSsPapers },
    { papers: allOaPapers, count: universeCount },
    { papers: allCrPapers },
    wbResult,
    idbResult,
    exaResult,
    corpusResult,
    merged,
    expanded,
    crawlResult,
    recommendResult,
  );

  if (deniedVenueDropped > 0) {
    notes.push(
      `Venue denylist: ${deniedVenueDropped} paper${deniedVenueDropped !== 1 ? "s" : ""} from out-of-scope sources were blocked before ranking.`,
    );
  }

  if (_degradedRecall) {
    notes.unshift(
      "⚠️ Semantic search was degraded for this query (the embedding service did not respond), so results rely on keyword/citation matching and may miss relevant papers. Please try again shortly.",
    );
  }

  // (C) Thin-evidence coverage warning (judge-derived; see the cross-encoder block).
  if (lowEvidenceNote) notes.unshift(lowEvidenceNote);

  if (filtersAreActive && filtered.length < candidates.length) {
    const dropped = candidates.length - filtered.length;
    notes.push(`Quality filters: ${dropped} paper${dropped !== 1 ? "s" : ""} retrieved but excluded from evidence (did not pass SMS/ABS/RePEC thresholds).`);
  }

  // (direct→both evidenceMatch fallback note removed 2026-06-17 — classifier gone.)

  // Meta-analysis / systematic review boost — scoped to top of relevance-sorted set.
  //
  // Previous version promoted ANY meta-analysis in the merged result to the
  // absolute front. Because medical literature produces an outsized share of
  // systematic reviews globally, queries that include phrases like "high-
  // quality evidence" were consistently flooded with cancer / Alzheimer's /
  // Campbell-review papers — fully independent of topical relevance to the
  // user's actual question.
  //
  // New behavior: only re-order WITHIN the top BOOST_WINDOW results (which the
  // upstream APIs already deemed topically relevant). A meta-analysis ranked
  // at position #150 stays at #150.
  if (expanded?.boostMetaAnalyses) {
    const BOOST_WINDOW = 30;
    const metaRe = /\b(meta[- ]?analysis|systematic review|evidence synthesis|literature review)\b/i;
    const window = evidence.slice(0, BOOST_WINDOW);
    const tail = evidence.slice(BOOST_WINDOW);
    const metaInWindow: typeof evidence = [];
    const nonMetaInWindow: typeof evidence = [];
    for (const row of window) {
      const text = `${row.title ?? ""} ${row.abstract ?? ""}`;
      if (metaRe.test(text)) metaInWindow.push(row);
      else nonMetaInWindow.push(row);
    }
    if (metaInWindow.length > 0 && metaInWindow.length < window.length) {
      const reordered = [...metaInWindow, ...nonMetaInWindow, ...tail];
      evidence.splice(0, evidence.length, ...reordered);
      notes.push(`Meta-analysis boost: ${metaInWindow.length} review${metaInWindow.length !== 1 ? "s" : ""} promoted within top ${BOOST_WINDOW} (topic-relevant only).`);
    }
  }

  // (Facet-classification retrieval note removed 2026-06-17 — classifier gone.
  // classCounts is always undefined for new runs; old saved runs keep their
  // persisted notes/coverage. The relevance floor below decides membership.)

  // Apply per-user thumbs-down suppression. Promise was kicked off near the
  // top of retrieveWorks so it's almost always settled by the time we get here.
  const _dislikeT = Date.now();
  const dislikeFilter = await dislikeFilterPromise;
  if (dislikeFilter.hiddenCount > 0) {
    const before = { ev: evidence.length, cand: candidates.length };
    const isExcluded = (p: Paper) => {
      const id = (p as any).id ?? (p as any).workId ?? (p as any).canonical_doi;
      return id ? dislikeFilter.excludedWorkIds.has(String(id)) : false;
    };
    const filteredEv = evidence.filter((p) => !isExcluded(p));
    const filteredCand = candidates.filter((p) => !isExcluded(p));
    evidence.splice(0, evidence.length, ...filteredEv);
    candidates.splice(0, candidates.length, ...filteredCand);
    // `extended` (the load-more pool 51–200) was computed before this filter,
    // so without this a thumbs-down'd paper would resurface via "Load more".
    const filteredExt = extended.filter((p) => !isExcluded(p));
    extended.splice(0, extended.length, ...filteredExt);
    const droppedEv = before.ev - evidence.length;
    if (droppedEv > 0) {
      notes.push(
        `Hidden by your feedback: ${droppedEv} paper${droppedEv !== 1 ? "s" : ""} you thumbs-down'd on a similar past query.`,
      );
    }
    subPhase("dislike-filter", Date.now() - _dislikeT, `dropped=${droppedEv} hiddenCount=${dislikeFilter.hiddenCount}`);
  }

  // Evidence-card coverage should follow actual user-visible retrieval, not a
  // one-time global sweep. Keep this off the request critical path: it only
  // enqueues missing top evidence rows for the background extraction worker.
  void enqueueMissingEvidenceCards(client, evidence);

  perf("rerank+notes", `evidence=${evidence.length}`);
  console.log(`[perf] retrieveWorks TOTAL=${Date.now() - _perfT0}ms`);

  // Channel-of-origin map for the returned evidence + candidate set. Built from
  // the dedup-time accumulator (union of channels across all duplicates). Only
  // papers that a channel actually surfaced get an entry; plain vector/FTS
  // corpus papers are omitted. Purely additive telemetry.
  const workChannels: Record<string, string[]> = {};
  if (channelOriginMap.size > 0) {
    for (const p of [...evidence, ...candidates]) {
      const id = (p as any).id;
      if (!id || workChannels[id]) continue;
      const set = channelOriginMap.get(String(id));
      if (set && set.size > 0) workChannels[id] = Array.from(set);
    }
  }

  // Cosine summary for the pilot monitor (design spec §6). Read-only signal;
  // never gates ranking — just persisted on search_runs for the "cosine high?" check.
  const _evCos = evidence
    .map((p) => Number((p as Paper).realCosine ?? p.similarity ?? 0))
    .filter((n) => n > 0);
  const topCosine = _evCos.length ? Math.max(..._evCos) : null;
  const meanCosine = _evCos.length ? _evCos.reduce((a, b) => a + b, 0) / _evCos.length : null;

  return {
    candidates,
    evidence,
    extended,
    topCosine,
    meanCosine,
    ...(includeSelectionPool ? { selectionPool: _selectionPool } : {}),
    signals: [],
    coverage: {
      universeCount: universeCount,
      retrievedCount: merged.length,
      admissibleCount: candidates.length,
      evidenceCount: evidence.length,
      signalCount: 0,
      excludedByFacets: facetCounts?.excluded,
      facetLabels: queryFacetsForResult?.map((f) => f.label),
      hiddenByFeedback: (await dislikeFilterPromise).hiddenCount,
    },
    retrievalNotes: notes,
    facetCounts,
    classCounts,
    facets: queryFacetsForResult,
    perfLog: _perfLog,
    workChannels: Object.keys(workChannels).length > 0 ? workChannels : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the starting year from filters.
 *
 * 'recent'  -> 2020-present
 * 'custom'  -> parse startDate (falls back to 2015 if unparseable)
 * 'all' / default -> 2015
 */
function resolveYearStart(filters: SearchFilters): number {
  // "All time" means ALL years — no floor. Returning 2015 here (the old default)
  // silently cut every pre-2015 paper in passesQualityFilters, gutting the
  // foundational channel and dropping canonical pre-2015 papers (e.g. Jensen 2010
  // QJE, cit=1029) from "all time" + foundational searches. 1900 = effectively no
  // floor; the corpus vector search already caps by relevance, so this only stops
  // wrongly EXCLUDING relevant old papers — it never floods with ancient ones.
  if (filters.timePeriod === "all") {
    return 1900;
  }
  if (filters.timePeriod === "recent") {
    return 2020;
  }
  if (filters.timePeriod === "2000+") {
    return 2000;
  }
  if (filters.timePeriod === "custom" && filters.startDate) {
    const year = parseInt(String(filters.startDate).slice(0, 4), 10);
    return Number.isFinite(year) ? year : 1900;
  }
  if (filters.timePeriod === "last-5") {
    return new Date().getFullYear() - 5;
  }
  // UNSPECIFIED timePeriod → NO floor (1900), same as "all" (2026-06-24).
  // The old 2015 default was a SILENT hard recency filter the user never chose:
  // it dropped pre-2015 foundational canon (Jensen 2010 QJE cit=1029, Dinkelman
  // 2013, Attanasio 2014) from any caller that omits timePeriod — the plugin/API
  // path and eval harnesses. The UI always sets 'all' so it was unaffected, which
  // masked the footgun. Recency is a HARD filter ONLY when the user explicitly
  // picks 'recent'/'2000+'/'custom'/'last-5'; "no preference" must never gate by
  // year. The relevance floor + cosine ranking already prevent ancient-paper floods.
  // RB_LEGACY_YEAR_FLOOR=1 restores the old 2015 default (A/B comparison only).
  const _legacy = (typeof Deno !== "undefined" ? Deno.env.get("RB_LEGACY_YEAR_FLOOR") : (globalThis as any).process?.env?.RB_LEGACY_YEAR_FLOOR) === "1";
  return _legacy ? 2015 : 1900;
}

/**
 * Detect historical-depth intent from query text.
 * Returns a fallback year (e.g., 1990) when the query asks about long-run
 * trends, evolution, pre-2010 baselines, or systematic reviews — cases where
 * the default 2015 cutoff would miss foundational evidence.
 *
 * Returns null when no historical signal is present.
 */
export function detectHistoricalIntent(query: string): number | null {
  const q = query.toLowerCase();

  // Explicit year reference: "since 1985", "from 1990", "before 2000"
  const yearMatch = q.match(/\b(?:since|from|after|before|in)\s+(19[5-9]\d|20[01]\d)\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    return Math.max(1980, year - 5);
  }

  // Decade reference: "1990s", "1980s"
  const decadeMatch = q.match(/\b(19[5-9]\d|20[01]\d)s\b/);
  if (decadeMatch) return Math.max(1980, parseInt(decadeMatch[1], 10) - 5);

  // Keyword-based long-run signals
  const longRunSignals = [
    /\blong[- ]run\b/, /\blong[- ]term\b/, /\bhistorical(ly)?\b/,
    /\bevolution of\b/, /\bover the past\s+\d+\s+(years|decades)\b/,
    /\bsystematic review\b/, /\bmeta[- ]analys(is|es)\b/,
    /\bmeta[- ]review\b/,
  ];
  if (longRunSignals.some((re) => re.test(q))) return 1990;

  return null;
}

/**
 * Map a normalized paper object to a works table row (snake_case).
 */
function paperToRow(paper: Paper): Paper {
  // Classify methodology via keyword scan (QUAL-01/QUAL-04)
  const sms = classifyPaper(paper);

  return {
    id: paper.id,
    title: paper.title ?? "(untitled)",
    canonical_doi: paper.doi ?? null,
    year: paper.year ?? null,
    abstract: paper.abstract ?? null,
    citation_count: paper.citationCount ?? null,
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    publication_date: paper.publicationDate ?? null,
    is_open_access: paper.isOpenAccess ?? false,
    open_access_pdf_url: paper.openAccessPdfUrl ?? null,
    fields_of_study: Array.isArray(paper.fieldsOfStudy)
      ? paper.fieldsOfStudy
      : [],
    venue: paper.venue ?? null,
    journal_issn: paper.journalIssn ?? null,
    url: paper.url ?? paper.openAccessPdfUrl ?? null,
    source: paper.source ?? "unknown",
    raw_data: {},
    sms_level: sms.smsLevel,
    methodology_design: sms.design,
    causal_strength: sms.causalStrength,
    sms_method: sms.smsMethod,
    sms_rationale: sms.rationale ?? null,
    updated_at: new Date().toISOString(),
  };
}

function evidenceCardPriority(paper: Paper, index: number): number {
  // (Directness `classification` boost removed 2026-07-08 — the direct/indirect
  // classifier was retired 2026-06-17, so paper.classification is never populated
  // and the boost was always 0. Card priority is rank + rigor + citations + review.)
  const sms = Number(paper.sms_level ?? paper.smsLevel ?? 0);
  const rigorBoost = Number.isFinite(sms) ? Math.min(2, Math.max(0, sms) / 3) : 0;
  const citations = Number(paper.citation_count ?? paper.citationCount ?? 0);
  const citationBoost = Number.isFinite(citations) && citations > 0
    ? Math.min(2, Math.log1p(citations) / 4)
    : 0;
  const text = `${paper.title ?? ""} ${paper.abstract ?? ""}`.toLowerCase();
  const reviewBoost = /\b(meta[- ]?analysis|systematic review|literature review|evidence synthesis)\b/i.test(text)
    ? 0.75
    : 0;
  const rankBase = Math.max(1, 20 - index * 0.1);
  return Number((rankBase + rigorBoost + citationBoost + reviewBoost).toFixed(3));
}

async function enqueueMissingEvidenceCards(
  // deno-lint-ignore no-explicit-any
  client: any,
  papers: Paper[],
): Promise<void> {
  try {
    const seen = new Set<string>();
    const candidates = papers
      .filter((paper) => {
        const id = String(paper?.id ?? "");
        if (!id || seen.has(id)) return false;
        seen.add(id);
        if (isGenericNonPrimaryPaper(paper)) return false;
        return Boolean(paper?.title) && String(paper?.abstract ?? "").trim().length >= 80;
      })
      .slice(0, LAZY_EVIDENCE_CARD_ENQUEUE_LIMIT);

    if (candidates.length === 0) return;

    const ids = candidates.map((paper) => String(paper.id));
    const [cardsResult, queueResult] = await Promise.all([
      client.from("evidence_cards").select("work_id").in("work_id", ids),
      client.from("extraction_queue").select("work_id").in("work_id", ids),
    ]);

    if (cardsResult.error || queueResult.error) {
      console.warn(
        "[retrieval] evidence-card lazy enqueue skipped:",
        cardsResult.error?.message ?? queueResult.error?.message,
      );
      return;
    }

    const already = new Set<string>();
    for (const row of cardsResult.data ?? []) already.add(String(row.work_id));
    for (const row of queueResult.data ?? []) already.add(String(row.work_id));

    const rows = candidates
      .map((paper, index) => ({ paper, index }))
      .filter(({ paper }) => !already.has(String(paper.id)))
      .map(({ paper, index }) => ({
        work_id: String(paper.id),
        priority_score: evidenceCardPriority(paper, index),
        state: "queued",
      }));

    if (rows.length === 0) return;

    const { error } = await client
      .from("extraction_queue")
      .upsert(rows, { onConflict: "work_id", ignoreDuplicates: true });
    if (error) {
      console.warn("[retrieval] evidence-card lazy enqueue failed:", error.message);
      return;
    }
    console.log(`[retrieval] lazy-enqueued ${rows.length} evidence-card row(s)`);
  } catch (err) {
    console.warn("[retrieval] evidence-card lazy enqueue error:", (err as Error).message);
  }
}

/**
 * Build human-readable retrieval notes for the response.
 */
// deno-lint-ignore no-explicit-any
function buildRetrievalNotes(
  ssResult: any,
  oaResult: any,
  crResult: any,
  wbResult: any,
  idbResult: any,
  exaResult: any,
  corpusResult: any,
  merged: Paper[],
  expanded?: { variants: string[]; method: string; boostMetaAnalyses: boolean },
  crawl?: { papers: Paper[]; seedCount: number; linksExamined: number; crawlTimeMs: number },
  recommend?: { papers: Paper[]; seedCount: number; timeMs: number },
): string[] {
  const notes: string[] = [];

  // Report query expansion
  if (expanded && expanded.variants.length > 1) {
    notes.push(`Query expansion (${expanded.method}): ${expanded.variants.length} search variants used — "${expanded.variants.join('", "')}".`);
  }

  const ssCount = ssResult.papers?.length ?? 0;
  const oaCount = oaResult.papers?.length ?? 0;
  const crCount = crResult.papers?.length ?? 0;
  const wbCount = wbResult.papers?.length ?? 0;
  const idbCount = idbResult.papers?.length ?? 0;
  const exaCount = exaResult.papers?.length ?? 0;
  const corpusCount = corpusResult.papers?.length ?? 0;
  const totalRaw = ssCount + oaCount + crCount + wbCount + idbCount + exaCount + corpusCount;
  const dedupedCount = merged.length;
  const dropped = totalRaw - dedupedCount;

  if (ssCount > 0) notes.push(`Semantic Scholar: retrieved ${ssCount} paper${ssCount !== 1 ? "s" : ""}.`);
  else notes.push("Semantic Scholar: no results (API unavailable or key missing).");

  if (oaCount > 0) notes.push(`OpenAlex: retrieved ${oaCount} paper${oaCount !== 1 ? "s" : ""}.`);
  else notes.push("OpenAlex: no results.");

  if (crCount > 0) notes.push(`CrossRef: retrieved ${crCount} paper${crCount !== 1 ? "s" : ""}.`);
  else notes.push("CrossRef: no results.");

  if (wbCount > 0) notes.push(`World Bank: retrieved ${wbCount} document${wbCount !== 1 ? "s" : ""}.`);
  else notes.push("World Bank: no results.");

  if (idbCount > 0) notes.push(`IDB Publications: retrieved ${idbCount} publication${idbCount !== 1 ? "s" : ""}.`);
  else notes.push("IDB Publications: no results.");

  if (exaCount > 0) notes.push(`Exa: retrieved ${exaCount} paper${exaCount !== 1 ? "s" : ""} from trusted LAC policy domains.`);
  else notes.push("Exa: no results (API unavailable or key missing).");

  if (corpusCount > 0) {
    const timeMs = corpusResult.searchTimeMs ?? 0;
    notes.push(`Local corpus: ${corpusCount} paper${corpusCount !== 1 ? "s" : ""} found via semantic similarity (${timeMs}ms).`);
  }

  if (crawl && crawl.papers.length > 0) {
    notes.push(`Citation graph: crawled ${crawl.seedCount} seed papers (${crawl.linksExamined} links), discovered ${crawl.papers.length} additional paper${crawl.papers.length !== 1 ? "s" : ""} (${crawl.crawlTimeMs}ms).`);
  }

  if (recommend && recommend.papers.length > 0) {
    notes.push(`SS Recommendations: ${recommend.papers.length} similar paper${recommend.papers.length !== 1 ? "s" : ""} from ${recommend.seedCount} seeds (${recommend.timeMs}ms).`);
  }

  if (dropped > 0) {
    notes.push(`Deduplication: removed ${dropped} duplicate${dropped !== 1 ? "s" : ""} across sources.`);
  }

  if (oaResult.count > 0) {
    notes.push(
      `OpenAlex universe estimate: ~${oaResult.count.toLocaleString()} papers since ${new Date().getFullYear() - 10 < 2015 ? 2015 : "the selected period"}.`
    );
  }

  if (dedupedCount === 0) {
    notes.push(
      "No papers found. Try broadening your query or adjusting the time range."
    );
  }

  return notes;
}

/**
 * Return an empty retrieval result with the given notes.
 */
function emptyResult(notes: string[]): RetrievalResult {
  return {
    candidates: [],
    evidence: [],
    signals: [],
    coverage: {
      universeCount: 0,
      retrievedCount: 0,
      admissibleCount: 0,
      evidenceCount: 0,
      signalCount: 0,
    },
    retrievalNotes: notes,
  };
}

/**
 * Simple promisified sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether any quality filter dimension is actually restricting results.
 * Returns false when all levels are selected (the default) — no filtering needed.
 */
function hasActiveQualityFilters(filters: SearchFilters): boolean {
  if (filters.smsLevels && filters.smsLevels.length > 0 && filters.smsLevels.length < 6) return true;
  if (filters.absRatings && filters.absRatings.length > 0 && filters.absRatings.length < 5) return true;
  if (filters.repecBands && filters.repecBands.length > 0 && filters.repecBands.length < 5) return true;
  if (filters.journalTiers && filters.journalTiers.length > 0 && filters.journalTiers.length < 5) return true;
  if (filters.methodology && filters.methodology.length > 0) return true;
  if (filters.regions && filters.regions.length > 0) return true;
  if (filters.workingPaperSources && filters.workingPaperSources.length > 0) return true;
  if (filters.institutionalSources && filters.institutionalSources.length > 0) return true;
  if (filters.timePeriod && filters.timePeriod !== "all") return true;
  return false;
}

/**
 * Check if a paper passes the user's quality filters.
 * A paper passes if it satisfies ALL active filter dimensions.
 * Papers with no score for a dimension pass that dimension (don't penalize unscored papers).
 */
function passesQualityFilters(paper: Paper, filters: SearchFilters, yearStart?: number, yearEnd?: number): boolean {
  // Year filter: paper.year must fall in [yearStart, yearEnd] if provided.
  // Papers with no year pass (don't penalize unscored papers).
  if ((yearStart != null || yearEnd != null) && paper.year != null) {
    const y = Number(paper.year);
    if (Number.isFinite(y)) {
      if (yearStart != null && y < yearStart) return false;
      if (yearEnd != null && y > yearEnd) return false;
    }
  }

  // Methodology filter: paper's methodology_design must be in the allowed set.
  if (filters.methodology && filters.methodology.length > 0) {
    const design = paper.methodology_design ?? paper.methodologyDesign;
    if (design && !filters.methodology.includes(design)) return false;
  }

  // Region is NO LONGER a hard filter here (2026-06-12). It used to `return false`
  // on any paper whose geography didn't overlap the selected region's keywords —
  // which silently dropped on-topic canon outside the region (e.g. Jensen 2010,
  // Dominican Republic, for a LAC info-on-returns query when the region was set
  // to Sub-Saharan Africa, collapsing the pool 1092→63). A region selection is
  // now "strong preference, never exclude": prioritization happens via the region
  // boost in rerank.ts (rerankHybrid `regionBoost` + the additive region weight)
  // and the region representation FLOOR in retrieveWorks — the global/seminal
  // canon (foundational citation floor) stays eligible. "Global"/"Any"/"World"
  // never carried region intent and is likewise a no-op. Do NOT re-introduce a
  // `return false` region gate.

  // Source picker (Journals + Working papers + Institutional) is OR-combined:
  // a paper passes the source gate if it matches ANY selected source bucket.
  // The journal-tier check is folded in here too so a paper without a matching
  // tier can still pass via WP or institutional.
  const wpActive   = !!(filters.workingPaperSources && filters.workingPaperSources.length > 0);
  const instActive = !!(filters.institutionalSources && filters.institutionalSources.length > 0);
  const tiersActive = !!(filters.journalTiers && filters.journalTiers.length > 0 && filters.journalTiers.length < 5);

  if (wpActive || instActive || tiersActive) {
    const haystack = `${paper.venue ?? ""} ${paper.source ?? ""}`.toLowerCase();
    let matched = false;

    if (tiersActive) {
      const tier = getTierForVenue(paper.venue ?? null);
      if (filters.journalTiers!.includes(tier)) {
        // Excluded individual journals override the tier match.
        const excluded = paper.venue && filters.excludedJournalsByTier?.[String(tier)];
        if (!excluded || !excluded.some((j: string) => NORMALIZE_VENUE(j) === NORMALIZE_VENUE(paper.venue))) {
          matched = true;
        }
      }
    }

    if (!matched && wpActive) {
      if (filters.workingPaperSources!.some((id) => matchesWorkingPaperSource(paper, id))) matched = true;
    }

    if (!matched && instActive) {
      const paperSourceFamily = String(paper.sourceFamily ?? paper.source_family ?? "");
      if (filters.institutionalSources!.some((id) => (INSTITUTIONAL_SOURCE_FAMILIES[id] ?? []).includes(paperSourceFamily))) {
        matched = true;
      }
    }

    if (!matched && instActive) {
      const allHints = filters.institutionalSources!.flatMap((id) => INSTITUTIONAL_HINTS[id] ?? []);
      if (matchesAnyHint(haystack, allHints)) matched = true;
    }

    // Opt-in: a journal article in a venue with no ABS rating (tier 5 = unmapped)
    // ALSO passes when includeUnranked is set. Mirrors the RPC unranked disjunct
    // (abs_rating IS NULL AND publication_type='journal_article'); here we use the
    // name-based tier lookup since channel papers may not carry abs_rating.
    if (!matched && filters.includeUnranked && getTierForVenue(paper.venue ?? null) === 5) {
      const pubType = String(paper.publicationType ?? paper.publication_type ?? "");
      if (!pubType || pubType === "journal_article") matched = true;
    }

    if (!matched) return false;
  }

  // SMS filter: paper's sms_level must be in the allowed set
  if (filters.smsLevels && filters.smsLevels.length > 0 && filters.smsLevels.length < 6) {
    const sms = paper.sms_level ?? paper.smsLevel;
    if (sms != null && !filters.smsLevels.includes(sms)) return false;
  }

  // ABS filter: paper's abs_rating must be in the allowed set
  if (filters.absRatings && filters.absRatings.length > 0 && filters.absRatings.length < 5) {
    const abs = paper.abs_rating ?? paper.absRating;
    if (abs != null && !filters.absRatings.includes(abs)) return false;
  }

  // RePEC filter: paper's repec_percentile must map to an allowed band
  if (filters.repecBands && filters.repecBands.length > 0 && filters.repecBands.length < 5) {
    const pct = paper.repec_percentile ?? paper.repecPercentile;
    if (pct != null) {
      const band = pct >= 95 ? "top_5" : pct >= 90 ? "top_5_10" : pct >= 75 ? "top_10_25" : pct >= 50 ? "top_25_50" : "bottom_50";
      if (!filters.repecBands.includes(band)) return false;
    }
  }

  // Journal tier filter is now folded into the source-picker block above.

  return true;
}

function extractTokens(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

/**
 * Strip natural-language preamble from a user question so keyword-based
 * APIs (Semantic Scholar, OpenAlex) get a clean search string.
 *
 * "What does high-quality evidence say about AI and labor in LAC?"
 *  → "AI and labor in LAC"
 */
const NL_PREAMBLE = /^(what\s+(does|do|is|are|did)\s+)?.*?\b(say|show|suggest|tell\s+us|indicate|reveal|find|know)\s+(about|on|regarding)\s+/i;
const STOP_PHRASES = [
  /\bhigh[- ]quality evidence\b/gi,
  /\bthe (latest|recent|current) (research|evidence|literature|studies)\b/gi,
  /\bwhat (does|do) we know about\b/gi,
  /\bplease\b/gi,
];

const FILLER_WORDS = /\b(the|and|or|of|in|on|for|to|a|an|is|are|was|were|its|their|this|that|these|those|how|does|do|did|can|could|would|should|has|have|had|been|being|with|from|into|between|through)\b/gi;

export function sanitizeQueryForSearch(raw: string): string {
  let q = raw.trim();
  // Strip leading question-style preamble
  q = q.replace(NL_PREAMBLE, "");
  // Remove residual stop phrases
  for (const re of STOP_PHRASES) q = q.replace(re, "");
  // Strip punctuation (commas, semicolons, etc.) and question marks
  q = q.replace(/[,;:!?]+/g, " ");
  // Remove common filler/stop words to keep only content terms
  q = q.replace(FILLER_WORDS, " ");
  // Collapse whitespace
  q = q.replace(/\s+/g, " ").trim();
  return q || raw.trim();
}
