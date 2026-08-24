// deno-lint-ignore-file no-explicit-any
/**
 * Retrieval audit agent.
 *
 * Admin/debug tool: compares the evidence table from a search run against
 * relaxed in-corpus candidates that should plausibly appear under the user's
 * filters. This is intentionally separate from the live retrieval pipeline so
 * it can be used for regression evaluation without adding user-facing latency.
 */

import { qwenGenerateJSON } from "./qwenClient.ts";

type Verdict =
  | "good_coverage"
  | "partial_coverage"
  | "likely_missing_key_evidence"
  | "filter_mismatch"
  | "retrieval_failure";

interface AuditWork {
  id: string;
  title: string;
  canonical_doi?: string | null;
  year?: number | null;
  authors?: string[] | null;
  source?: string | null;
  venue?: string | null;
  abstract?: string | null;
  citation_count?: number | null;
  sms_level?: number | null;
  methodology_design?: string | null;
  abs_rating?: string | null;
  repec_percentile?: number | null;
  geography?: string[] | null;
  publication_type?: string | null;
}

interface ExpectedEvidenceItem {
  title: string;
  doi?: string | null;
  authors?: string[];
  year?: number | null;
  source?: string | null;
  whyExpected: string;
  expectedUnderFilters: boolean;
  matchedWorkId?: string;
  status: "present" | "missing" | "excluded_by_filter" | "not_in_corpus" | "near_duplicate_present";
  adminRelevance?: "relevant" | "not_relevant" | null;
}

interface AuditFeedbackItem {
  item_title?: string | null;
  item_doi?: string | null;
  item_year?: number | null;
  item_source?: string | null;
  item_authors?: string[] | null;
  item_why_expected?: string | null;
  item_status?: string | null;
  query_key?: string | null;
  verdict?: string | null;
}

interface TableDiagnostics {
  directMatchCount: number;
  indirectMatchCount: number;
  offTopicCount: number;
  wrongGeographyCount: number;
  wrongMethodologyCount: number;
  yearFilterViolations: number;
  sourceFilterViolations: number;
  inCorpusButMissingCount: number;
  expectedPresentCount: number;
}

export interface RetrievalAuditResult {
  query: string;
  verdict: Verdict;
  confidence: number;
  expectedEvidence: ExpectedEvidenceItem[];
  tableDiagnostics: TableDiagnostics;
  recommendedActions: string[];
  auditMode: "corpus" | "external";
  externalDiagnostics?: {
    openAlexCount: number;
    semanticScholarCount: number;
    llmCanonicalCount: number;
    llmSearchQueryCount: number;
    llmSearchQueries: string[];
  };
  auditVersion: string;
}

const AUDIT_VERSION = "retrieval-audit-v1";
const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const SEMANTIC_SCHOLAR_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const WORKING_PAPER_HINTS: Record<string, string[]> = {
  NBER: ["nber", "national bureau of economic research"],
  SSRN: ["ssrn", "social science research network"],
  OECD_WP: ["oecd working paper", "oecd papers", "oecd economics department"],
  WB_WP: ["world bank policy research working paper", "policy research working paper"],
  IZA: ["iza"],
  CEPR_REPEC: ["cepr"],
  // Legacy saved filters: keep broad RePEc behavior for existing audits.
  RePEc: ["repec", "ideas", "iza", "cesifo"],
};
const INSTITUTIONAL_HINTS: Record<string, string[]> = {
  IADB: ["iadb", "inter-american development bank", "banco interamericano de desarrollo"],
  WB: ["world bank", "policy research working paper"],
  OECD: ["oecd"],
  OTHER: [],
};
const STOPWORDS = new Set([
  "about", "after", "against", "and", "are", "can", "does", "for", "from",
  "have", "high", "into", "more", "policy", "quality",
  "say", "the", "this", "transition", "what", "with",
]);

function tokenize(text: string): string[] {
  return [...new Set(
    (text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => (t.length >= 3 || t === "ai") && !STOPWORDS.has(t)),
  )].slice(0, 12);
}

