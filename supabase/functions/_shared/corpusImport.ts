/**
 * supabase/functions/_shared/corpusImport.ts
 *
 * Phase 12: Batch import from OpenAlex + Semantic Scholar into the local corpus.
 *
 * Tiered import strategy (Jess-approved):
 *   Tier 1 (30%): Last 2 years, any citations (1+) — fresh evidence
 *   Tier 2 (30%): 3-5 years ago, 10+ citations — recent proven
 *   Tier 3 (25%): 6-10 years ago, 25+ citations — established
 *   Tier 4 (15%): 10+ years ago, 50+ citations — landmarks
 *
 * Concepts: economics, development, public policy, social programs (global, not LAC-only).
 * Sources: OpenAlex primary, Semantic Scholar secondary. Dedup by DOI.
 */

import { createEmbeddingClient, buildEmbeddingText } from "./embeddingClient.ts";
import { classifyPaper } from "./smsClassifier.ts";
import { lookupJournalRankings } from "./journalRankings.ts";
import { adminClient } from "./supabase.ts";
import { filterDeniedVenuePapers } from "./venueDenylist.ts";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportTier {
  name: string;
  yearStart: number;
  yearEnd: number;
  minCitations: number;
  targetPapers: number;
}

export interface ImportOptions {
  tiers?: ImportTier[];
  dryRun?: boolean;
  limit?: number;        // hard cap across all tiers
  batchSize?: number;    // papers per OpenAlex page (max 200)
  source?: "openalex" | "semantic_scholar" | "both";
}

