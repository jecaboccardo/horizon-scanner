#!/usr/bin/env node
/**
 * Backfill missing journal abstracts from matched pre-publication versions.
 *
 * This targets published journal rows that are still missing abstracts and
 * looks for a strongly matching working-paper/preprint/report version with an
 * abstract. Matches can come from already-ingested working-paper rows, plus
 * optional title searches in OpenAlex, Crossref, and Semantic Scholar.
 *
 * Usage:
 *   node scripts/backfill-abstracts-working-papers.mjs --dry-run --limit 100
 *   node scripts/backfill-abstracts-working-papers.mjs --mode internal
 *   node scripts/backfill-abstracts-working-papers.mjs --mode internal --exact-only
 *   node scripts/backfill-abstracts-working-papers.mjs --mode all --limit 1000
 *   node scripts/backfill-abstracts-working-papers.mjs --ids 10.1016/example,10.3982/example
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { token_sort_ratio } from "fuzzball";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("[wp-abstracts] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const args = process.argv.slice(2);
function flagValue(name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const DRY_RUN = args.includes("--dry-run");
const LIMIT = Number.parseInt(flagValue("--limit", "0"), 10) || 0;
const YEAR_MIN = Number.parseInt(flagValue("--year-min", "0"), 10) || 0;
const MODE = String(flagValue("--mode", "all")).toLowerCase();
const CONCURRENCY = Math.max(1, Number.parseInt(flagValue("--concurrency", "3"), 10) || 3);
const TIMEOUT_MS = Math.max(4000, Number.parseInt(flagValue("--timeout-ms", "15000"), 10) || 15000);
const MIN_SCORE = Math.max(80, Number.parseInt(flagValue("--min-score", "96"), 10) || 96);
const EXACT_ONLY = args.includes("--exact-only");
const IDS = String(flagValue("--ids", ""))
  .split(",")
  .map((s) => normDoi(s))
  .filter(Boolean);
const TARGET_VENUES = String(
  flagValue("--venues", "Journal of Econometrics,Econometrica,Journal of Applied Econometrics"),
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!["internal", "openalex", "crossref", "semantic", "external", "all"].includes(MODE)) {
  console.error("[wp-abstracts] --mode must be internal, openalex, crossref, semantic, external, or all");
  process.exit(1);
}

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-working-paper-backfill-${TODAY}.json`);
const OA_EMAIL = process.env.OPENALEX_EMAIL || "horizon-scanner@iadb.org";
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY || "";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is",
  "of", "on", "or", "the", "to", "using", "with", "without", "via", "new", "old",
]);

const WORKING_SOURCE_RE =
  /\b(working paper|working papers|discussion paper|discussion papers|preprint|preprints|nber|ssrn|repec|ideas|econpapers|arxiv|cepr|iza|cesifo|cemfi|cowles|policy research working paper|research paper|staff report)\b/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normDoi(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase() || null;
}

function compactText(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripJats(raw) {
  if (!raw) return null;
  return compactText(
    String(raw)
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function cleanAbstract(raw) {
  let text = stripJats(raw);
  if (!text) return null;
  text = text
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .replace(/\bkeywords?\s*[:.].*$/i, "")
    .replace(/\bjel classification\s*[:.].*$/i, "")
    .trim();
  text = compactText(text);
  return isGoodAbstract(text) ? text : null;
}

function isGoodAbstract(text) {
  const t = compactText(text);
  if (t.length < 160 || t.length > 7000) return false;
  if (t.length <= 260 && /(?:\u2026|\.{3})\s*$/.test(t)) return false;
  if (/^(abstract|summary|keywords|jel)\b[:.\-\s]*$/i.test(t)) return false;
  if (/\b(downloaded from|all rights reserved|copyright|terms and conditions|access denied)\b/i.test(t)) return false;
  if (/\b(journal article|get access|search for other works by this author)\b/i.test(t)) return false;
  if (/\b(list of tables and figures|table of contents|preface to (the )?(first|second|third)?\s*edition|acknowledgements\.?\s+preface)\b/i.test(t)) return false;
  if (/\b(observations and viewpoints expressed are the sole responsibility|preliminary and incomplete)\b/i.test(t)) return false;
  if (/^\s*(?:\d+\.?\s+[A-Z][^.;:]{2,80}\s+){3,}/.test(t)) return false;
  const words = t.split(/\s+/).length;
  return words >= 25;
}

function normalizeTitle(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(raw) {
  const normalized = normalizeTitle(raw);
  return normalized
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function firstAuthorSurname(authors) {
  if (!Array.isArray(authors) || !authors.length) return "";
  const first = authors[0];
  let name = "";
  if (typeof first === "string") name = first;
  else if (first && typeof first === "object") name = first.name || first.display_name || "";
  name = String(name || "").trim();
  if (!name) return "";
  const surname = name.includes(",") ? name.split(",")[0] : name.split(/\s+/).at(-1);
  return String(surname || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function sameFirstAuthor(a, b) {
  const aa = firstAuthorSurname(a);
  const bb = firstAuthorSurname(b);
  return Boolean(aa && bb && aa === bb);
}

function reconstructOpenAlexAbstract(inverted) {
  if (!inverted || typeof inverted !== "object") return null;
  const positions = [];
  for (const [word, list] of Object.entries(inverted)) {
    if (!Array.isArray(list)) continue;
    for (const pos of list) positions.push([pos, word]);
  }
  if (!positions.length) return null;
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, word]) => word).join(" ");
}

function yearOk(target, candidate) {
  if (!target.year || !candidate.year) return true;
  const t = Number(target.year);
  const c = Number(candidate.year);
  if (!Number.isFinite(t) || !Number.isFinite(c)) return true;
  return c <= t && c >= t - 30;
}

function isTargetVenue(venue) {
  const v = String(venue || "").toLowerCase();
  return TARGET_VENUES.some((target) => v === target.toLowerCase());
}

function isParatextTitle(title) {
  return /\b(report of|minutes of|front matter|back matter|table of contents|contents|forthcoming papers|errata|corrigendum|editorial board|index to volume)\b/i.test(String(title || ""));
}

function isWorkingLike(row) {
  const doi = normDoi(row.canonical_doi || row.doi);
  const haystack = [
    row.venue,
    row.source,
    row.source_family,
    row.publication_type,
    row.url,
    row.open_access_pdf_url,
    row.raw_type,
    row.publisher,
  ]
    .filter(Boolean)
    .join(" ");
  if (doi?.startsWith("10.3386/") || doi?.startsWith("10.2139/ssrn")) return true;
  if (["working_paper", "discussion_paper", "preprint"].includes(String(row.publication_type || "").toLowerCase())) return true;
  if (["NBER", "SSRN", "RePEc", "World Bank", "OECD"].includes(String(row.source_family || ""))) return true;
  if (String(row.source || "").toLowerCase() === "repec") return true;
  return WORKING_SOURCE_RE.test(haystack);
}

function normalizeCandidate(row, provider) {
  const abstract = cleanAbstract(row.abstract);
  if (!abstract || !row.title) return null;
  if (isTargetVenue(row.venue) && !isWorkingLike(row)) return null;
  const normTitle = normalizeTitle(row.title);
  const tokens = titleTokens(row.title);
  if (normTitle.length < 12 || tokens.length < 2) return null;
  return {
    id: row.id || row.canonical_doi || row.doi || row.url || `${provider}:${normTitle.slice(0, 60)}`,
    provider,
    title: row.title,
    normTitle,
    tokens,
    year: row.year || null,
    venue: row.venue || null,
    source: row.source || null,
    source_family: row.source_family || null,
    publication_type: row.publication_type || null,
    canonical_doi: normDoi(row.canonical_doi || row.doi),
    authors: row.authors || [],
    url: row.url || null,
    open_access_pdf_url: row.open_access_pdf_url || null,
    abstract,
  };
}

async function selectAll(baseQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await baseQuery.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function loadTargets() {
  const select =
    "id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,url,open_access_pdf_url";
  let query = supabase.from("works").select(select);
  if (IDS.length) {
    query = query.in("canonical_doi", IDS);
  } else {
    query = query.in("venue", TARGET_VENUES).or("abstract.is.null,abstract.eq.");
    if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
  }
  query = query.order("citation_count", { ascending: false, nullsFirst: false });
  const rows = await selectAll(query);
  const targets = rows.filter((row) => !String(row.abstract || "").trim());
  return LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
}

async function loadInternalCandidates() {
  const select =
    "id,title,year,venue,source,source_family,publication_type,canonical_doi,authors,url,open_access_pdf_url,abstract";
  const query = supabase
    .from("works")
    .select(select)
    .not("abstract", "is", null)
    .or(
      "publication_type.in.(working_paper,discussion_paper,preprint,report),source_family.in.(NBER,SSRN,RePEc,World Bank,OECD),source.eq.repec,venue.ilike.%working paper%,venue.ilike.%discussion paper%",
    )
    .order("id", { ascending: true });
  const rows = await selectAll(query);
  return rows
    .map((row) => normalizeCandidate(row, "internal"))
    .filter(Boolean)
    .filter(isWorkingLike);
}

function buildCandidateIndex(candidates) {
  const exact = new Map();
  const byToken = new Map();
  const byId = new Map();
  for (const c of candidates) {
    byId.set(c.id, c);
    if (!exact.has(c.normTitle)) exact.set(c.normTitle, []);
    exact.get(c.normTitle).push(c);
    for (const token of new Set(c.tokens)) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(c.id);
    }
  }
  return { exact, byToken, byId };
}

function candidatePool(target, index) {
  const normTitle = normalizeTitle(target.title);
  const exact = index.exact.get(normTitle) || [];
  if (exact.length) return exact;
  if (EXACT_ONLY) return [];

  const tokens = titleTokens(target.title);
  const lists = tokens
    .map((token) => index.byToken.get(token) || [])
    .filter((list) => list.length > 0)
    .sort((a, b) => a.length - b.length);
  if (!lists.length) return [];

  let ids = new Set(lists[0]);
  for (const list of lists.slice(1, 4)) {
    if (ids.size <= 300) break;
    const next = new Set(list);
    ids = new Set([...ids].filter((id) => next.has(id)));
  }
  if (ids.size > 4000) ids = new Set([...ids].slice(0, 4000));
  return [...ids].map((id) => index.byId.get(id)).filter(Boolean);
}

function scoreCandidate(target, candidate, provider) {
  if (isParatextTitle(target.title)) return null;
  if (!yearOk(target, candidate)) return null;
  const targetDoi = normDoi(target.canonical_doi);
  if (targetDoi && candidate.canonical_doi && targetDoi === candidate.canonical_doi) return null;
  if (!isWorkingLike(candidate)) return null;
  if (isTargetVenue(candidate.venue) && !isWorkingLike(candidate)) return null;

  const targetNorm = normalizeTitle(target.title);
  const exact = targetNorm === candidate.normTitle;
  const score = exact ? 100 : token_sort_ratio(targetNorm, candidate.normTitle);
  const sameAuthor = sameFirstAuthor(target.authors, candidate.authors);
  const candidateWorking = isWorkingLike(candidate);

  let threshold = MIN_SCORE;
  if (sameAuthor && candidateWorking) threshold = Math.min(threshold, 92);
  if (exact && candidateWorking) threshold = 88;
  if (!sameAuthor && !candidateWorking) threshold = Math.max(threshold, 98);
  if (score < threshold) return null;

  return {
    candidate,
    provider,
    titleScore: score,
    exactTitle: exact,
    sameFirstAuthor: sameAuthor,
    workingLike: candidateWorking,
    score: score + (sameAuthor ? 4 : 0) + (candidateWorking ? 3 : 0) + (exact ? 5 : 0),
  };
}

function bestInternalMatch(target, index) {
  const matches = candidatePool(target, index)
    .map((c) => scoreCandidate(target, c, "internal"))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return resolveBest(matches);
}

function resolveBest(matches) {
  if (!matches.length) return null;
  const top = matches[0];
  const second = matches[1];
  if (second && top.score - second.score < 2 && top.candidate.id !== second.candidate.id) {
    return { ambiguous: true, top, second };
  }
  return top;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "HorizonScanner/1.0 (working-paper abstract backfill; mailto:horizon-scanner@iadb.org)",
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) {
    await sleep(5000);
    throw new Error("rate_limited");
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

function openAlexRow(raw) {
  const loc = raw.primary_location || {};
  const src = loc.source || {};
  const oa = raw.open_access || {};
  return {
    id: raw.id,
    title: raw.title || raw.display_name,
    year: raw.publication_year,
    venue: src.display_name,
    source: "openalex",
    source_family: null,
    publication_type: raw.type,
    canonical_doi: normDoi(raw.doi),
    authors: (raw.authorships || []).map((a) => a?.author?.display_name).filter(Boolean),
    url: oa.oa_url || loc.landing_page_url || raw.id,
    open_access_pdf_url: loc.pdf_url || oa.oa_url || null,
    abstract: reconstructOpenAlexAbstract(raw.abstract_inverted_index),
    raw_type: raw.type,
  };
}

async function searchOpenAlex(target) {
  const filters = [];
  if (target.year) {
    filters.push(`from_publication_date:${Number(target.year) - 30}-01-01`);
    filters.push(`to_publication_date:${target.year}-12-31`);
  }
  const params = new URLSearchParams({
    mailto: OA_EMAIL,
    search: target.title,
    per_page: "25",
    select:
      "id,doi,title,abstract_inverted_index,publication_year,authorships,primary_location,open_access,type",
  });
  if (filters.length) params.set("filter", filters.join(","));
  const data = await fetchJson(`https://api.openalex.org/works?${params}`);
  const matches = (data.results || [])
    .map(openAlexRow)
    .map((row) => normalizeCandidate(row, "openalex"))
    .filter(Boolean)
    .filter(isWorkingLike)
    .map((c) => scoreCandidate(target, c, "openalex"))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return resolveBest(matches);
}

function crossrefYear(item) {
  const parts =
    item?.published_print?.["date-parts"] ||
    item?.published_online?.["date-parts"] ||
    item?.issued?.["date-parts"];
  return Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
}

function crossrefRow(item) {
  return {
    id: normDoi(item.DOI) || item.URL,
    title: Array.isArray(item.title) ? item.title[0] : item.title,
    year: crossrefYear(item),
    venue: Array.isArray(item["container-title"]) ? item["container-title"][0] : item["container-title"],
    publisher: item.publisher,
    source: "crossref",
    source_family: null,
    publication_type: item.type,
    canonical_doi: normDoi(item.DOI),
    authors: (item.author || [])
      .map((a) => [a.given, a.family].filter(Boolean).join(" "))
      .filter(Boolean),
    url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
    open_access_pdf_url: null,
    abstract: stripJats(item.abstract),
    raw_type: item.type,
  };
}

async function searchCrossref(target) {
  const params = new URLSearchParams({
    "query.title": target.title,
    rows: "15",
  });
  if (target.year) {
    params.set("filter", `from-pub-date:${Number(target.year) - 30}-01-01,until-pub-date:${target.year}-12-31`);
  }
  const data = await fetchJson(`https://api.crossref.org/works?${params}`);
  const matches = (data.message?.items || [])
    .map(crossrefRow)
    .map((row) => normalizeCandidate(row, "crossref"))
    .filter(Boolean)
    .filter(isWorkingLike)
    .map((c) => scoreCandidate(target, c, "crossref"))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return resolveBest(matches);
}

function semanticRow(item) {
  return {
    id: item.paperId || item.url,
    title: item.title,
    year: item.year,
    venue: item.venue,
    source: "semantic_scholar",
    source_family: null,
    publication_type: Array.isArray(item.publicationTypes) ? item.publicationTypes.join(";") : item.publicationTypes,
    canonical_doi: normDoi(item.externalIds?.DOI),
    authors: (item.authors || []).map((a) => a.name).filter(Boolean),
    url: item.url || null,
    open_access_pdf_url: item.openAccessPdf?.url || null,
    abstract: item.abstract,
    raw_type: Array.isArray(item.publicationTypes) ? item.publicationTypes.join(" ") : item.publicationTypes,
  };
}

async function searchSemantic(target) {
  const params = new URLSearchParams({
    query: target.title,
    limit: "10",
    fields: "title,year,abstract,venue,publicationTypes,externalIds,authors,openAccessPdf,url",
  });
  const headers = S2_KEY ? { "x-api-key": S2_KEY } : {};
  const data = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, headers);
  const matches = (data.data || [])
    .map(semanticRow)
    .map((row) => normalizeCandidate(row, "semantic_scholar"))
    .filter(Boolean)
    .filter(isWorkingLike)
    .map((c) => scoreCandidate(target, c, "semantic_scholar"))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return resolveBest(matches);
}

async function findExternalMatch(target) {
  const providers =
    MODE === "openalex" ? ["openalex"] :
    MODE === "crossref" ? ["crossref"] :
    MODE === "semantic" ? ["semantic"] :
    ["openalex", "crossref", "semantic"];

  const attempts = [];
  for (const provider of providers) {
    try {
      let match = null;
      if (provider === "openalex") match = await searchOpenAlex(target);
      if (provider === "crossref") match = await searchCrossref(target);
      if (provider === "semantic") match = await searchSemantic(target);
      if (match?.ambiguous) {
        attempts.push({ provider, status: "ambiguous", top: summarizeMatch(match.top), second: summarizeMatch(match.second) });
        continue;
      }
      if (match) return { match, attempts };
      attempts.push({ provider, status: "not_found" });
    } catch (err) {
      attempts.push({ provider, status: "error", error: err.message });
      if (err.message === "rate_limited") await sleep(5000);
    }
    await sleep(provider === "semantic" && !S2_KEY ? 1100 : 150);
  }
  return { match: null, attempts };
}

function summarizeMatch(match) {
  if (!match) return null;
  const c = match.candidate;
  return {
    id: c.id,
    provider: c.provider,
    title: c.title,
    year: c.year,
    venue: c.venue,
    doi: c.canonical_doi,
    url: c.url,
    titleScore: match.titleScore,
    sameFirstAuthor: match.sameFirstAuthor,
    workingLike: match.workingLike,
    abstractLength: c.abstract.length,
    abstractPreview: c.abstract.slice(0, 260),
  };
}

function buildRawData(target, match) {
  const c = match.candidate;
  return {
    ...(target.raw_data || {}),
    abstract_backfill: {
      source: "working_paper_match",
      matched_at: new Date().toISOString(),
      provider: c.provider,
      match_score: match.score,
      title_score: match.titleScore,
      exact_title: match.exactTitle,
      same_first_author: match.sameFirstAuthor,
      matched_work: {
        id: c.id,
        title: c.title,
        year: c.year,
        venue: c.venue,
        source: c.source,
        source_family: c.source_family,
        publication_type: c.publication_type,
        canonical_doi: c.canonical_doi,
        url: c.url,
        open_access_pdf_url: c.open_access_pdf_url,
      },
    },
  };
}

async function applyMatch(target, match) {
  if (DRY_RUN) return { status: "would_update" };
  const { error } = await supabase
    .from("works")
    .update({
      abstract: match.candidate.abstract,
      raw_data: buildRawData(target, match),
    })
    .eq("id", target.id);
  if (error) return { status: "update_error", error: error.message };
  return { status: "updated" };
}

async function pMap(items, mapper, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function main() {
  mkdirSync("reports", { recursive: true });
  const targets = await loadTargets();
  console.log(`[wp-abstracts] targets: ${targets.length}`);

  let internalIndex = null;
  if (MODE === "internal" || MODE === "all") {
    const internal = await loadInternalCandidates();
    internalIndex = buildCandidateIndex(internal);
    console.log(`[wp-abstracts] internal candidates: ${internal.length}`);
  }

  const results = [];
  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    mode: MODE,
    limit: LIMIT,
    year_min: YEAR_MIN || null,
    venues: TARGET_VENUES,
    targets: targets.length,
    updated: 0,
    would_update: 0,
    not_found: 0,
    ambiguous: 0,
    update_error: 0,
    by_provider: {},
  };

  await pMap(
    targets,
    async (target, idx) => {
      let match = null;
      const attempts = [];

      if (internalIndex) {
        const internal = bestInternalMatch(target, internalIndex);
        if (internal?.ambiguous) {
          attempts.push({ provider: "internal", status: "ambiguous", top: summarizeMatch(internal.top), second: summarizeMatch(internal.second) });
        } else if (internal) {
          match = internal;
          attempts.push({ provider: "internal", status: "matched" });
        } else {
          attempts.push({ provider: "internal", status: "not_found" });
        }
      }

      if (!match && MODE !== "internal") {
        const external = await findExternalMatch(target);
        match = external.match;
        attempts.push(...external.attempts);
      }

      let result;
      if (!match) {
        const ambiguous = attempts.some((a) => a.status === "ambiguous");
        result = {
          status: ambiguous ? "ambiguous" : "not_found",
          work: { id: target.id, title: target.title, year: target.year, doi: target.canonical_doi, venue: target.venue },
          attempts,
        };
      } else {
        const applied = await applyMatch(target, match);
        result = {
          status: applied.status,
          error: applied.error,
          work: { id: target.id, title: target.title, year: target.year, doi: target.canonical_doi, venue: target.venue },
          match: summarizeMatch(match),
          attempts,
        };
      }

      results[idx] = result;
      summary[result.status] = (summary[result.status] || 0) + 1;
      if (result.match?.provider) {
        summary.by_provider[result.match.provider] = (summary.by_provider[result.match.provider] || 0) + 1;
      }
      if ((idx + 1) % 25 === 0 || idx + 1 === targets.length) {
        process.stdout.write(
          `\r  processed ${idx + 1}/${targets.length} updated=${summary.updated} would=${summary.would_update} not_found=${summary.not_found} ambiguous=${summary.ambiguous}`,
        );
      }
      return result;
    },
    CONCURRENCY,
  );
  process.stdout.write("\n");

  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[wp-abstracts] wrote ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("[wp-abstracts] failed:", err);
  process.exit(1);
});
