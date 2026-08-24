export const LAC_DOMAINS = [
  "publications.iadb.org", "repositorio.cepal.org", "nber.org",
  "iza.org", "worldbank.org", "cgdev.org", "ideas.repec.org",
];

export async function searchExa(
  query: string,
  { numResults = 15, startPublishedDate = null as string | null, excludeUrls = [] as string[] } = {},
) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    console.warn("[exaClient] EXA_API_KEY not set — returning empty");
    return { papers: [] };
  }

  const body: Record<string, unknown> = {
    query, type: "auto", numResults,
    includeDomains: LAC_DOMAINS,
    contents: { text: { maxCharacters: 500 } },
    excludeUrls,
  };
  if (startPublishedDate !== null) body.startPublishedDate = startPublishedDate;

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      console.error(`[exaClient] Exa API error ${response.status}: ${errText}`);
      return { papers: [] };
    }

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];

    const papers = results.map((result: Record<string, unknown>) => {
      const year = parseYear(result.publishedDate as string | null);
      const url = (result.url as string | null) ?? null;
      return {
        id: `exa:${hashUrl(url ?? (result.id as string | null) ?? "")}`,
        title: result.title ?? "",
        year,
        abstract: result.text ?? null,
        citationCount: null,
        doi: null,
        authors: Array.isArray(result.author) ? result.author : result.author ? [result.author] : [],
        publicationDate: result.publishedDate ?? null,
        isOpenAccess: true,
        openAccessPdfUrl: result.url ?? null,
        fieldsOfStudy: [],
        url: result.url ?? null,
        source: "exa",
      };
    });

    return { papers };
  } catch (err) {
    console.error("[exaClient] Fetch failed:", err);
    return { papers: [] };
  }
}

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = parseInt(dateStr.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function hashUrl(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash) ^ url.charCodeAt(i);
    hash >>>= 0;
  }
  return hash.toString(16);
}
