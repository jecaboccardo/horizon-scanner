/**
 * supabase/functions/_shared/ssRecommender.ts
 *
 * Semantic Scholar Recommendations API — "find papers similar to these."
 *
 * Different signal from citation crawling: recommendations find conceptually
 * related work that may NOT cite each other. Citation crawling follows explicit
 * links; recommendations use SS's learned paper similarity.
 *
 * Endpoint: POST https://api.semanticscholar.org/recommendations/v1/papers/
 */

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

export interface RecommendResult {
  papers: Paper[];
  seedCount: number;
  timeMs: number;
}

const SS_RECOMMEND_URL = "https://api.semanticscholar.org/recommendations/v1/papers/";
const FIELDS = "title,year,abstract,citationCount,externalIds,authors,publicationDate,isOpenAccess,openAccessPdf,fieldsOfStudy,venue,journal";

/**
 * Get paper recommendations based on seed papers.
 *
 * @param seedPapers - Papers to base recommendations on (uses top 5 by citations)
 * @param existingIds - IDs already in results (skip these)
 * @param limit - Max recommendations to return
 */
export async function searchSimilarPapers(
  seedPapers: Paper[],
  existingIds: Set<string>,
  { limit = 30 } = {},
): Promise<RecommendResult> {
  const start = Date.now();
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;

  if (!apiKey) {
    return { papers: [], seedCount: 0, timeMs: 0 };
  }

  // Pick seeds: need SS paper IDs (not DOIs for this endpoint)
  const seeds = seedPapers
    .map((p) => extractSsIdForRecommend(p))
    .filter((id): id is string => id !== null)
    .slice(0, 5);

  if (seeds.length < 2) {
    // Recommendations need at least 2 seed papers to be useful
    return { papers: [], seedCount: seeds.length, timeMs: Date.now() - start };
  }

  try {
    const response = await fetch(`${SS_RECOMMEND_URL}?fields=${FIELDS}&limit=${limit}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        positivePaperIds: seeds,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[ss-recommend] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { papers: [], seedCount: seeds.length, timeMs: Date.now() - start };
    }

    const data = await response.json();
    const recommended = (data.recommendedPapers ?? []) as Paper[];

    const papers: Paper[] = [];
    for (const raw of recommended) {
      const mapped = mapPaper(raw);
      if (!mapped.id) continue;
      if (existingIds.has(mapped.id)) continue;
      // Only keep papers with some citations (filter noise)
      if ((mapped.citationCount ?? 0) < 2) continue;
      papers.push(mapped);
    }

    const elapsed = Date.now() - start;
    console.log(`[ss-recommend] ${papers.length} recommendations from ${seeds.length} seeds (${elapsed}ms)`);

    return { papers, seedCount: seeds.length, timeMs: elapsed };
  } catch (err) {
    console.error("[ss-recommend] Error:", (err as Error).message);
    return { papers: [], seedCount: seeds.length, timeMs: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

/**
 * Extract a Semantic Scholar paper ID usable with the recommendations API.
 * The API accepts: SS paper IDs, DOI:xxxx, ArXiv:xxxx, CorpusId:xxxx
 */
function extractSsIdForRecommend(paper: Paper): string | null {
  const id = paper.id ?? "";
  // Direct SS ID
  if (typeof id === "string" && id.startsWith("ss:")) {
    return id.slice(3);
  }
  // DOI-based (recommendations API accepts DOI: prefix)
  const doi = paper.doi ?? paper.canonical_doi ?? paper.canonicalDoi;
  if (doi) return `DOI:${doi}`;
  return null;
}

function mapPaper(raw: Paper): Paper {
  const externalIds = (raw.externalIds ?? {}) as Record<string, string>;
  const authors = (raw.authors ?? []) as Array<{ name?: string }>;
  const openAccessPdf = (raw.openAccessPdf ?? {}) as Record<string, string>;
  const journal = (raw.journal ?? {}) as Record<string, string>;
  const doi = normalizeDoi(externalIds?.DOI ?? null);
  const paperId = raw.paperId ?? null;

  return {
    id: doi ?? (paperId ? `ss:${paperId}` : null),
    title: raw.title ?? null,
    year: raw.year ?? null,
    abstract: raw.abstract ?? null,
    citationCount: raw.citationCount ?? null,
    doi,
    authors: Array.isArray(authors) ? authors.map((a) => a.name).filter(Boolean) : [],
    publicationDate: raw.publicationDate ?? null,
    isOpenAccess: raw.isOpenAccess ?? false,
    openAccessPdfUrl: openAccessPdf?.url ?? null,
    fieldsOfStudy: raw.fieldsOfStudy ?? [],
    venue: raw.venue || journal?.name || null,
    journalIssn: journal?.issn ?? null,
    source: "ss_recommend",
    url: paperId ? `https://www.semanticscholar.org/paper/${paperId}` : (doi ? `https://doi.org/${doi}` : null),
  };
}
