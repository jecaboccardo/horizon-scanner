/**
 * supabase/functions/_shared/vectorSearch.ts
 *
 * Hybrid corpus search: vector (pgvector cosine) + keyword (Postgres FTS,
 * ts_rank_cd — loosely called "BM25" but NOT the Okapi BM25 algorithm),
 * merged with Reciprocal Rank Fusion via the match_works RPC.
 *
 * Designed to run in parallel with live API fan-out — starts immediately
 * without waiting for query expansion. Adds zero sequential latency.
 */

import { createEmbeddingClient, buildEmbeddingText } from "./embeddingClient.ts";
import { adminClient } from "./supabase.ts";
import { expandQueryForFTS } from "./synonymExpander.ts";

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

// ---------------------------------------------------------------------------
// Pre-filter feature flag (USE_PREFILTERED_MATCH_WORKS=true)
//
// When enabled, all match_works calls use match_works_v2 which accepts
// optional SQL pre-filter params. This shrinks the vector-scan universe
// before similarity is computed, enabling exact-scan recall on a smaller set
// instead of HNSW recall on the full 622k corpus.
//
// Validate via eval-prefilter-comparison.mjs before enabling in production.
// Callers may pass explicit preFilters; if omitted, DEFAULT_PRE_FILTERS apply.
// ---------------------------------------------------------------------------

export interface PreFilters {
  filter_min_year?: number;
  filter_max_year?: number;
  filter_venue_exact?: string[];
  filter_venue_patterns?: string[];
  filter_source_families?: string[];
  filter_publication_types?: string[];
  filter_topics?: string[];
  filter_regions?: string[];
  filter_sms_min?: number;
  filter_abs_ratings?: string[];
  filter_repec_min_pct?: number;
  // Opt-in: when true, journal articles with no ABS rating (unranked venues)
  // ALSO pass the venue gate. Additive — widens the source universe only.
  filter_include_unranked?: boolean;
}

const USE_PREFILTERED = (typeof Deno !== "undefined")
  ? Deno.env.get("USE_PREFILTERED_MATCH_WORKS") === "true"
  : process.env.USE_PREFILTERED_MATCH_WORKS === "true";

// Tier 1+2 journal exact names (mirrors retrieval.ts TIER_VENUES).
const TIER1_2_VENUES = [
  "American Economic Review", "The Quarterly Journal of Economics", "Econometrica",
  "Journal of Political Economy", "The Review of Economic Studies",
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
];

// Institutional + WP host patterns (mirrors INSTITUTIONAL_HINTS + WORKING_PAPER_HINTS).
const VENUE_PATTERNS = [
  "%iadb%", "%inter-american development bank%", "%idb working paper%", "%idb publication%",
  "%world bank%", "%open knowledge repository%", "%worldbank.org%",
  "%oecd%",
  "%cepal%", "%eclac%",
  "%nber%", "%national bureau of economic research%",
  "%ssrn%",
  "%iza%",
  "%cepr%",
  "%j-pal%", "%3ie%",
  "%unicef%", "%ilo %", "%undp%", "%imf %", "%unesco%",
];

// Default pre-filters: year and SMS only.
//
// Venue is NOT a default pre-filter. Venue quality is enforced post-retrieval
// via the TypeScript scoring layer (TIER_VENUES boost in retrieval.ts).
// Adding venue as an invisible default silently drops valid interdisciplinary
// evidence (World Development, JPAM, health/social science journals) that the
// post-retrieval layer correctly ranks down — not out.
//
// Rules:
//   - Default: year >= 2010, SMS soft (>= 3 OR IS NULL)
//   - User-selected venue/source → caller passes filter_venue_exact + filter_venue_patterns
//   - User-selected publication_type → caller passes filter_publication_types
//   - Inferred quality (venue tier, institution) → NEVER a hard pre-filter
//
// No default year or SMS floor. The recency question in the search clarifier
// handles year scoping explicitly. SMS quality is handled by the scoring layer
// (causal channel rigor weight 0.40), not by SQL exclusion — theory papers
// (SMS=0) and descriptive studies (SMS=1) are legitimately relevant for the
// foundational channel and general queries. Only user-selected SMS filters
// (from the SourcesPicker) become hard SQL predicates.
const DEFAULT_PRE_FILTERS: PreFilters = {};

