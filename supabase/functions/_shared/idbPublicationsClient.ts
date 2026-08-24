/**
 * supabase/functions/_shared/idbPublicationsClient.ts
 *
 * Search the IDB Publications repository via its Drupal JSON:API.
 * Free, no authentication required.
 *
 * Base URL: https://publications.iadb.org/en/jsonapi/node/publication
 */

const IDB_JSONAPI_URL = "https://publications.iadb.org/en/jsonapi/node/publication";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

function cleanText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip HTML tags that Drupal sometimes returns in abstracts
  const stripped = String(raw).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * Extract authors from the included field_author relationships.
 */
function extractAuthors(publication: Paper, includedMap: Map<string, Paper>): string[] {
  const authorRels = publication.relationships?.field_author?.data;
  if (!Array.isArray(authorRels)) return [];

  const names: string[] = [];
  for (const rel of authorRels) {
    const key = `${rel.type}:${rel.id}`;
    const included = includedMap.get(key);
    if (included?.attributes?.title) {
      names.push(included.attributes.title.trim());
    } else if (included?.attributes?.name) {
      names.push(included.attributes.name.trim());
    }
  }
  return names;
}

/**
 * Extract subject/topic terms from the included field_subject relationships.
 */
function extractSubjects(publication: Paper, includedMap: Map<string, Paper>): string[] {
  const subjectRels = publication.relationships?.field_subject?.data;
  if (!Array.isArray(subjectRels)) return [];

  const subjects: string[] = [];
  for (const rel of subjectRels) {
    const key = `${rel.type}:${rel.id}`;
    const included = includedMap.get(key);
    const name = included?.attributes?.name ?? included?.attributes?.title;
    if (name) subjects.push(name.trim());
  }
  return subjects;
}

function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = parseInt(String(dateStr).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^https?:\/\/doi\.org\//i, "").trim().toLowerCase();
  return cleaned || null;
}

function mapPublication(resource: Paper, includedMap: Map<string, Paper>): Paper | null {
  const attrs = resource.attributes;
  if (!attrs) return null;

  const title = cleanText(attrs.title);
  if (!title) return null;

  // field_doi can be a string or an object {uri: "http://dx.doi.org/10.18235/...", title, options}
  const rawDoi = typeof attrs.field_doi === "object" ? attrs.field_doi?.uri : attrs.field_doi;
  const doi = normalizeDoi(rawDoi);
  const nodeId = resource.id;
  const id = doi ?? `idb:${nodeId}`;

  const abstract = cleanText(attrs.field_abstract?.value ?? attrs.field_abstract);
  const year = extractYear(attrs.field_date_issued_text);
  const publicationDate = attrs.field_date_issued_text
    ? String(attrs.field_date_issued_text).slice(0, 10)
    : null;

  const pdfUrl = attrs.field_document_link_en?.uri
    ?? attrs.field_document_link_es?.uri
    ?? attrs.field_document_link_pt?.uri
    ?? null;

  const authors = extractAuthors(resource, includedMap);
  const subjects = extractSubjects(resource, includedMap);

  const handleId = attrs.field_handle_id;
  const url = handleId
    ? `https://publications.iadb.org/en/publication/${handleId}`
    : `https://publications.iadb.org/en/node/${nodeId}`;

  return {
    id,
    title,
    year,
    abstract,
    citationCount: null,
    doi,
    authors,
    publicationDate,
    isOpenAccess: true,
    openAccessPdfUrl: pdfUrl,
    fieldsOfStudy: subjects,
    venue: "IDB Publication",
    journalIssn: null,
    url,
    source: "idb_publications",
  };
}

export interface IdbSearchResult {
  papers: Paper[];
  total: number;
}

/**
 * Search IDB Publications. Free, no key, no auth.
 */
export async function searchIdbPublications(
  query: string,
  { limit = 15, yearStart = 2015 } = {},
): Promise<IdbSearchResult> {
  const pageLimit = Math.min(Math.max(limit, 1), 50);

  const params = new URLSearchParams();

  params.set("filter[title-filter][condition][path]", "title");
  params.set("filter[title-filter][condition][operator]", "CONTAINS");
  params.set("filter[title-filter][condition][value]", query);

  params.set("filter[date-filter][condition][path]", "field_date_issued_text");
  params.set("filter[date-filter][condition][operator]", ">=");
  params.set("filter[date-filter][condition][value]", `${yearStart}-01-01`);

  params.set("sort", "-field_date_issued_text");
  params.set("page[limit]", String(pageLimit));
  params.set("include", "field_author,field_subject");

  const url = `${IDB_JSONAPI_URL}?${params.toString()}`;
  console.log(`[idb-publications] Searching: ${url.slice(0, 160)}...`);

  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/vnd.api+json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[idb-publications] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return { papers: [], total: 0 };
    }

    const data = await response.json();

    const includedMap = new Map<string, Paper>();
    if (Array.isArray(data.included)) {
      for (const inc of data.included) {
        includedMap.set(`${inc.type}:${inc.id}`, inc);
      }
    }

    const resources = data.data ?? [];
    const papers: Paper[] = [];
    for (const resource of resources) {
      const mapped = mapPublication(resource, includedMap);
      if (mapped) papers.push(mapped);
    }

    const total = data.meta?.count ?? papers.length;

    console.log(`[idb-publications] Retrieved ${papers.length} publications.`);
    return { papers, total };
  } catch (err) {
    console.error("[idb-publications] Fetch error:", (err as Error).message);
    return { papers: [], total: 0 };
  }
}