function readEnv(key: string): string | undefined {
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") return denoEnv.get(key) ?? undefined;
  return (globalThis as any).process?.env?.[key];
}

function haystack(work: AuditWork): string {
  return `${work.title || ""} ${work.abstract || ""} ${(work.geography || []).join(" ")}`.toLowerCase();
}

function normalizedTitle(title: string): string {
  return (title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeAuditQueryKey(query: string): string {
  return normalizedTitle(query).slice(0, 240);
}

function titleSimilarity(a: string, b: string): number {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (aa.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const t of aa) if (bb.has(t)) overlap += 1;
  return overlap / Math.max(aa.size, bb.size);
}

function matchesQuery(work: AuditWork, queryTokens: string[]): "direct" | "indirect" | "off_topic" {
  if (queryTokens.length === 0) return "indirect";
  const text = haystack(work);
  const hits = queryTokens.filter((t) => text.includes(t)).length;
  const share = hits / queryTokens.length;
  if (share >= 0.45) return "direct";
  if (share >= 0.2) return "indirect";
  return "off_topic";
}

function violatesYear(work: AuditWork, filters: any): boolean {
  const year = work.year ?? null;
  if (!year) return false;
  const startYear = filters?.startDate ? Number(String(filters.startDate).slice(0, 4)) : null;
  const endYear = filters?.endDate ? Number(String(filters.endDate).slice(0, 4)) : null;
  if (Number.isFinite(startYear) && year < startYear!) return true;
  if (Number.isFinite(endYear) && year > endYear!) return true;
  return false;
}

function violatesSms(work: AuditWork, filters: any): boolean {
  const smsLevels = Array.isArray(filters?.smsLevels) ? filters.smsLevels : null;
  if (!smsLevels || smsLevels.length === 0 || work.sms_level == null) return false;
  return !smsLevels.includes(work.sms_level);
}

function violatesRegion(work: AuditWork, filters: any): boolean {
  const regions = Array.isArray(filters?.regions) ? filters.regions.filter(Boolean) : [];
  if (regions.length === 0) return false;
  const text = haystack(work);
  const regionText = regions.join(" ").toLowerCase();
  if (regionText.includes("lac") || regionText.includes("latin")) {
    return !/\b(latin america|lac|caribbean|brazil|mexico|colombia|argentina|chile|peru|ecuador|bolivia|uruguay|paraguay|costa rica|panama|guatemala|honduras|el salvador|nicaragua|dominican republic|haiti|jamaica)\b/i.test(text);
  }
  return !regions.some((r: string) => text.includes(String(r).toLowerCase()));
}

function matchesWorkingPaperSource(work: AuditWork, sourceId: string): boolean {
  const source = `${work.source || ""} ${work.venue || ""}`.toLowerCase();
  if (!source) return false;

  if (sourceId === "CEPR_REPEC") {
    if (source.includes("cepr")) return true;
    const isRepec = String(work.source || "").toLowerCase() === "repec" ||
      source.includes("ideas") ||
      source.includes("econpapers");
    if (!isRepec) return false;
    const namedElsewhere = [
      "nber",
      "national bureau of economic research",
      "ssrn",
      "social science research network",
      "oecd",
      "world bank",
      "open knowledge repository",
      "policy research working paper",
      "iza",
    ].some((hint) => source.includes(hint));
    return !namedElsewhere;
  }

  const hints = WORKING_PAPER_HINTS[sourceId] ?? [sourceId.toLowerCase()];
  return hints.some((hint) => source.includes(String(hint).toLowerCase()));
}

function violatesSource(work: AuditWork, filters: any): boolean {
  if (filters?.allSources) return false;
  const journalTiers = Array.isArray(filters?.journalTiers) ? filters.journalTiers : [];
  if (journalTiers.length > 0) return false;
  const inst = Array.isArray(filters?.institutionalSources) ? filters.institutionalSources : [];
  const wp = Array.isArray(filters?.workingPaperSources) ? filters.workingPaperSources : [];
  if (inst.length === 0 && wp.length === 0) return false;
  const source = `${work.source || ""} ${work.venue || ""}`.toLowerCase();
  if (inst.includes("OTHER")) return false;
  const wpMatched = wp.some((id: string) => matchesWorkingPaperSource(work, String(id)));
  const instAllowed = inst
    .flatMap((id: string) => INSTITUTIONAL_HINTS[String(id)] ?? [String(id)])
    .map((x: string) => String(x).toLowerCase())
    .filter(Boolean);
  const instMatched = instAllowed.some((x: string) => source.includes(x));
  return !(wpMatched || instMatched);
}

function expectedUnderFilters(work: AuditWork, filters: any): boolean {
  return !violatesYear(work, filters) && !violatesSms(work, filters) && !violatesRegion(work, filters) && !violatesSource(work, filters);
}

function findNearDuplicate(work: AuditWork, evidence: AuditWork[]): AuditWork | null {
  const doi = (work.canonical_doi || "").toLowerCase();
  if (doi) {
    const byDoi = evidence.find((e) => (e.canonical_doi || "").toLowerCase() === doi);
    if (byDoi) return byDoi;
  }
  const norm = normalizedTitle(work.title);
  return evidence.find((e) => normalizedTitle(e.title) === norm || titleSimilarity(e.title, work.title) >= 0.82) ?? null;
}

async function fetchRelaxedCandidates(client: any, query: string): Promise<AuditWork[]> {
  const terms = tokenize(query).slice(0, 8);
  const clauses = terms.flatMap((term) => [`title.ilike.%${term}%`, `abstract.ilike.%${term}%`]);
  if (clauses.length === 0) return [];
  const { data, error } = await client
    .from("works")
    .select("id,title,canonical_doi,year,authors,source,venue,abstract,citation_count,sms_level,methodology_design,abs_rating,repec_percentile,geography,publication_type")
    .or(clauses.join(","))
    .eq("excluded", false)
    .order("citation_count", { ascending: false })
    .limit(120);
  if (error) {
    console.error("[retrieval-audit] relaxed candidate query failed:", error.message);
    return [];
  }
  return (data || []) as AuditWork[];
}

async function fetchExactCorpusMatches(client: any, works: AuditWork[]): Promise<AuditWork[]> {
  const dois = [...new Set(works.map((work) => normalizeDoi(work.canonical_doi)).filter(Boolean) as string[])];
  if (dois.length === 0) return [];

  const selectCols = "id,title,canonical_doi,year,authors,source,venue,abstract,citation_count,sms_level,methodology_design,abs_rating,repec_percentile,geography,publication_type";
  const [byId, byDoi] = await Promise.all([
    client.from("works").select(selectCols).in("id", dois).eq("excluded", false),
    client.from("works").select(selectCols).in("canonical_doi", dois).eq("excluded", false),
  ]);

  if (byId.error || byDoi.error) {
    console.error("[retrieval-audit] exact corpus DOI query failed:", byId.error?.message || byDoi.error?.message);
  }
  const rows = [...(byId.data || []), ...(byDoi.data || [])] as AuditWork[];
  return rows.filter((row, index, arr) =>
    arr.findIndex((other) =>
      (row.id && other.id === row.id) ||
      (row.canonical_doi && other.canonical_doi === row.canonical_doi)
    ) === index
  );
}

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

function feedbackMatchesQuery(row: AuditFeedbackItem, queryKey: string): boolean {
  return !row.query_key || row.query_key === queryKey;
}

function feedbackMatchesItem(row: AuditFeedbackItem, item: { title: string; doi?: string | null }): boolean {
  const itemDoi = normalizeDoi(item.doi);
  const feedbackDoi = normalizeDoi(row.item_doi);
  if (itemDoi && feedbackDoi && itemDoi === feedbackDoi) return true;
  const feedbackTitle = normalizedTitle(row.item_title || "");
  const itemTitle = normalizedTitle(item.title);
  return !!feedbackTitle && (feedbackTitle === itemTitle || titleSimilarity(feedbackTitle, itemTitle) >= 0.9);
}

function latestFeedbackForItem(
  item: { title: string; doi?: string | null },
  feedback: AuditFeedbackItem[],
  queryKey: string,
): AuditFeedbackItem | undefined {
  return feedback.find((row) => feedbackMatchesQuery(row, queryKey) && feedbackMatchesItem(row, item));
}

function isRejectedByFeedback(item: ExpectedEvidenceItem, feedback: AuditFeedbackItem[], queryKey: string): boolean {
  return latestFeedbackForItem(item, feedback, queryKey)?.verdict === "not_relevant";
}

function annotateAdminRelevance(item: ExpectedEvidenceItem, feedback: AuditFeedbackItem[], queryKey: string): ExpectedEvidenceItem {
  const match = latestFeedbackForItem(item, feedback, queryKey);
  return match?.verdict === "relevant" || match?.verdict === "not_relevant"
    ? { ...item, adminRelevance: match.verdict }
    : item;
}

function adminRelevantItems(
  feedback: AuditFeedbackItem[],
  queryKey: string,
  evidenceWorks: AuditWork[],
  corpusCandidates: AuditWork[],
): ExpectedEvidenceItem[] {
  return feedback
    .filter((row) => row.verdict === "relevant" && feedbackMatchesQuery(row, queryKey))
    .filter((row) => latestFeedbackForItem({ title: row.item_title || "", doi: row.item_doi }, feedback, queryKey) === row)
    .map((row) => {
      const asWork: AuditWork = {
        id: row.item_doi || row.item_title || "admin-relevant",
        title: row.item_title || "",
        canonical_doi: row.item_doi || null,
        year: row.item_year ?? null,
        authors: row.item_authors || [],
        source: row.item_source || "admin_relevant",
      };
      const evidenceMatch = findNearDuplicate(asWork, evidenceWorks);
      const corpusMatch = findNearDuplicate(asWork, corpusCandidates);
      return {
        title: asWork.title,
        doi: asWork.canonical_doi,
        authors: asWork.authors || [],
        year: asWork.year,
        source: row.item_source || "Admin relevant",
        whyExpected: row.item_why_expected || "Admin marked this paper as relevant expected evidence for this specific question.",
        expectedUnderFilters: true,
        matchedWorkId: evidenceMatch?.id,
        status: evidenceMatch ? "present" : corpusMatch ? "missing" : "not_in_corpus",
        adminRelevance: "relevant",
      } as ExpectedEvidenceItem;
    })
    .filter((item) => item.title);
}

function reconstructOpenAlexAbstract(inverted: Record<string, number[]> | null | undefined): string | null {
  if (!inverted || typeof inverted !== "object") return null;
  const positions: Array<[number, string]> = [];
  for (const [word, posList] of Object.entries(inverted)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) if (typeof p === "number") positions.push([p, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ") || null;
}

async function fetchOpenAlexExpected(query: string, filters: any, limit = 20): Promise<AuditWork[]> {
  const params = new URLSearchParams();
  params.set("search", query);
  params.set("per_page", String(limit));
  params.set("sort", "relevance_score:desc");
  params.set("mailto", readEnv("OPENALEX_EMAIL") || "horizon-scanner@iadb.org");
  const yearStart = filters?.startDate ? String(filters.startDate).slice(0, 4) : "1990";
  params.set("filter", [`from_publication_date:${yearStart}-01-01`, "has_doi:true"].join(","));
  const apiKey = readEnv("OPENALEX_API_KEY");
  if (apiKey) params.set("api_key", apiKey);
  try {
    const response = await fetch(`${OPENALEX_WORKS_URL}?${params.toString()}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return [];
    const payload = await response.json();
    return ((payload.results || []) as any[]).map((raw) => ({
      id: normalizeDoi(raw.doi) || raw.id,
      title: raw.title || raw.display_name || "",
      canonical_doi: normalizeDoi(raw.doi),
      year: raw.publication_year ?? null,
      authors: Array.isArray(raw.authorships) ? raw.authorships.map((a: any) => a?.author?.display_name).filter(Boolean) : [],
      source: "openalex",
      venue: raw.primary_location?.source?.display_name ?? null,
      abstract: reconstructOpenAlexAbstract(raw.abstract_inverted_index),
      citation_count: raw.cited_by_count ?? null,
      sms_level: null,
      methodology_design: null,
      geography: [],
      publication_type: raw.type ?? null,
    })).filter((w) => w.title);
  } catch (err) {
    console.error("[retrieval-audit] OpenAlex external audit failed:", (err as Error).message);
    return [];
  }
}

async function fetchSemanticScholarExpected(query: string, filters: any, limit = 20): Promise<AuditWork[]> {
  const apiKey = readEnv("SEMANTIC_SCHOLAR_API_KEY");
  if (!apiKey) return [];
  const params = new URLSearchParams({
    query,
    fields: "title,year,abstract,citationCount,externalIds,authors,venue,journal",
    limit: String(limit),
    year: `${filters?.startDate ? String(filters.startDate).slice(0, 4) : "1990"}-`,
  });
  try {
    const response = await fetch(`${SEMANTIC_SCHOLAR_URL}?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return ((payload.data || []) as any[]).map((raw) => {
      const doi = normalizeDoi(raw.externalIds?.DOI);
      return {
        id: doi || (raw.paperId ? `ss:${raw.paperId}` : raw.title),
        title: raw.title || "",
        canonical_doi: doi,
        year: raw.year ?? null,
        authors: Array.isArray(raw.authors) ? raw.authors.map((a: any) => a.name).filter(Boolean) : [],
        source: "semantic_scholar",
        venue: raw.venue || raw.journal?.name || null,
        abstract: raw.abstract ?? null,
        citation_count: raw.citationCount ?? null,
        sms_level: null,
        methodology_design: null,
        geography: [],
        publication_type: null,
      };
    }).filter((w) => w.title);
  } catch (err) {
    console.error("[retrieval-audit] Semantic Scholar external audit failed:", (err as Error).message);
    return [];
  }
}

async function askLlmForExternalSearchQueries(query: string, filters: any): Promise<string[]> {
  const prompt = `You are designing academic database searches for an evidence audit.

Question: ${query}
User filters: ${JSON.stringify(filters)}

Create 4 concise academic search queries for OpenAlex/Semantic Scholar. Each query should use scholarly synonyms and should target canonical/high-priority research evidence for the exact question. Do not include Boolean operators.

Return JSON only:
{"queries":["..."]}`;
  try {
    const result = await qwenGenerateJSON<{ queries: string[] }>(prompt, { temperature: 0.2, timeoutMs: 12_000 });
    return Array.isArray(result?.queries)
      ? result.queries.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 4)
      : [];
  } catch (err) {
    console.error("[retrieval-audit] LLM external search query generation failed:", (err as Error).message);
    return [];
  }
}

async function askLlmForCanonicalEvidence(params: {
  query: string;
  filters: any;
  evidenceWorks: AuditWork[];
  externalWorks: AuditWork[];
}): Promise<ExpectedEvidenceItem[]> {
  const { query, filters, evidenceWorks, externalWorks } = params;
  const prompt = `You are a research-methods auditor for an evidence retrieval system.

Question: ${query}
User filters: ${JSON.stringify(filters)}

Actual evidence table titles:
${evidenceWorks.slice(0, 30).map((w, i) => `${i + 1}. ${w.title} (${w.year ?? "n.d."}) DOI=${w.canonical_doi || "-"}`).join("\n")}

External search candidates:
${externalWorks.slice(0, 30).map((w, i) => `${i + 1}. ${w.title} (${w.year ?? "n.d."}) citations=${w.citation_count ?? 0} source=${w.source} DOI=${w.canonical_doi || "-"}`).join("\n")}

Identify up to 8 canonical or high-priority papers that a competent evidence system should consider for this exact question and filters. Prefer meta-analyses, highly cited causal studies, and LAC-relevant evidence when the question is regional. Do not invent DOIs. Mark expectedUnderFilters=false if the user's filters would exclude it.

Return JSON only:
{"items":[{"title":"...","doi":null,"authors":[],"year":2020,"source":"...","whyExpected":"...","expectedUnderFilters":true}]}`;
  try {
    const result = await qwenGenerateJSON<{ items: ExpectedEvidenceItem[] }>(prompt, { temperature: 0.1, timeoutMs: 18_000 });
    return Array.isArray(result?.items) ? result.items.slice(0, 8) : [];
  } catch (err) {
    console.error("[retrieval-audit] LLM canonical audit failed:", (err as Error).message);
    return [];
  }
}

function toExternalExpectedItems(
  externalWorks: AuditWork[],
  evidenceWorks: AuditWork[],
  corpusCandidates: AuditWork[],
  exactCorpusMatches: AuditWork[],
  filters: any,
): ExpectedEvidenceItem[] {
  return externalWorks.slice(0, 25).map((work) => {
    const evidenceMatch = findNearDuplicate(work, evidenceWorks);
    const corpusMatch = findNearDuplicate(work, exactCorpusMatches) ?? findNearDuplicate(work, corpusCandidates);
    const filterOk = expectedUnderFilters(work, filters);
    const status = evidenceMatch
      ? "present"
      : !filterOk
      ? "excluded_by_filter"
      : corpusMatch
      ? "missing"
      : "not_in_corpus";
    return {
      title: work.title,
      doi: work.canonical_doi,
      authors: work.authors || [],
      year: work.year,
      source: work.venue || work.source,
      whyExpected: `External ${work.source} candidate with ${work.citation_count ?? 0} citations; used to audit whether the corpus/retriever is missing canonical evidence.`,
      expectedUnderFilters: filterOk,
      matchedWorkId: evidenceMatch?.id ?? corpusMatch?.id,
      status,
    };
  });
}

export async function runRetrievalAudit(params: {
  client: any;
  searchRun: any;
  evidenceWorks: AuditWork[];
  mode?: "corpus" | "external";
  feedback?: AuditFeedbackItem[];
}): Promise<RetrievalAuditResult> {
  const { client, searchRun, evidenceWorks, mode = "corpus", feedback = [] } = params;
  const filters = searchRun.filters || {};
  const query = searchRun.query || "";
  const queryKey = normalizeAuditQueryKey(query);
  const queryTokens = tokenize(query);
  const evidenceIds = new Set((searchRun.evidenceWorkIds || []).map(String));
  const relaxed = await fetchRelaxedCandidates(client, query);

  const rankedExpected = relaxed
    .map((work) => {
      const relevance = matchesQuery(work, queryTokens);
      const sms = work.sms_level ?? 0;
      const citations = work.citation_count ?? 0;
      const filterOk = expectedUnderFilters(work, filters);
      const score =
        (relevance === "direct" ? 100 : relevance === "indirect" ? 45 : 0) +
        Math.min(30, Math.log10(citations + 1) * 10) +
        Math.max(0, sms) * 6 +
        (filterOk ? 20 : -25);
      return { work, relevance, filterOk, score };
    })
    .filter((x) => x.relevance !== "off_topic")
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  let expectedEvidence: ExpectedEvidenceItem[] = rankedExpected.map(({ work, filterOk, score }) => {
    const near = findNearDuplicate(work, evidenceWorks);
    const isPresent = evidenceIds.has(work.id) || !!near;
    const status = isPresent
      ? evidenceIds.has(work.id) ? "present" : "near_duplicate_present"
      : filterOk ? "missing" : "excluded_by_filter";
    return {
      title: work.title,
      doi: work.canonical_doi,
      authors: work.authors || [],
      year: work.year,
      source: work.venue || work.source,
      whyExpected: `Relaxed corpus match ranked highly by query overlap, citations (${work.citation_count ?? 0}), and SMS ${work.sms_level ?? "unclassified"}. Audit score ${Math.round(score)}.`,
      expectedUnderFilters: filterOk,
      matchedWorkId: evidenceIds.has(work.id) ? work.id : near?.id,
      status,
    };
  });
  expectedEvidence = expectedEvidence
    .filter((item) => !isRejectedByFeedback(item, feedback, queryKey))
    .map((item) => annotateAdminRelevance(item, feedback, queryKey));

  let externalDiagnostics: RetrievalAuditResult["externalDiagnostics"] | undefined;
  if (mode === "external") {
    const llmSearchQueries = await askLlmForExternalSearchQueries(query, filters);
    const externalSearchQueries = [...new Set([query, ...llmSearchQueries])].slice(0, 5);
    const externalBatches = await Promise.all(externalSearchQueries.map(async (searchQuery) => {
      const [openAlexRows, semanticScholarRows] = await Promise.all([
        fetchOpenAlexExpected(searchQuery, filters, 12),
        fetchSemanticScholarExpected(searchQuery, filters, 12),
      ]);
      return { openAlexRows, semanticScholarRows };
    }));
    const openAlex = externalBatches.flatMap((batch) => batch.openAlexRows);
    const semanticScholar = externalBatches.flatMap((batch) => batch.semanticScholarRows);
    const externalWorks = [...openAlex, ...semanticScholar]
      .filter((work, index, arr) =>
        arr.findIndex((other) =>
          (work.canonical_doi && other.canonical_doi === work.canonical_doi) ||
          normalizedTitle(other.title) === normalizedTitle(work.title)
        ) === index
      )
      .sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0));
    const llmItems = await askLlmForCanonicalEvidence({ query, filters, evidenceWorks, externalWorks });
    const llmAsWorks: AuditWork[] = llmItems.map((item) => ({
      id: item.doi || item.title,
      title: item.title,
      canonical_doi: item.doi,
      year: item.year,
      authors: item.authors || [],
      source: item.source || "llm_canonical",
    }));
    const exactCorpusMatches = await fetchExactCorpusMatches(client, [...externalWorks, ...llmAsWorks]);
    const externalItems = toExternalExpectedItems(externalWorks, evidenceWorks, relaxed, exactCorpusMatches, filters);
    const llmResolved = llmItems.map((item) => {
      const asWork: AuditWork = {
        id: item.doi || item.title,
        title: item.title,
        canonical_doi: item.doi,
        year: item.year,
        authors: item.authors || [],
        source: item.source || "llm_canonical",
      };
      const evidenceMatch = findNearDuplicate(asWork, evidenceWorks);
      const corpusMatch = findNearDuplicate(asWork, exactCorpusMatches) ?? findNearDuplicate(asWork, relaxed);
      return {
        ...item,
        matchedWorkId: evidenceMatch?.id ?? corpusMatch?.id,
        status: evidenceMatch ? "present" : corpusMatch ? "missing" : "not_in_corpus",
      } as ExpectedEvidenceItem;
    });
    const corpusEvidence = expectedEvidence;
    expectedEvidence = [...llmResolved, ...externalItems, ...corpusEvidence]
      .filter((item, index, arr) =>
        arr.findIndex((other) =>
          (item.doi && other.doi === item.doi) ||
          normalizedTitle(other.title) === normalizedTitle(item.title)
        ) === index
      )
      .filter((item) => !isRejectedByFeedback(item, feedback, queryKey))
      .map((item) => annotateAdminRelevance(item, feedback, queryKey))
      .slice(0, 45);
    externalDiagnostics = {
      openAlexCount: openAlex.length,
      semanticScholarCount: semanticScholar.length,
      llmCanonicalCount: llmItems.length,
      llmSearchQueryCount: llmSearchQueries.length,
      llmSearchQueries,
    };
  }

  const adminRelevant = adminRelevantItems(feedback, queryKey, evidenceWorks, relaxed);
  if (adminRelevant.length > 0) {
    expectedEvidence = [...adminRelevant, ...expectedEvidence]
      .filter((item, index, arr) =>
        arr.findIndex((other) =>
          (item.doi && other.doi === item.doi) ||
          normalizedTitle(other.title) === normalizedTitle(item.title)
        ) === index
      );
  }

  const classifications = Object.values(searchRun.evidenceClassification || {}) as any[];
  const directMatchCount = classifications.filter((c) => c?.evidenceMatch === "direct").length;
  const indirectMatchCount = classifications.filter((c) => c?.evidenceMatch === "indirect").length;
  const offTopicCount = evidenceWorks.filter((w) => matchesQuery(w, queryTokens) === "off_topic").length;
  const wrongGeographyCount = evidenceWorks.filter((w) => violatesRegion(w, filters)).length;
  const wrongMethodologyCount = evidenceWorks.filter((w) => violatesSms(w, filters)).length;
  const yearFilterViolations = evidenceWorks.filter((w) => violatesYear(w, filters)).length;
  const sourceFilterViolations = evidenceWorks.filter((w) => violatesSource(w, filters)).length;
  const missing = expectedEvidence.filter((e) => e.status === "missing");
  const expectedPresentCount = expectedEvidence.filter((e) => e.expectedUnderFilters).length;

  const tableDiagnostics: TableDiagnostics = {
    directMatchCount,
    indirectMatchCount,
    offTopicCount,
    wrongGeographyCount,
    wrongMethodologyCount,
    yearFilterViolations,
    sourceFilterViolations,
    inCorpusButMissingCount: missing.length,
    expectedPresentCount,
  };

  const recommendedActions: string[] = [];
  if (missing.length > 0) recommendedActions.push(`Inspect ${missing.length} high-ranked in-corpus papers that passed filters but were not retrieved.`);
  if (mode === "external") {
    const notInCorpus = expectedEvidence.filter((e) => e.status === "not_in_corpus" && e.expectedUnderFilters).length;
    if (notInCorpus > 0) recommendedActions.push(`Review ${notInCorpus} external canonical candidates that appear absent from the corpus.`);
  }
  if (wrongMethodologyCount > 0) recommendedActions.push("Check SMS/methodology filter enforcement or backfilled SMS labels.");
  if (wrongGeographyCount > 0) recommendedActions.push("Check geography facet extraction and region filter handling.");
  if (offTopicCount > Math.max(3, evidenceWorks.length * 0.2)) recommendedActions.push("Review query facet classifier and reranker weights; evidence table contains many low-overlap papers.");
  if (expectedPresentCount === 0) recommendedActions.push("Relax filters or expand corpus/query terms; audit found no strong in-filter expected candidates.");
  if (recommendedActions.length === 0) recommendedActions.push("Coverage looks reasonable under the selected filters; use this audit as a regression baseline.");

  let verdict: Verdict = "good_coverage";
  if ((searchRun.evidenceWorkIds || []).length === 0 && expectedPresentCount > 0) verdict = "retrieval_failure";
  else if (wrongMethodologyCount + wrongGeographyCount + yearFilterViolations > 0) verdict = "filter_mismatch";
  else if (missing.length >= 5) verdict = "likely_missing_key_evidence";
  else if (missing.length > 0 || offTopicCount > 0) verdict = "partial_coverage";

  const confidence = Math.max(0.35, Math.min(0.95, 0.55 + Math.min(0.25, expectedEvidence.length / 100) + (expectedPresentCount > 0 ? 0.15 : 0) - (missing.length > 0 ? 0.08 : 0)));

  return {
    query,
    verdict,
    confidence: Number(confidence.toFixed(2)),
    expectedEvidence,
    tableDiagnostics,
    recommendedActions,
    auditMode: mode,
    externalDiagnostics,
    auditVersion: AUDIT_VERSION,
  };
}
