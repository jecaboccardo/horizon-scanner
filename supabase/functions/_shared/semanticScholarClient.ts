// Use the regular search endpoint (not bulk) — it respects `limit` and `offset`.
// Bulk returns up to 1000 papers per page, causing timeouts on broad queries.
const SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

const FIELDS = [
  "title", "year", "abstract", "citationCount", "externalIds", "authors",
  "publicationDate", "isOpenAccess", "openAccessPdf", "fieldsOfStudy", "venue", "journal",
].join(",");

function normalizeDoi(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
}

function mapPaper(raw: Record<string, unknown>): Record<string, unknown> {
  const externalIds = (raw.externalIds ?? {}) as Record<string, string>;
  const authors = (raw.authors ?? []) as Array<{ name: string }>;
  const openAccessPdf = (raw.openAccessPdf ?? {}) as Record<string, string>;
  const journal = (raw.journal ?? {}) as Record<string, string>;
  const doi = normalizeDoi(externalIds.DOI ?? null);
  const paperId = (raw.paperId as string | null) ?? null;
  return {
    id: doi ?? (paperId ? `ss:${paperId}` : null),
    title: raw.title ?? null,
    year: raw.year ?? null,
    abstract: raw.abstract ?? null,
    citationCount: raw.citationCount ?? null,
    doi,
    authors: authors.map((a) => a.name).filter(Boolean),
    publicationDate: raw.publicationDate ?? null,
    isOpenAccess: raw.isOpenAccess ?? false,
    openAccessPdfUrl: openAccessPdf.url ?? null,
    fieldsOfStudy: raw.fieldsOfStudy ?? [],
    venue: raw.venue || journal.name || null,
    journalIssn: journal.issn ?? null,
    source: "semantic_scholar",
    url: paperId
      ? `https://www.semanticscholar.org/paper/${paperId}`
      : null,
  };
}

export async function searchSemanticScholar(
  query: string,
  { limit = 15, yearStart = 2015, token = null as string | null } = {},
) {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (!apiKey) {
    console.warn("[semanticScholar] API key not set — skipping");
    return { papers: [], nextToken: null, total: 0 };
  }

  // Default sort is RELEVANCE — explicitly sorting by citationCount returns
  // the most-cited papers that contain any of the query tokens regardless of
  // whether they are topically relevant (cancer reviews, GBD studies, etc).
  const params = new URLSearchParams({
    query,
    fields: FIELDS,
    limit: String(limit),
    year: `${yearStart}-`,
  });
  if (token) params.set("offset", token);

  try {
    const response = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[semanticScholar] HTTP ${response.status}: ${text}`);
      return { papers: [], nextToken: null, total: 0 };
    }

    const data = await response.json();
    return {
      papers: ((data.data ?? []) as Record<string, unknown>[]).map(mapPaper),
      nextToken: data.next != null ? String(data.next) : null,
      total: data.total ?? 0,
    };
  } catch (err) {
    console.error("[semanticScholar] Fetch error:", (err as Error).message);
    return { papers: [], nextToken: null, total: 0 };
  }
}