function rpcName(): string {
  return USE_PREFILTERED ? "match_works_v2" : "match_works";
}

function rpcParams(
  embedding: number[],
  queryText: string,
  threshold: number,
  count: number,
  preFilters?: PreFilters,
): Record<string, unknown> {
  const base = {
    query_embedding: embedding,
    // Expand FTS query text with policy-domain synonyms so websearch_to_tsquery
    // hits papers that use different but equivalent academic terminology.
    // The vector embedding uses the original query; only FTS benefits from expansion.
    query_text:      expandQueryForFTS(queryText),
    match_threshold: threshold,
    match_count:     count,
  };
  // Explicit user-selected preFilters always apply — they represent a deliberate
  // user choice (journalTiers, institutionalSources, workingPaperSources, SMS level,
  // time range, publication types) and must reach the SQL layer regardless of the
  // USE_PREFILTERED flag. The flag only controls whether server-side *defaults*
  // (year>=2010, sms>=2) apply when the caller passes nothing.
  if (preFilters && Object.keys(preFilters).length > 0) {
    return { ...base, ...preFilters };
  }
  if (!USE_PREFILTERED) return base;
  return { ...base, ...DEFAULT_PRE_FILTERS };
}

export interface CorpusSearchResult {
  papers: Paper[];
  searchTimeMs: number;
  vectorCount: number;
  ftsCount: number;
  /** Time spent embedding the query (LiteLLM/Qwen call). Diagnostic. */
  embedTimeMs?: number;
  /** Time spent in the match_works RPC (vector + FTS). Diagnostic. */
  rpcTimeMs?: number;
  /** The query embedding this search computed (taskType "query"). Surfaced so
   *  callers (e.g. the RB_UNIFIED realCosine pass) can reuse it instead of
   *  re-embedding the identical query text. Absent on FTS-only fallback. */
  queryEmbedding?: number[];
}

/**
 * Hybrid search against the local corpus.
 *
 * Uses match_works RPC which runs vector + FTS keyword search in parallel
 * and merges with Reciprocal Rank Fusion. Falls back to vector-only if FTS index
 * not yet available (before DevOps runs migration).
 *
 * Never throws — returns empty result on any failure.
 */
