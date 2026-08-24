const CROSSREF_WORKS_URL = "https://api.crossref.org/works";
const POLITE_EMAIL_FALLBACK = "horizon-scanner@iadb.org";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

/**
 * CrossRef returns abstracts as JATS XML (<jats:p>...</jats:p>).
 * Strip tags to plain text.
 */
function stripJats(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = String(raw)
    .replace(/<jats:[^>]+>/gi, "")
    .replace(/<\/jats:[^>]+>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || null;
}

/**
 * Extract year from CrossRef's date-parts structure: { "date-parts": [[2023, 10, 19]] }
 */
function extractYear(dateField: Paper | null | undefined): number | null {
  if (!dateField) return null;
  const parts = dateField["date-parts"];
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const first = parts[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  const year = first[0];
  return typeof year === "number" ? year : null;
}

function extractDate(dateField: Paper | null | undefined): string | null {
  if (!dateField) return null;
  const parts = dateField["date-parts"];
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const first = parts[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  const [y, m, d] = first;
  if (typeof y !== "number") return null;
  const mm = typeof m === "number" ? String(m).padStart(2, "0") : "01";
  const dd = typeof d === "number" ? String(d).padStart(2, "0") : "01";
  return `${y}-${mm}-${dd}`;
}

function mapItem(item: Paper): Paper | null {
  const doi = normalizeDoi(item.DOI);
  if (!doi) return null; // CrossRef without DOI = not useful

  const titleArr = Array.isArray(item.title) ? item.title : [];
  const title = titleArr[0] ?? null;
  if (!title) return null;

  const containerArr = Array.isArray(item["container-title"]) ? item["container-title"] : [];
  const venue = containerArr[0] ?? null;
  const issnArr = Array.isArray(item.ISSN) ? item.ISSN : [];
  const issn = issnArr[0] ?? null;

  const authors: string[] = Array.isArray(item.author)
    ? item.author
        .map((a: Paper) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
        .filter((n: string) => n.length > 0)
    : [];

  const year =
    extractYear(item.issued) ??
    extractYear(item["published-print"]) ??
    extractYear(item["published-online"]) ??
    extractYear(item.created);

  const pubDate =
    extractDate(item.issued) ??
    extractDate(item["published-print"]) ??
    extractDate(item["published-online"]) ??
    extractDate(item.created);

  return {
    id: doi,
    title,
    year,
    abstract: stripJats(item.abstract),
    citationCount: item["is-referenced-by-count"] ?? null,
    doi,
    authors,
    publicationDate: pubDate,
    isOpenAccess: false, // CrossRef doesn't reliably expose OA status
    openAccessPdfUrl: null,
    fieldsOfStudy: [],
    venue,
    journalIssn: issn,
    url: item.URL ?? `https://doi.org/${doi}`,
    source: "crossref",
  };
}

export interface CrossrefSearchResult {
  papers: Paper[];
  total: number;
}

/**
 * Search CrossRef for works matching `query`, filtered by publication date.
 * Free, no key — uses polite pool via mailto parameter.
 */
export async function searchCrossref(
  query: string,
  { limit = 15, yearStart = 2015 } = {},
): Promise<CrossrefSearchResult> {
  const email = process.env.OPENALEX_EMAIL || POLITE_EMAIL_FALLBACK;

  // Sort by RELEVANCE (Crossref's default 'score' when ?query= is given).
  // Previously hard-coded to is-referenced-by-count, which surfaced the most-
  // cited papers globally that matched any of the query tokens — same bug
  // that hit OpenAlex/SS. The has-abstract filter still keeps quality up.
  const params = new URLSearchParams({
    query,
    rows: String(Math.min(Math.max(limit, 1), 100)),
    filter: `from-pub-date:${yearStart}-01-01,type:journal-article,type:proceedings-article,type:book-chapter,type:report,has-abstract:true`,
    "mailto": email,
    sort: "score",
    order: "desc",
    select: [
      "DOI", "title", "abstract", "author", "container-title",
      "ISSN", "published-print", "published-online", "issued", "created",
      "is-referenced-by-count", "URL", "type",
    ].join(","),
  });

  const url = `${CROSSREF_WORKS_URL}?${params.toString()}`;
  console.log(`[crossref] Searching: ${url.slice(0, 140)}...`);

  try {
    const response = await fetch(url, {
      headers: {
        // CrossRef also accepts User-Agent for polite pool
        "User-Agent": `horizon-scanner (mailto:${email})`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[crossref] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { papers: [], total: 0 };
    }

    const data = await response.json();
    const items = Array.isArray(data?.message?.items) ? data.message.items : [];
    const papers = items.map(mapItem).filter((p: Paper | null): p is Paper => p !== null);
    const total = data?.message?.["total-results"] ?? 0;

    console.log(`[crossref] Retrieved ${papers.length} papers (${total} total matching).`);
    return { papers, total };
  } catch (err) {
    console.error("[crossref] Fetch error:", (err as Error).message);
    return { papers: [], total: 0 };
  }
}
