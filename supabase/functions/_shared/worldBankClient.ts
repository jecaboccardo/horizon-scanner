const WORLDBANK_WDS_URL = "https://search.worldbank.org/api/v2/wds";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

/**
 * Normalize the messy whitespace/newlines WB returns inside titles + abstracts.
 */
function cleanText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * Extract abstract text from WB's `{ "cdata!": "..." }` wrapping.
 */
function extractAbstract(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return cleanText(raw);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidate = obj["cdata!"] ?? obj.cdata ?? null;
    if (typeof candidate === "string") return cleanText(candidate);
  }
  return null;
}

/**
 * WB's `authors` field is a keyed object: { "0": { author: "Name" }, "1": { author: "FPD" } }.
 * Extract author names, filtering out obvious department/agency codes
 * (short all-uppercase strings).
 */
function extractAuthors(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const names: string[] = [];
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const name = (v as Record<string, unknown>).author;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed) continue;
    // Skip short all-uppercase codes (department abbreviations like "FPD", "DEC")
    if (trimmed.length <= 5 && trimmed === trimmed.toUpperCase() && !trimmed.includes(" ")) continue;
    names.push(trimmed);
  }
  return names;
}

function extractYear(docdt: string | null | undefined): number | null {
  if (!docdt) return null;
  const year = parseInt(String(docdt).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function extractDate(docdt: string | null | undefined): string | null {
  if (!docdt) return null;
  return String(docdt).slice(0, 10) || null;
}

function mapDoc(id: string, doc: Paper): Paper | null {
  const title = cleanText(doc.display_title ?? doc.title);
  if (!title) return null;

  const guid = doc.guid ?? doc.id ?? id.replace(/^D/, "");

  return {
    id: `wb:${guid}`,
    title,
    year: extractYear(doc.docdt),
    abstract: extractAbstract(doc.abstracts),
    citationCount: null, // WB docs don't have citation counts
    doi: null,
    authors: extractAuthors(doc.authors),
    publicationDate: extractDate(doc.docdt),
    isOpenAccess: true, // All WB docs are publicly available
    openAccessPdfUrl: doc.pdfurl ?? null,
    fieldsOfStudy: [],
    venue: doc.docty ?? "World Bank Publication",
    journalIssn: null,
    url: doc.url ?? doc.pdfurl ?? null,
    source: "worldbank",
  };
}

export interface WorldBankSearchResult {
  papers: Paper[];
  total: number;
}

/**
 * Search the World Bank Documents & Reports API for policy docs, working papers,
 * and economic reviews matching `query`.
 *
 * Free, no key, unlimited for reasonable use.
 * Returns up to `limit` documents published on or after `yearStart`.
 */
export async function searchWorldBank(
  query: string,
  { limit = 10, yearStart = 2015 } = {},
): Promise<WorldBankSearchResult> {
  const params = new URLSearchParams({
    qterm: query,
    rows: String(Math.min(Math.max(limit, 1), 50)),
    strdate: `${yearStart}-01-01`,
    format: "json",
    fl: [
      "docdt", "docty", "display_title", "title",
      "url", "pdfurl", "guid", "abstracts", "authors", "count",
    ].join(","),
  });

  const url = `${WORLDBANK_WDS_URL}?${params.toString()}`;
  console.log(`[worldbank] Searching: ${url.slice(0, 140)}...`);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[worldbank] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { papers: [], total: 0 };
    }

    const data = await response.json();
    const docs = (data.documents ?? {}) as Record<string, Paper>;
    const papers: Paper[] = [];
    for (const [docId, doc] of Object.entries(docs)) {
      if (docId === "facets" || !doc || typeof doc !== "object") continue;
      const mapped = mapDoc(docId, doc);
      if (mapped) papers.push(mapped);
    }

    const total = typeof data.total === "number" ? data.total : 0;
    console.log(`[worldbank] Retrieved ${papers.length} documents (${total} total matching).`);
    return { papers, total };
  } catch (err) {
    console.error("[worldbank] Fetch error:", (err as Error).message);
    return { papers: [], total: 0 };
  }
}