export interface ImportStats {
  imported: number;
  skipped: number;
  blockedVenues: number;
  errors: number;
  byTier: Record<string, number>;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Default tiers — budget: ~35K papers total
// ---------------------------------------------------------------------------

const currentYear = new Date().getFullYear();

export const DEFAULT_TIERS: ImportTier[] = [
  { name: "fresh",       yearStart: currentYear - 2, yearEnd: currentYear, minCitations: 1,  targetPapers: 12_000 },
  { name: "recent",      yearStart: currentYear - 5, yearEnd: currentYear - 3, minCitations: 10, targetPapers: 10_000 },
  { name: "established", yearStart: currentYear - 10, yearEnd: currentYear - 6, minCitations: 25, targetPapers: 8_000 },
  { name: "landmarks",   yearStart: 1990,            yearEnd: currentYear - 11, minCitations: 50, targetPapers: 5_000 },
];

// OpenAlex concept IDs — OR syntax: pipe-separate IDs within a single filter field
const OA_CONCEPT_FILTER = "concepts.id:C162324750|C17744445|C144133560|C199539241|C41008148";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";

function getOAAuthParams(): URLSearchParams {
  const apiKey = process.env.OPENALEX_API_KEY;
  const email = process.env.OPENALEX_EMAIL || "horizon-scanner@iadb.org";
  const params = new URLSearchParams();
  if (apiKey) params.set("api_key", apiKey);
  else params.set("mailto", email);
  return params;
}

// ---------------------------------------------------------------------------
// OpenAlex batch fetcher
// ---------------------------------------------------------------------------

async function fetchOpenAlexTier(
  tier: ImportTier,
  opts: { batchSize: number; existingDois: Set<string> },
): Promise<Paper[]> {
  const params = getOAAuthParams();
  params.set("filter", [
    `from_publication_date:${tier.yearStart}-01-01`,
    `to_publication_date:${tier.yearEnd}-12-31`,
    "type:article",
    "has_doi:true",
    "has_abstract:true",
    `cited_by_count:>${tier.minCitations - 1}`,
    OA_CONCEPT_FILTER,
  ].join(","));
  params.set("sort", "cited_by_count:desc");
  params.set("per_page", String(opts.batchSize));

  const papers: Paper[] = [];
  let cursor = "*";
  let page = 0;

  while (papers.length < tier.targetPapers) {
    params.set("cursor", cursor);
    const url = `${OPENALEX_WORKS_URL}?${params.toString()}`;
    console.log(`[corpus:oa] ${tier.name} page ${page + 1}, have ${papers.length}/${tier.targetPapers}`);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        console.error(`[corpus:oa] HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const results: Paper[] = data.results ?? [];
      if (results.length === 0) break;

      for (const raw of results) {
        if (papers.length >= tier.targetPapers) break;
        const mapped = mapOpenAlexWork(raw);
        if (!mapped.id || !mapped.title) continue;

        // Skip if we already have this DOI
        const doi = normalizeDoi(mapped.doi);
        if (doi && opts.existingDois.has(doi)) continue;
        if (doi) opts.existingDois.add(doi);

        papers.push(mapped);
      }

      cursor = data.meta?.next_cursor;
      if (!cursor) break;
      page++;

      // Polite rate limiting
      await sleep(200);
    } catch (err) {
      console.error(`[corpus:oa] Fetch error: ${(err as Error).message}`);
      break;
    }
  }

  console.log(`[corpus:oa] ${tier.name}: fetched ${papers.length} papers`);
  return papers;
}

// ---------------------------------------------------------------------------
// Semantic Scholar batch fetcher
// ---------------------------------------------------------------------------

const SS_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const SS_FIELDS = "paperId,title,abstract,year,citationCount,authors,publicationDate,isOpenAccess,openAccessPdf,externalIds,venue,journal";

const SS_QUERIES = [
  "development economics",
  "conditional cash transfers",
  "impact evaluation developing countries",
  "public policy economics",
  "social protection programs",
  "labor market developing countries",
  "education economics LAC",
  "health economics developing countries",
  "fiscal policy Latin America",
  "poverty reduction",
  "inequality economics",
  "microfinance impact",
  "infrastructure development economics",
  "climate adaptation developing countries",
  "trade policy developing countries",
];

async function fetchSemanticScholarTier(
  tier: ImportTier,
  opts: { existingDois: Set<string>; limitPerQuery: number },
): Promise<Paper[]> {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const papers: Paper[] = [];

  for (const query of SS_QUERIES) {
    if (papers.length >= tier.targetPapers) break;

    const params = new URLSearchParams({
      query,
      fields: SS_FIELDS,
      limit: String(opts.limitPerQuery),
      year: `${tier.yearStart}-${tier.yearEnd}`,
      minCitationCount: String(tier.minCitations),
    });

    const url = `${SS_SEARCH_URL}?${params.toString()}`;

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.warn("[corpus:ss] Rate limited, pausing 5s");
          await sleep(5_000);
          continue;
        }
        console.error(`[corpus:ss] HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const results: Paper[] = data.data ?? [];

      for (const raw of results) {
        if (papers.length >= tier.targetPapers) break;
        const mapped = mapSemanticScholarWork(raw);
        if (!mapped.id || !mapped.title) continue;

        const doi = normalizeDoi(mapped.doi);
        if (doi && opts.existingDois.has(doi)) continue;
        if (doi) opts.existingDois.add(doi);

        papers.push(mapped);
      }

      // SS rate limit: ~1 req/sec without key, 10 req/sec with key
      await sleep(apiKey ? 200 : 1_100);
    } catch (err) {
      console.error(`[corpus:ss] Error for "${query}": ${(err as Error).message}`);
    }
  }

  console.log(`[corpus:ss] ${tier.name}: fetched ${papers.length} papers`);
  return papers;
}

// ---------------------------------------------------------------------------
// Main import orchestrator
// ---------------------------------------------------------------------------

export async function importCorpus(options: ImportOptions = {}): Promise<ImportStats> {
  const start = Date.now();
  const tiers = options.tiers ?? DEFAULT_TIERS;
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? Infinity;
  const batchSize = Math.min(options.batchSize ?? 200, 200);
  const source = options.source ?? "both";

  const stats: ImportStats = { imported: 0, skipped: 0, blockedVenues: 0, errors: 0, byTier: {}, elapsedMs: 0 };
  const existingDois = new Set<string>();

  // Load existing DOIs to avoid re-importing
  const { data: existingRows } = await adminClient
    .from("works")
    .select("canonical_doi")
    .not("canonical_doi", "is", null);
  if (existingRows) {
    for (const row of existingRows) {
      const doi = normalizeDoi(row.canonical_doi);
      if (doi) existingDois.add(doi);
    }
  }
  console.log(`[corpus] ${existingDois.size} existing DOIs in works table`);

  const embeddingClient = createEmbeddingClient();
  if (!embeddingClient && !dryRun) {
    console.error("[corpus] No embedding client — cannot import without GEMINI_API_KEY");
    stats.elapsedMs = Date.now() - start;
    return stats;
  }

  for (const tier of tiers) {
    if (stats.imported >= limit) break;
    console.log(`\n[corpus] === Tier: ${tier.name} (${tier.yearStart}-${tier.yearEnd}, ${tier.minCitations}+ citations) ===`);

    let papers: Paper[] = [];

    // Fetch from OpenAlex
    if (source === "openalex" || source === "both") {
      const oaPapers = await fetchOpenAlexTier(tier, { batchSize, existingDois });
      papers.push(...oaPapers);
    }

    // Fetch from Semantic Scholar
    if (source === "semantic_scholar" || source === "both") {
      const ssPapers = await fetchSemanticScholarTier(tier, {
        existingDois,
        limitPerQuery: Math.min(100, Math.ceil(tier.targetPapers / SS_QUERIES.length)),
      });
      papers.push(...ssPapers);
    }

    // Apply hard cap
    const remaining = limit - stats.imported;
    if (papers.length > remaining) {
      papers = papers.slice(0, remaining);
    }

    const beforeDenylist = papers.length;
    papers = filterDeniedVenuePapers(papers);
    const blocked = beforeDenylist - papers.length;
    if (blocked > 0) {
      stats.blockedVenues += blocked;
      console.log(`[corpus] blocked ${blocked} denylisted venue paper(s) in tier ${tier.name}`);
    }

    if (dryRun) {
      console.log(`[corpus] DRY RUN — would import ${papers.length} papers for tier ${tier.name}`);
      stats.byTier[tier.name] = papers.length;
      stats.imported += papers.length;
      continue;
    }

    // Process in batches of 50 (embed + classify + upsert)
    const PROCESS_BATCH = 50;
    let tierImported = 0;

    for (let i = 0; i < papers.length; i += PROCESS_BATCH) {
      const batch = papers.slice(i, i + PROCESS_BATCH);

      // Generate embeddings
      const texts = batch.map((p) => buildEmbeddingText(p.title, p.abstract));
      const embeddings = embeddingClient ? await embeddingClient.embedBatch(texts) : [];

      // Build rows with classification + rankings + embeddings
      const rows: Paper[] = [];
      for (let j = 0; j < batch.length; j++) {
        const paper = batch[j];
        const embedding = embeddings[j] ?? null;
        if (!embedding) {
          stats.errors++;
          continue;
        }

        const sms = classifyPaper(paper);
        const jr = await lookupJournalRankings(paper.venue);

        rows.push({
          id: paper.id,
          title: paper.title,
          canonical_doi: paper.doi ?? null,
          year: paper.year ?? null,
          abstract: paper.abstract ?? null,
          citation_count: paper.citationCount ?? null,
          authors: paper.authors ?? [],
          publication_date: paper.publicationDate ?? null,
          is_open_access: paper.isOpenAccess ?? false,
          open_access_pdf_url: paper.openAccessPdfUrl ?? null,
          fields_of_study: paper.fieldsOfStudy ?? [],
          venue: paper.venue ?? null,
          journal_issn: paper.journalIssn ?? null,
          url: paper.url ?? null,
          source: paper.source ?? "corpus",
          sms_level: sms.smsLevel,
          methodology_design: sms.design,
          causal_strength: sms.causalStrength,
          sms_method: sms.smsMethod,
          sms_rationale: sms.rationale ?? null,
          abs_rating: jr.absRating,
          repec_rank: jr.repecRank,
          repec_percentile: jr.repecPercentile,
          embedding: `[${embedding.join(",")}]`,
          corpus_source: paper.source === "semantic_scholar" ? "semantic_scholar_bulk" : "openalex_bulk",
          corpus_imported_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      if (rows.length > 0) {
        const { error } = await adminClient
          .from("works")
          .upsert(rows, { onConflict: "id", ignoreDuplicates: false });

        if (error) {
          console.error(`[corpus] Upsert error: ${error.message}`);
          stats.errors += rows.length;
        } else {
          tierImported += rows.length;
        }
      }

      const progress = Math.min(i + PROCESS_BATCH, papers.length);
      console.log(`[corpus] ${tier.name}: ${progress}/${papers.length} processed, ${tierImported} imported`);
    }

    stats.byTier[tier.name] = tierImported;
    stats.imported += tierImported;
  }

  stats.elapsedMs = Date.now() - start;
  console.log(`\n[corpus] Import complete: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.blockedVenues} blocked venues, ${stats.errors} errors in ${(stats.elapsedMs / 1000).toFixed(1)}s`);
  return stats;
}

// ---------------------------------------------------------------------------
// Paper mapping helpers
// ---------------------------------------------------------------------------

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

function reconstructAbstract(inverted: Record<string, number[]> | null | undefined): string | null {
  if (!inverted || typeof inverted !== "object") return null;
  const positions: [number, string][] = [];
  for (const [word, posList] of Object.entries(inverted)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) {
      if (typeof p === "number") positions.push([p, word]);
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ").trim() || null;
}

function mapOpenAlexWork(raw: Paper): Paper {
  const doi = normalizeDoi(raw.doi);
  const shortId = raw.id?.match(/\/(W\d+)$/)?.[1];
  const loc = raw.primary_location ?? {};
  const src = loc.source ?? {};
  const oa = raw.open_access ?? {};
  const authors = (raw.authorships ?? [])
    .map((a: Paper) => a?.author?.display_name)
    .filter(Boolean);
  const concepts = (raw.concepts ?? [])
    .map((c: Paper) => c?.display_name)
    .filter(Boolean);

  return {
    id: doi ?? (shortId ? `oa:${shortId}` : null),
    title: raw.title ?? raw.display_name,
    year: raw.publication_year ?? null,
    abstract: reconstructAbstract(raw.abstract_inverted_index),
    citationCount: raw.cited_by_count ?? null,
    doi,
    authors,
    publicationDate: raw.publication_date ?? null,
    isOpenAccess: Boolean(oa.is_oa),
    openAccessPdfUrl: oa.oa_url ?? null,
    fieldsOfStudy: concepts,
    venue: src.display_name ?? null,
    journalIssn: src.issn_l ?? null,
    url: oa.oa_url ?? loc.landing_page_url ?? (doi ? `https://doi.org/${doi}` : null),
    source: "openalex",
  };
}

function mapSemanticScholarWork(raw: Paper): Paper {
  const doi = normalizeDoi(raw.externalIds?.DOI);
  const ssId = raw.paperId;
  const authors = (raw.authors ?? [])
    .map((a: Paper) => a?.name)
    .filter(Boolean);

  return {
    id: doi ?? (ssId ? `ss:${ssId}` : null),
    title: raw.title,
    year: raw.year ?? null,
    abstract: raw.abstract ?? null,
    citationCount: raw.citationCount ?? null,
    doi,
    authors,
    publicationDate: raw.publicationDate ?? null,
    isOpenAccess: raw.isOpenAccess ?? false,
    openAccessPdfUrl: raw.openAccessPdf?.url ?? null,
    fieldsOfStudy: [],
    venue: raw.venue ?? raw.journal?.name ?? null,
    journalIssn: null,
    url: doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${ssId}`,
    source: "semantic_scholar",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