export async function searchLocalCorpus(
  query: string,
  { limit = 40, threshold = 0.50, preFilters, ftsQuery }: { limit?: number; threshold?: number; preFilters?: PreFilters; ftsQuery?: string } = {},
): Promise<CorpusSearchResult> {
  const start = Date.now();

  const embeddingClient = createEmbeddingClient();
  if (!embeddingClient) {
    return { papers: [], searchTimeMs: 0, vectorCount: 0, ftsCount: 0 };
  }

  // Embed query immediately — don't wait for query expansion.
  // taskType="query" is required for Nomic models so this vector lands
  // in the same space as the document-prefixed corpus embeddings.
  const _embedT = Date.now();
  const queryEmbedding = await embeddingClient.embedText(query, "query");
  const embedTimeMs = Date.now() - _embedT;
  if (!queryEmbedding) {
    console.warn("[corpus] Failed to embed query — falling back to FTS only");
    return ftsOnlySearch(query, limit, start);
  }

  // ftsQuery lets the caller use focused concept terms for the FTS component
  // (websearch_to_tsquery) while the vector embedding still uses the full query.
  // Without this, a long NL question ANDs every word via websearch_to_tsquery and
  // on-topic seminal papers (e.g. Jensen 2010) get fts_rank=0 because they lack
  // generic terms like "learning outcomes". With concept terms ("returns information
  // schooling") the FTS correctly identifies on-topic papers.
  const effectiveFtsQuery = ftsQuery ?? query;

  try {
    // Try hybrid RPC first (available after migration)
    const _rpcT = Date.now();
    const { data, error } = await adminClient.rpc(
      rpcName(),
      rpcParams(queryEmbedding, effectiveFtsQuery, threshold, limit, preFilters),
    );
    const rpcTimeMs = Date.now() - _rpcT;

    if (error) {
      // RPC signature mismatch means migration not yet run — fall back to vector-only
      if (error.message.includes("query_text") || error.message.includes("fts")) {
        console.warn("[corpus] Hybrid RPC not available yet — using vector-only fallback");
        return vectorOnlySearch(queryEmbedding, threshold, limit, start, query);
      }
      console.error("[corpus] match_works error:", error.message);
      return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0, embedTimeMs, rpcTimeMs };
    }

    const papers = (data ?? []).map(mapRow).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
    const vectorCount = papers.filter((p: Paper) => p.similarity > 0).length;
    const ftsCount = papers.filter((p: Paper) => p.ftsRank > 0).length;

    const elapsed = Date.now() - start;
    console.log(`[corpus] Hybrid: ${papers.length} papers in ${elapsed}ms (embed=${embedTimeMs}ms rpc=${rpcTimeMs}ms vector=${vectorCount} fts=${ftsCount})`);

    return { papers, searchTimeMs: elapsed, vectorCount, ftsCount, embedTimeMs, rpcTimeMs, queryEmbedding };
  } catch (err) {
    console.error("[corpus] Search error:", (err as Error).message);
    return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

async function vectorOnlySearch(
  queryEmbedding: number[],
  threshold: number,
  limit: number,
  start: number,
  queryText = "",
  preFilters?: PreFilters,
): Promise<CorpusSearchResult> {
  try {
    const { data, error } = await adminClient.rpc(
      rpcName(),
      rpcParams(queryEmbedding, queryText, threshold, limit, preFilters),
    );

    if (error) {
      console.error("[corpus] Vector-only fallback error:", error.message);
      return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0 };
    }

    const papers = (data ?? []).map(mapRow).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
    const elapsed = Date.now() - start;
    console.log(`[corpus] Vector-only: ${papers.length} papers in ${elapsed}ms`);
    return { papers, searchTimeMs: elapsed, vectorCount: papers.length, ftsCount: 0, queryEmbedding };
  } catch (err) {
    console.error("[corpus] Vector-only error:", (err as Error).message);
    return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0 };
  }
}

