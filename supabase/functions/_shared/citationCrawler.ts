/**
 * supabase/functions/_shared/citationCrawler.ts
 *
 * Phase 2 of comprehensive retrieval: citation graph crawling.
 *
 * Given seed papers from initial retrieval, follows citation links
 * in both directions:
 *   - BACKWARD (references): "What does this paper cite?" → foundational work
 *   - FORWARD (citations): "Who cites this paper?" → replications, extensions
 *
 * Uses Semantic Scholar Graph API (citations + references endpoints).
 * One hop only — two hops would explode combinatorially.
 */

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawlResult {
  /** Papers discovered via citation graph (not in initial results) */
  papers: Paper[];
  /** Number of seed papers used */
  seedCount: number;
  /** Total references + citations examined */
  linksExamined: number;
  /** Time taken in ms */
  crawlTimeMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SS_GRAPH_URL = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS = "title,year,abstract,citationCount,externalIds,authors,publicationDate,isOpenAccess,openAccessPdf,fieldsOfStudy,venue,journal";

// How many seed papers to crawl from (top by citation count)
const MAX_SEEDS = 5;
// Max citations/references to fetch per paper per direction
const PER_DIRECTION_LIMIT = 20;
// Minimum citation count for a discovered paper to be worth including
const MIN_CITATIONS_DISCOVERED = 3;

// ---------------------------------------------------------------------------
// Main crawler
// ---------------------------------------------------------------------------

/**
 * Crawl citation graph from seed papers.
 *
 * @param seedPapers - Initial retrieval results (will pick top 5 by citations)
 * @param existingIds - Set of paper IDs already in results (to skip)
 */
export async function crawlCitations(
  seedPapers: Paper[],
  existingIds: Set<string>,
): Promise<CrawlResult> {
  const start = Date.now();
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;

  if (!apiKey) {
    console.log("[citation-crawl] No SS API key — skipping");
    return { papers: [], seedCount: 0, linksExamined: 0, crawlTimeMs: 0 };
  }

  // Pick top seeds: highest citation count, must have a Semantic Scholar ID
  const seeds = seedPapers
    .filter((p) => extractSsId(p) !== null)
    .sort((a, b) => (b.citationCount ?? b.citation_count ?? 0) - (a.citationCount ?? a.citation_count ?? 0))
    .slice(0, MAX_SEEDS);

  if (seeds.length === 0) {
    return { papers: [], seedCount: 0, linksExamined: 0, crawlTimeMs: Date.now() - start };
  }

  console.log(`[citation-crawl] Crawling ${seeds.length} seed papers`);

  // Crawl all seeds in parallel (both directions per seed)
  const crawlPromises = seeds.flatMap((seed) => {
    const ssId = extractSsId(seed)!;
    return [
      fetchCitationDirection(ssId, "citations", apiKey),
      fetchCitationDirection(ssId, "references", apiKey),
    ];
  });

  const results = await Promise.allSettled(crawlPromises);

  // Collect and deduplicate discovered papers
  const discovered = new Map<string, Paper>();
  let linksExamined = 0;

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const paper of result.value) {
      linksExamined++;
      if (!paper.id) continue;
      // Skip papers we already have
      if (existingIds.has(paper.id)) continue;
      // Skip low-citation discovered papers (noise reduction)
      if ((paper.citationCount ?? 0) < MIN_CITATIONS_DISCOVERED) continue;
      // Keep the version with higher citation count if duplicate
      const existing = discovered.get(paper.id);
      if (!existing || (paper.citationCount ?? 0) > (existing.citationCount ?? 0)) {
        discovered.set(paper.id, paper);
      }
    }
  }

  // Sort by citation count descending
  const papers = [...discovered.values()]
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));

  const elapsed = Date.now() - start;
  console.log(`[citation-crawl] Found ${papers.length} new papers from ${linksExamined} links in ${elapsed}ms`);

  return {
    papers,
    seedCount: seeds.length,
    linksExamined,
    crawlTimeMs: elapsed,
  };
}

// ---------------------------------------------------------------------------
// Fetch one direction (citations or references) for one paper
// ---------------------------------------------------------------------------

async function fetchCitationDirection(
  ssId: string,
  direction: "citations" | "references",
  apiKey: string,
): Promise<Paper[]> {
  const url = `${SS_GRAPH_URL}/${ssId}/${direction}?fields=${FIELDS}&limit=${PER_DIRECTION_LIMIT}`;

  try {
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`[citation-crawl] Rate limited on ${direction} for ${ssId}`);
      } else {
        console.error(`[citation-crawl] HTTP ${response.status} on ${direction} for ${ssId}`);
      }
      return [];
    }

    const data = await response.json();
    const items = (data.data ?? []) as Array<{ citingPaper?: Paper; citedPaper?: Paper }>;

    return items
      .map((item) => {
        const raw = direction === "citations" ? item.citingPaper : item.citedPaper;
        if (!raw) return null;
        return mapSsPaper(raw);
      })
      .filter((p): p is Paper => p !== null && p.id !== null);
  } catch (err) {
    console.error(`[citation-crawl] Error ${direction} for ${ssId}: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

/** Extract Semantic Scholar paper ID from various paper ID formats */
function extractSsId(paper: Paper): string | null {
  // Direct SS ID (from ss:XXXX format)
  const id = paper.id ?? "";
  if (typeof id === "string" && id.startsWith("ss:")) {
    return id.slice(3);
  }
  // DOI-based lookup (SS accepts DOI as paper identifier)
  const doi = paper.doi ?? paper.canonical_doi ?? paper.canonicalDoi;
  if (doi) return `DOI:${doi}`;
  // OpenAlex or other — can't use for SS citation crawl
  return null;
}

function mapSsPaper(raw: Paper): Paper | null {
  const externalIds = (raw.externalIds ?? {}) as Record<string, string>;
  const authors = (raw.authors ?? []) as Array<{ name: string }>;
  const openAccessPdf = (raw.openAccessPdf ?? {}) as Record<string, string>;
  const journal = (raw.journal ?? {}) as Record<string, string>;
  const doi = normalizeDoi(externalIds?.DOI ?? null);
  const paperId = raw.paperId ?? null;

  if (!doi && !paperId) return null;

  return {
    id: doi ?? (paperId ? `ss:${paperId}` : null),
    title: raw.title ?? null,
    year: raw.year ?? null,
    abstract: raw.abstract ?? null,
    citationCount: raw.citationCount ?? null,
    doi,
    authors: Array.isArray(authors) ? authors.map((a: Paper) => a.name).filter(Boolean) : [],
    publicationDate: raw.publicationDate ?? null,
    isOpenAccess: raw.isOpenAccess ?? false,
    openAccessPdfUrl: openAccessPdf?.url ?? null,
    fieldsOfStudy: raw.fieldsOfStudy ?? [],
    venue: raw.venue || journal?.name || null,
    journalIssn: journal?.issn ?? null,
    source: "citation_graph",
    url: paperId ? `https://www.semanticscholar.org/paper/${paperId}` : (doi ? `https://doi.org/${doi}` : null),
  };
}
