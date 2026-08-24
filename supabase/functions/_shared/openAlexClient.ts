const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const POLITE_EMAIL_FALLBACK = "horizon-scanner@iadb.org";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

function getAuthParams(): URLSearchParams {
  const apiKey = process.env.OPENALEX_API_KEY;
  const email = process.env.OPENALEX_EMAIL || POLITE_EMAIL_FALLBACK;
  const params = new URLSearchParams();
  if (apiKey) params.set("api_key", apiKey);
  else params.set("mailto", email);
  return params;
}

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

/**
 * OpenAlex stores abstracts as an inverted index for copyright reasons:
 *   { "the": [0, 5, 12], "cat": [1], ... }
 * Reconstruct by placing each word at each of its positions and joining.
 */
function reconstructAbstract(
  inverted: Record<string, number[]> | null | undefined,
): string | null {
  if (!inverted || typeof inverted !== "object") return null;
  const positions: Array<[number, string]> = [];
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

/**
 * Extract the OpenAlex short ID (e.g. "W4285086367") from the full IRI.
 */
function extractOpenAlexShortId(iri: string | null | undefined): string | null {
  if (!iri) return null;
  const match = /\/(W\d+)$/.exec(String(iri));
  return match ? match[1] : null;
}

function mapWork(raw: Paper): Paper {
  const doi = normalizeDoi(raw.doi);
  const shortId = extractOpenAlexShortId(raw.id);
  const primaryLocation = (raw.primary_location ?? null) as Paper | null;
  const source = (primaryLocation?.source ?? null) as Paper | null;
  const openAccess = (raw.open_access ?? {}) as Paper;
  const authors: string[] = Array.isArray(raw.authorships)
    ? raw.authorships
        .map((a: Paper) => a?.author?.display_name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
    : [];
  const concepts: string[] = Array.isArray(raw.concepts)
    ? raw.concepts
        .map((c: Paper) => c?.display_name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0)
    : [];

  // Prefer OA URL, fall back to landing page, then DOI link
  const url: string | null =
    openAccess.oa_url ??
    primaryLocation?.landing_page_url ??
    (doi ? `https://doi.org/${doi}` : null) ??
    raw.id ??
    null;

  return {
    id: doi ?? (shortId ? `oa:${shortId}` : null),
    title: raw.title ?? raw.display_name ?? null,
    year: raw.publication_year ?? null,
    abstract: reconstructAbstract(raw.abstract_inverted_index),
    citationCount: raw.cited_by_count ?? null,
    doi,
    authors,
    publicationDate: raw.publication_date ?? null,
    isOpenAccess: Boolean(openAccess.is_oa),
    openAccessPdfUrl: openAccess.oa_url ?? null,
    fieldsOfStudy: concepts,
    venue: source?.display_name ?? null,
    journalIssn: source?.issn_l ?? null,
    url,
    source: "openalex",
  };
}

export interface OpenAlexSearchResult {
  papers: Paper[];
  count: number;
  dbResponseTimeMs: number;
}

/**
 * Fetch works matching `query` from OpenAlex, plus the total universe count.
 * Keyless via the polite pool (requires OPENALEX_EMAIL or a fallback).
 */
export async function searchOpenAlex(
  query: string,
  { limit = 15, yearStart = 2015 } = {},
): Promise<OpenAlexSearchResult> {
  const params = getAuthParams();
  params.set("search", query);
  // Push quality filters upstream: only peer-reviewed journal articles with DOIs
  // and at least some citations — these are far more likely to pass SMS/ABS/RePEC
  params.set("filter", [
    `from_publication_date:${yearStart}-01-01`,
    "type:article",          // journal articles only (not datasets, preprints, etc.)
    "has_doi:true",          // DOI-bearing → dedup works, more findable
    "cited_by_count:>5",     // skip uncited/barely-cited papers
  ].join(","));
  // Sort by RELEVANCE not citation count. The earlier "cited_by_count:desc"
  // setting was returning the most-cited papers globally that contained any
  // search-token (cancer reviews, GBD studies, battery papers) regardless of
  // whether they matched the topic. The cited_by_count:>5 filter above still
  // enforces a minimum quality floor.
  params.set("sort", "relevance_score:desc");
  params.set("per_page", String(Math.min(Math.max(limit, 1), 200)));

  const url = `${OPENALEX_WORKS_URL}?${params.toString()}`;
  console.log(`[openAlex] Searching: ${url.slice(0, 140)}...`);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[openAlex] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { papers: [], count: 0, dbResponseTimeMs: 0 };
    }

    const data = await response.json();
    const results: Paper[] = Array.isArray(data.results) ? data.results : [];
    const papers = results
      .map(mapWork)
      .filter((p: Paper) => p.id && p.title);
    const count = data.meta?.count ?? 0;

    console.log(`[openAlex] Retrieved ${papers.length} papers, universe count: ${count}`);
    return {
      papers,
      count,
      dbResponseTimeMs: data.meta?.db_response_time_ms ?? 0,
    };
  } catch (err) {
    console.error("[openAlex] Fetch error:", (err as Error).message);
    return { papers: [], count: 0, dbResponseTimeMs: 0 };
  }
}

/**
 * Kept for backwards compatibility — now delegates to searchOpenAlex with per_page=1
 * to minimize payload when only the universe count is needed.
 */
export async function getUniverseCount(query: string, { yearStart = 2015 } = {}) {
  const { count, dbResponseTimeMs } = await searchOpenAlex(query, { limit: 1, yearStart });
  return { count, dbResponseTimeMs };
}