async function ftsOnlySearch(
  query: string,
  limit: number,
  start: number,
): Promise<CorpusSearchResult> {
  try {
    const { data, error } = await adminClient
      .from("works")
      .select("id, title, abstract, year, citation_count, canonical_doi, authors, publication_date, is_open_access, open_access_pdf_url, fields_of_study, venue, journal_issn, url, source, sms_level, methodology_design, causal_strength, abs_rating, repec_percentile, corpus_source, publication_type, publication_type_method, publication_type_confidence, source_family, venue_kind, geography, raw_data")
      .textSearch("fts_vector", query, { type: "websearch", config: "english" })
      .limit(limit);

    if (error) {
      console.error("[corpus] FTS-only error:", error.message);
      return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0 };
    }

    const papers = (data ?? []).map((row: Paper) => mapRow({ ...row, similarity: 0, fts_rank: 1 })).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
    const elapsed = Date.now() - start;
    console.log(`[corpus] FTS-only: ${papers.length} papers in ${elapsed}ms`);
    return { papers, searchTimeMs: elapsed, vectorCount: 0, ftsCount: papers.length };
  } catch (err) {
    console.error("[corpus] FTS-only error:", (err as Error).message);
    return { papers: [], searchTimeMs: Date.now() - start, vectorCount: 0, ftsCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapRow(row: Paper): Paper {
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    abstract: row.abstract,
    citationCount: row.citation_count ?? null,
    doi: row.canonical_doi,
    authors: row.authors ?? [],
    publicationDate: row.publication_date,
    isOpenAccess: row.is_open_access ?? false,
    openAccessPdfUrl: row.open_access_pdf_url,
    fieldsOfStudy: row.fields_of_study ?? [],
    venue: row.venue,
    journalIssn: row.journal_issn,
    url: row.url,
    source: row.source ?? "corpus",
    sms_level: row.sms_level,
    methodology_design: row.methodology_design,
    causal_strength: row.causal_strength,
    abs_rating: row.abs_rating,
    repec_percentile: row.repec_percentile,
    scl_topics: row.scl_topics ?? [],
    geography: row.geography ?? [],
    similarity: row.similarity ?? 0,
    ftsRank: row.fts_rank ?? 0,
    corpusSource: row.corpus_source,
    publicationType: row.publication_type ?? null,
    publicationTypeMethod: row.publication_type_method ?? null,
    publicationTypeConfidence: row.publication_type_confidence ?? null,
    sourceFamily: row.source_family ?? null,
    venueKind: row.venue_kind ?? null,
    abstractBackfill: row.raw_data?.abstract_backfill ?? null,
  };
}

// ---------------------------------------------------------------------------
// Multi-vector search (Wave-N: per-facet retrieval, 2026-05-07)
//
// Embeds each facet's expansion text separately, fires N parallel match_works
// calls, unions the results, dedupes by paper id, and ranks by max similarity
// across facets. This is soft-OR retrieval at the embedding level — papers
// near ANY facet's concept space surface, and the downstream Direct/Indirect
// classifier provides conjunctive precision.
//
// Why this instead of single-vector cosine over a bag-of-tokens query:
//   "AI and labor in LAC" embedded as one vector lands at the centroid of
//   those concepts, biasing toward papers strong on all-three-on-average.
//   Multi-vector preserves each facet's identity — a paper brilliant on AI
//   but quiet on LAC still surfaces (then gets tagged Indirect downstream
//   instead of being silently dropped at retrieval).
// ---------------------------------------------------------------------------

export interface FacetSearchInput {
  /** Short label for logs/diagnostics (e.g. "ai", "labor", "geography") */
  label: string;
  /** Concatenated synonyms + label that get embedded as one vector */
  text: string;
}

export interface MultiVectorSearchResult extends CorpusSearchResult {
  /** Per-facet hit count, for diagnostics */
  perFacetCounts: Record<string, number>;
  /** Number of papers that surfaced via the HyDE channel (0 if disabled) */
  hydeCount?: number;
  /** How many HyDE-surfaced papers were ALSO matched by at least one real facet */
  hydeOverlapCount?: number;
  /**
   * Facet embeddings, one per facet label. Exposed so downstream code
   * (attachFacetSimilarities) can compute cosine(paper, facet) for every
   * candidate paper — even ones that didn't clear that facet's retrieval
   * threshold. This eliminates the "missing facet sim reads as 0" bug that
   * collapses classification when Qwen decomposes into 2+ facets.
   * Keys are facet labels matching `facets[*].label` from the input. Values
   * are 768-dim arrays (qwen3-embedding:8b @ dimensions=768). Null if embed call failed for
   * that facet — caller should skip it gracefully.
   */
  facetEmbeddings?: Record<string, number[] | null>;
}

export interface HydeInput {
  /** Synthetic abstract text — embedded as one extra retrieval vector. */
  text: string;
  /** Cosine threshold for the HyDE channel (separate from per-facet threshold). */
  threshold?: number;
  /** Max papers from the HyDE channel before union. */
  limit?: number;
}

/**
 * Multi-vector hybrid search.
 *
 * For each facet, embed its expansion text and run a vector+FTS search via
 * the existing match_works RPC. Then union all results (max-similarity wins
 * on duplicates) and return the top-N.
 *
 * Falls through to single-vector searchLocalCorpus when only one facet is
 * provided — no point paying the multi-vector cost for a one-vector query.
 */
export async function searchLocalCorpusMulti(
  facets: FacetSearchInput[],
  originalQuery: string,
  {
    limit = 500,
    perFacetLimit = 200,
    threshold = 0.45,
    hyde = null,
    preFilters,
  }: {
    limit?: number;
    perFacetLimit?: number;
    threshold?: number;
    hyde?: HydeInput | null;
    preFilters?: PreFilters;
  } = {},
): Promise<MultiVectorSearchResult> {
  const start = Date.now();
  const perFacetCounts: Record<string, number> = {};

  if (facets.length === 0 && !hyde) {
    return { papers: [], searchTimeMs: 0, vectorCount: 0, ftsCount: 0, perFacetCounts };
  }

  // Single facet: cheaper to use the existing single-vector path. The single
  // facet's similarity IS the cosine score, so attach it as facetSimilarities
  // so the downstream classifier still has a per-facet score to gate on.
  if (facets.length === 1) {
    const result = await searchLocalCorpus(originalQuery, { limit, threshold });
    const label = facets[0].label;
    perFacetCounts[label] = result.papers.length;
    const papers = result.papers.map((p) => ({
      ...p,
      facetSimilarities: { [label]: Number(p.similarity ?? 0) },
      surfacedFromFacets: [label],
    }));
    return { ...result, papers, perFacetCounts };
  }

  const embeddingClient = createEmbeddingClient();
  if (!embeddingClient) {
    return { papers: [], searchTimeMs: 0, vectorCount: 0, ftsCount: 0, perFacetCounts };
  }

  // Embed all facets in parallel.
  const embeds = await Promise.all(
    facets.map(async (f) => {
      try {
        const v = await embeddingClient.embedText(f.text, "query");
        return v ?? null;
      } catch (err) {
        console.error(`[corpus-multi] embed error for ${f.label}:`, (err as Error).message);
        return null;
      }
    }),
  );

  // Per-facet vector+FTS search in parallel.
  const perFacetResults = await Promise.all(
    facets.map(async (f, i) => {
      const v = embeds[i];
      if (!v) return [] as Paper[];
      try {
        const { data, error } = await adminClient.rpc(
          rpcName(),
          rpcParams(v, f.text, threshold, perFacetLimit, preFilters),
        );
        if (error) {
          console.error(`[corpus-multi] match_works ${f.label} error:`, error.message);
          const vo = await vectorOnlySearch(v, threshold, perFacetLimit, Date.now(), f.text, preFilters);
          return vo.papers;
        }
        return (data ?? []).map(mapRow).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
      } catch (err) {
        console.error(`[corpus-multi] facet ${f.label} error:`, (err as Error).message);
        return [];
      }
    }),
  );

  // HyDE retrieval channel — runs in parallel-ish with facets (we already awaited
  // facet embeds; HyDE is a separate vector). NOT a facet — papers surfaced via
  // HyDE keep their per-facet similarity scores untouched (often 0 if they only
  // matched the synthetic abstract). The classifier sees the truth.
  let hydeResults: Paper[] = [];
  const hydeThreshold = hyde?.threshold ?? 0.40;
  const hydeLimit = hyde?.limit ?? 200;
  if (hyde?.text) {
    try {
      const hv = await embeddingClient.embedText(hyde.text, "query");
      if (hv) {
        const { data, error } = await adminClient.rpc(
          rpcName(),
          rpcParams(hv, hyde.text, hydeThreshold, hydeLimit, preFilters),
        );
        if (error) {
          console.error(`[corpus-multi] hyde match_works error:`, error.message);
          const vo = await vectorOnlySearch(hv, hydeThreshold, hydeLimit, Date.now(), hyde.text, preFilters);
          hydeResults = vo.papers;
        } else {
          hydeResults = (data ?? []).map(mapRow).filter((paper: Paper) => !isGenericNonPrimaryPaper(paper));
        }
        console.log(`[corpus-multi] hyde channel: ${hydeResults.length} papers (threshold=${hydeThreshold})`);
      }
    } catch (err) {
      console.error(`[corpus-multi] hyde channel error:`, (err as Error).message);
    }
  }

  // Union by paper id. For each paper, preserve per-facet similarity scores
  // (the classifier uses these for the Direct/Indirect relevance gate) and
  // also track which facets the paper surfaced from. Top-level `similarity`
  // is kept as the max across facets for backward-compatible ranking.
  const merged = new Map<string, Paper>();
  for (let i = 0; i < perFacetResults.length; i++) {
    const facetLabel = facets[i].label;
    perFacetCounts[facetLabel] = perFacetResults[i].length;
    for (const p of perFacetResults[i]) {
      const id = p.id;
      if (!id) continue;
      const existing = merged.get(id);
      const surfacedFrom = existing?.surfacedFromFacets ?? [];
      if (!surfacedFrom.includes(facetLabel)) surfacedFrom.push(facetLabel);
      const facetSimilarities: Record<string, number> = {
        ...(existing?.facetSimilarities ?? {}),
      };
      const thisSim = Number(p.similarity ?? 0);
      // Per-facet sim: max if the paper somehow appears twice for the same facet.
      facetSimilarities[facetLabel] = Math.max(
        facetSimilarities[facetLabel] ?? 0,
        thisSim,
      );
      const sim = Math.max(thisSim, existing?.similarity ?? 0);
      const fts = Math.max(p.ftsRank ?? 0, existing?.ftsRank ?? 0);
      merged.set(id, {
        ...(existing ?? p),
        ...p,
        similarity: sim,
        ftsRank: fts,
        surfacedFromFacets: surfacedFrom,
        facetSimilarities,
      });
    }
  }

  // Union HyDE results into the same map. HyDE papers DO NOT modify
  // facetSimilarities — they remain whatever the per-facet pass produced (often
  // 0 for HyDE-only hits). Tag with surfacedFromHyde + hydeSimilarity so the
  // downstream classifier and rerank can reason about the channel separately.
  let hydeOverlapCount = 0;
  for (const p of hydeResults) {
    const id = p.id;
    if (!id) continue;
    const existing = merged.get(id);
    const hydeSim = Number(p.similarity ?? 0);
    if (existing) {
      // Paper hit both a real facet AND HyDE — record HyDE sim, keep facet sims.
      hydeOverlapCount++;
      merged.set(id, {
        ...existing,
        surfacedFromHyde: true,
        hydeSimilarity: hydeSim,
        // Top-level similarity tracks max signal for backward-compat ranking.
        similarity: Math.max(existing.similarity ?? 0, hydeSim),
      });
    } else {
      // HyDE-only paper — facetSimilarities will be empty, classifier will see 0
      // on every facet. That's the truth: this paper matched the synthetic
      // abstract but not any individual facet vector. Phase 3 (per-facet sim
      // computation) will fill these in if Phase 2 measurements indicate the
      // classifier is dropping HyDE-only hits.
      merged.set(id, {
        ...p,
        surfacedFromHyde: true,
        hydeSimilarity: hydeSim,
        surfacedFromFacets: [],
        facetSimilarities: {},
      });
    }
  }

  // Phase 3: Compute REAL per-facet similarities for HyDE-only papers.
  //
  // Without this, HyDE-only papers have facetSimilarities all 0 → fail the
  // classifier's per-facet floor (>= 0.50) → marked "excluded" → filtered out
  // before candidate_work_ids persists. Net effect: HyDE retrieves the right
  // canon papers (Bhalotra, Aizer, Anderberg at sim ~0.80) but the classifier
  // silently drops them because their FACET vectors weren't measured.
  //
  // Fix: fetch each HyDE-only paper's stored embedding, compute cosine vs each
  // facet vector we already have in `embeds[]`. This is the truth — what the
  // per-facet vectors WOULD have returned if their `match_count*2` cap weren't
  // squeezing canon out of dense neighborhoods. Cost: one extra DB query for
  // up to ~200 papers, ~10-30ms.
  const hydeOnlyIds = Array.from(merged.values())
    .filter((p) => p.surfacedFromHyde && (!p.surfacedFromFacets || p.surfacedFromFacets.length === 0))
    .map((p) => p.id);
  if (hydeOnlyIds.length > 0 && embeds.some((e) => !!e)) {
    try {
      const { data: embRows, error: embErr } = await adminClient
        .from("works")
        .select("id, embedding")
        .in("id", hydeOnlyIds);
      if (embErr) {
        console.error(`[corpus-multi] hyde-only embedding fetch error:`, embErr.message);
      } else if (embRows && embRows.length > 0) {
        let backfilled = 0;
        for (const row of embRows) {
          const paper = merged.get(row.id);
          if (!paper || !row.embedding) continue;
          const paperVec = parsePgvectorEmbedding(row.embedding);
          if (!paperVec) continue;
          const sims = paper.facetSimilarities as Record<string, number>;
          for (let i = 0; i < facets.length; i++) {
            const facetVec = embeds[i];
            if (!facetVec) continue;
            sims[facets[i].label] = cosineSimilarity(paperVec, facetVec);
          }
          backfilled++;
        }
        console.log(`[corpus-multi] hyde phase-3: backfilled per-facet sims for ${backfilled}/${hydeOnlyIds.length} hyde-only papers`);
      }
    } catch (err) {
      console.error(`[corpus-multi] hyde phase-3 error:`, (err as Error).message);
    }
  }

  // Backfill: any paper that surfaced from facet A but not facet B has
  // facetSimilarities[B] = 0 (it didn't clear retrieval threshold for B).
  // The classifier needs this to reason about "didn't appear" vs "missing key".
  // Phase-3 above filled real values for HyDE-only papers; this catches anything
  // still missing (e.g., HyDE-only paper without an embedding row).
  for (const paper of merged.values()) {
    const sims = paper.facetSimilarities as Record<string, number>;
    for (const f of facets) {
      if (sims[f.label] === undefined) sims[f.label] = 0;
    }
  }

  // Rank: channels-hit desc → facet-GM desc → fts rank desc.
  //
  // Secondary sort is now geometric mean of per-facet similarities (conjunction
  // ranking) instead of max similarity (disjunction ranking).
  //
  // Why: max-similarity sort promotes papers that are brilliant on ONE facet
  // but irrelevant to the others — e.g., a strong AI paper that says nothing
  // about labor surfaces above a solid AI+labor paper whose per-facet scores
  // are individually lower but balanced. GM penalises single-axis stars.
  //
  // For single-facet queries: GM = that one score = same as max. No regression.
  // For HyDE-only papers: facetSimilarities are real values (phase-3 backfilled)
  // so GM reflects actual per-facet proximity, not a proxy.
  //
  // Clamp floor at 0.01 before log to avoid log(0). Papers with no facet sims
  // fall back to top-level similarity (HyDE-only with empty facet map).
  const facetGM = (p: Paper): number => {
    const sims = Object.values(p.facetSimilarities ?? {}) as number[];
    if (sims.length === 0) return p.similarity ?? 0;
    const logSum = sims.reduce((s, v) => s + Math.log(Math.max(v, 0.01)), 0);
    return Math.exp(logSum / sims.length);
  };
  const channelsHit = (p: Paper): number =>
    (p.surfacedFromFacets?.length ?? 0) + (p.surfacedFromHyde ? 1 : 0);
  const all = Array.from(merged.values()).sort((a, b) => {
    const channelDiff = channelsHit(b) - channelsHit(a);
    if (channelDiff !== 0) return channelDiff;
    const gmDiff = facetGM(b) - facetGM(a);
    if (Math.abs(gmDiff) > 1e-6) return gmDiff;
    return (b.ftsRank ?? 0) - (a.ftsRank ?? 0);
  });

  const papers = all.slice(0, limit);
  const hydeCount = hydeResults.length;
  const hydeOnlyInPapers = papers.filter((p) => p.surfacedFromHyde && (!p.surfacedFromFacets || p.surfacedFromFacets.length === 0)).length;
  const elapsed = Date.now() - start;
  console.log(
    `[corpus-multi] ${facets.length} facets${hyde?.text ? " + hyde" : ""} → ${papers.length} unique papers in ${elapsed}ms ` +
      `(per-facet: ${facets.map((f) => `${f.label}=${perFacetCounts[f.label] ?? 0}`).join(", ")}` +
      `${hyde?.text ? `; hyde=${hydeCount}, hyde-only=${hydeOnlyInPapers}, hyde∩facets=${hydeOverlapCount}` : ""})`,
  );

  // Expose the per-facet embeddings so downstream code (retrieval.ts +
  // attachFacetSimilarities) can compute cosine(paper, facet) for EVERY
  // candidate paper post-retrieval, not just ones that cleared the per-facet
  // threshold. Fixes the "missing facet sim reads as 0" bug.
  const facetEmbeddings: Record<string, number[] | null> = {};
  for (let i = 0; i < facets.length; i++) {
    facetEmbeddings[facets[i].label] = embeds[i] ?? null;
  }

  return {
    papers,
    searchTimeMs: elapsed,
    vectorCount: papers.filter((p) => (p.similarity ?? 0) > 0).length,
    ftsCount: papers.filter((p) => (p.ftsRank ?? 0) > 0).length,
    perFacetCounts,
    hydeCount,
    hydeOverlapCount,
    facetEmbeddings,
  };
}

// ---------------------------------------------------------------------------
// Helpers for Phase-3 HyDE-only per-facet similarity backfill.
// ---------------------------------------------------------------------------

/**
 * Parse a pgvector embedding cell into a number array. pgvector stores vectors
 * as text like "[0.1,0.2,...]" but the supabase-js client returns them as
 * either an array (when the column type is decoded) or a string (when raw).
 */
function parsePgvectorEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Cosine similarity over equal-length numeric vectors. Returns 0 on shape mismatch. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// Re-export buildEmbeddingText for callers that need it
export { buildEmbeddingText } from "./embeddingClient.ts";

// ---------------------------------------------------------------------------
// cosineForIds — real query·paper cosine for an explicit id set
// ---------------------------------------------------------------------------

/**
 * Real query·paper cosine for an explicit id set (pgvector). Used by the unified
 * reranker to score channel-surfaced papers that arrived with a synthetic
 * placeholder similarity (0.45/0.55 for foundational-SQL / topic-geo channels).
 * Returns a Map id→cosine; ids with null embedding are absent from the map.
 *
 * Convention: passes queryEmbedding as a raw number[] (same as match_works /
 * match_works_v2 in rpcParams above — supabase-js auto-serialises the array
 * to the pgvector wire format; no bracket-string conversion needed).
 */
export async function cosineForIds(
  // deno-lint-ignore no-explicit-any
  client: any,
  queryEmbedding: number[],
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length || !queryEmbedding?.length) return out;
  // Pass the embedding array directly — matches the existing match_works convention
  // (rpcParams: `query_embedding: embedding` where embedding is number[]).
  const vec = queryEmbedding;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await client.rpc("cosine_for_ids", { p_query: vec, p_ids: slice });
    if (error) { console.error("[cosineForIds]", error.message); continue; }
    for (const r of data ?? []) out.set(String(r.id), Number(r.cosine));
  }
  return out;
}
