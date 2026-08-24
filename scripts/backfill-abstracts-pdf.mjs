#!/usr/bin/env node
/**
 * Backfill missing abstracts by extracting the Abstract/Summary section from
 * open PDFs. PDF candidates come from stored PDF URLs, repository landing-page
 * metadata/links, and optional Unpaywall lookups by DOI.
 *
 * Usage:
 *   node scripts/backfill-abstracts-pdf.mjs --dry-run --limit 100
 *   node scripts/backfill-abstracts-pdf.mjs --limit 1000 --concurrency 4
 *   node scripts/backfill-abstracts-pdf.mjs --include-truncated
 *   node scripts/backfill-abstracts-pdf.mjs --ids 10.1016/example,10.3982/example
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFParse } from "pdf-parse";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[pdf-abstracts] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_TRUNCATED = process.argv.includes("--include-truncated");
const ALLOW_FIRST_PARAGRAPH = process.argv.includes("--allow-first-paragraph");
const USE_UNPAYWALL = !process.argv.includes("--no-unpaywall");
const LIMIT = Number(argValue("--limit", "1000"));
const SCAN_LIMIT = Number(argValue("--scan-limit", String(Math.max(LIMIT * 5, LIMIT))));
const YEAR_MIN = argValue("--year-min", null);
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", "0")) || 0;
const ORDER_BY = argValue("--order-by", "citation_count");
const PRIORITY_MODE = process.argv.includes("--priority-mode");
const CONCURRENCY = Number(argValue("--concurrency", "4"));
const TIMEOUT_MS = Number(argValue("--timeout-ms", "20000"));
const MAX_BYTES = Number(argValue("--max-bytes", String(15 * 1024 * 1024)));
const PDF_PAGES = Number(argValue("--pages", "4"));
const UNPAYWALL_EMAIL = argValue("--unpaywall-email", process.env.UNPAYWALL_EMAIL || "horizon-scanner@iadb.org");
const IDS_FILE = argValue("--ids-file", "");
const STORED_PDF_ONLY = process.argv.includes("--stored-pdf-only");
// --browser: fall back to Playwright (msedge) when plain fetch is blocked by a
// Cloudflare challenge (e.g. IDB publications.iadb.org returns 403/HTML to a
// plain fetch). A real browser clears the JS challenge and downloads the PDF.
const USE_BROWSER = process.argv.includes("--browser");
const BROWSER_PROFILE_DIR = argValue("--profile-dir", ".playwright-pdf-profile");
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const IDS = unique([
  ...String(argValue("--ids", ""))
  .split(",")
  .map((id) => id.trim())
    .filter(Boolean),
  ...loadIdsFile(IDS_FILE),
]);
const ALL_VENUES = process.argv.includes("--all-venues");
const INCLUDE_GENERIC_TITLES = process.argv.includes("--include-generic-titles");
const VENUES = String(argValue(
  "--venues",
  "Journal of Econometrics,Econometrica,Journal of Applied Econometrics",
))
  .split(",")
  .map((venue) => venue.trim())
  .filter(Boolean);
const VENUE_DENYLIST = loadVenueDenylist();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-pdf-backfill-${TODAY}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadIdsFile(path) {
  if (!path) return [];
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.results || [];
  return rows
    .map((row) => row?.id || row?.work?.id)
    .filter(Boolean);
}

function missingAbstract(query) {
  return query.or("abstract.is.null,abstract.eq.");
}

function isExcludedNonPrimary(row) {
  if (!row) return true;
  if (isGenericNonPrimaryTitle(row.title)) return true;
  if (String(row.publication_type || "").toLowerCase() === "other") return true;
  if (String(row.venue_kind || "").toLowerCase() === "commentary") return true;
  const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  return raw.excluded_from_evidence === true || raw.excluded_reason === "generic discussion/commentary";
}

function applyAbsRatingFilter(query) {
  return MIN_ABS_RATING > 0 ? query.in("abs_rating", ["3", "4", "4*"]) : query;
}

function ratingValue(value) {
  if (value === "4*") return 5;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function priorityScore(row) {
  const source = `${row.source_family || ""} ${row.corpus_source || ""} ${row.source || ""} ${row.venue || ""}`.toLowerCase();
  const year = Number(row.year) || 0;
  const citations = Math.max(0, Number(row.citation_count) || 0);
  const abs = ratingValue(row.abs_rating);
  let score = 0;
  if (abs >= 5) score += 60;
  else if (abs === 4) score += 50;
  else if (abs === 3) score += 35;
  const repec = Number(row.repec_percentile);
  if (Number.isFinite(repec)) {
    if (repec >= 95) score += 30;
    else if (repec >= 90) score += 24;
    else if (repec >= 75) score += 16;
  }
  if (/\biadb\b|\bidb\b|world bank|nber|ssrn|iza|cepr|imf|oecd/.test(source)) score += 28;
  if (year >= 2020) score += 22;
  else if (year >= 2010) score += 12;
  else if (year >= 2000) score += 6;
  if (row.open_access_pdf_url) score += 28;
  if (looksPdfUrl(row.url)) score += 18;
  else if (row.url) score += 5;
  if (row.canonical_doi) score += 6;
  score += Math.min(25, Math.log10(citations + 1) * 8);
  return score;
}

function orderTargets(rows) {
  if (!PRIORITY_MODE) return rows;
  return [...rows].sort((a, b) =>
    priorityScore(b) - priorityScore(a) ||
    (Number(b.year) || 0) - (Number(a.year) || 0) ||
    (Number(b.citation_count) || 0) - (Number(a.citation_count) || 0)
  );
}

function applyCoreFilters(rows) {
  return filterDeniedVenues(rows, VENUE_DENYLIST).filter((row) => {
    if (!INCLUDE_GENERIC_TITLES && isExcludedNonPrimary(row)) return false;
    if (STORED_PDF_ONLY && !row.open_access_pdf_url && !looksPdfUrl(row.url)) return false;
    const missing = !String(row.abstract || "").trim();
    return missing || (INCLUDE_TRUNCATED && isTruncatedAbstract(row.abstract));
  });
}

function isTruncatedAbstract(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 220 && /(?:\u2026|\.\.\.)\s*$/.test(text);
}

function looksPdfUrl(url) {
  return /\.pdf(?:$|[?#])|\/pdf(?:$|[?#])|pdfdirect|bitstream|\/download(?:$|[?#/])|servlets\/purl/i.test(String(url || ""));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}

function resolveUrl(base, href) {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return null;
  }
}

function cleanPdfText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function rejectAbstract(text, title = "") {
  if (text.length < 160 || text.length > 5000) return true;
  const lower = text.toLowerCase();
  const titleLower = String(title || "").toLowerCase().trim();
  if (titleLower && lower === titleLower) return true;
  if (lower.includes("all rights reserved") || lower.includes("copyright")) return true;
  if (lower.includes("downloaded from") || lower.includes("terms and conditions")) return true;
  if (lower.includes("this site uses cookies") || lower.includes("access denied")) return true;
  if (lower.includes("repository") && lower.includes("store and provide digital resources")) return true;
  if (lower.includes("scholarly information repository") || lower.includes("institutional repository")) return true;
  if (lower.includes("main purpose is to develop digital collections")) return true;
  if (lower.includes("kurenai") || text.includes("\u4eac\u90fd\u5927\u5b66\u5b66\u8853\u60c5\u5831\u30ea\u30dd\u30b8\u30c8\u30ea")) return true;
  if (lower.includes("gratefully acknowledges financial support")) return true;
  if (lower.includes("temi di discussione series describe preliminary results")) return true;
  if (lower.includes("observations and viewpoints expressed are the sole responsibility")) return true;
  if (/^\s*1\.\s+\S[\s\S]*\b2\.\s+\S[\s\S]*\b3\.\s+\S/.test(text)) return true;
  if (lower.split(/\s+/).filter(Boolean).length < 20) return true;
  return false;
}

function cleanCandidate(value, title) {
  let text = compactText(value)
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .replace(/\b(JEL classification|JEL codes?|Keywords?|Key words?)\b[\s\S]*$/i, "")
    .trim();

  if (rejectAbstract(text, title)) return null;
  return text;
}

function extractAbstractFromPdfText(rawText, title) {
  const text = cleanPdfText(rawText);
  const normalized = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n");

  const boundary = [
    "keywords?",
    "key words?",
    "jel classification",
    "jel codes?",
    "classification",
    "1\\.?\\s+introduction",
    "introduction",
    "i\\.\\s+introduction",
    "acknowledg(?:e)?ments?",
    "references",
    "contents",
  ].join("|");

  const labeledPatterns = [
    new RegExp(`(?:^|\\n)\\s*abstract\\s*[:.\\-]?\\s*\\n?([\\s\\S]{120,5000}?)(?=\\n\\s*(?:${boundary})\\b|\\n\\s*[0-9]+\\.?\\s+[A-Z][^\\n]{0,80}\\n|$)`, "i"),
    new RegExp(`(?:^|\\n)\\s*summary\\s*[:.\\-]?\\s*\\n?([\\s\\S]{120,5000}?)(?=\\n\\s*(?:${boundary})\\b|\\n\\s*[0-9]+\\.?\\s+[A-Z][^\\n]{0,80}\\n|$)`, "i"),
  ];

  for (const pattern of labeledPatterns) {
    const match = normalized.match(pattern);
    const cleaned = cleanCandidate(match?.[1], title);
    if (cleaned) return { abstract: cleaned, source: "pdf_labeled_section" };
  }

  if (!ALLOW_FIRST_PARAGRAPH) return null;

  const firstPageish = normalized.slice(0, 6000);
  const paragraphCandidates = firstPageish
    .split(/\n{2,}|\n(?=(?:This paper|This article|We |The paper|The article|In this paper)\b)/i)
    .map((part) => cleanCandidate(part, title))
    .filter(Boolean)
    .filter((part) => /^(This paper|This article|We |The paper|The article|In this paper|I )/i.test(part));

  const fallback = paragraphCandidates
    .sort((a, b) => Math.abs(900 - a.length) - Math.abs(900 - b.length))[0];
  return fallback ? { abstract: fallback, source: "pdf_first_paragraph" } : null;
}

async function fetchWithTimeout(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/pdf,application/xhtml+xml,*/*;q=0.5",
        "User-Agent": "HorizonScanner/1.0 (abstract PDF backfill; mailto:horizon-scanner@iadb.org)",
        ...headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url) {
  try {
    const response = await fetchWithTimeout(url, { "Accept": "text/html,application/xhtml+xml,*/*;q=0.5" });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("application/pdf")) {
      return { ok: false, status: response.status, finalUrl: response.url, reason: contentType.includes("application/pdf") ? "pdf" : "http" };
    }
    const html = await response.text();
    return { ok: true, status: response.status, finalUrl: response.url, html };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, reason: err.name === "AbortError" ? "timeout" : "fetch_error" };
  }
}

function extractPdfLinksFromHtml(html, baseUrl) {
  const links = [];
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = parseAttributes(tag);
    const key = (attrs.name || attrs.property || attrs.itemprop || "").toLowerCase();
    if (!["citation_pdf_url", "eprints.document_url", "pdf_url"].includes(key)) continue;
    const url = resolveUrl(baseUrl, attrs.content);
    if (url) links.push(url);
  }

  const anchorRe = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const href = match[2] ?? match[3] ?? match[4];
    const resolved = resolveUrl(baseUrl, href);
    if (resolved && looksPdfUrl(resolved)) links.push(resolved);
  }
  return [...new Set(links)];
}

async function unpaywallPdfUrls(doi) {
  if (!USE_UNPAYWALL || !doi) return [];
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;
  try {
    const response = await fetchWithTimeout(url, { "Accept": "application/json" });
    if (!response.ok) return [];
    const json = await response.json();
    const urls = [
      json?.best_oa_location?.url_for_pdf,
      json?.best_oa_location?.url,
      ...(json?.oa_locations || []).flatMap((loc) => [loc?.url_for_pdf, loc?.url]),
    ];
    return [...new Set(urls.filter(Boolean).filter((candidate) => looksPdfUrl(candidate)))];
  } catch {
    return [];
  }
}

async function candidatePdfUrls(work) {
  const direct = [work.open_access_pdf_url, work.url].filter(Boolean).filter((url) => {
    return url === work.open_access_pdf_url || looksPdfUrl(url);
  });

  const discovered = [];
  for (const landing of [
    work.open_access_pdf_url,
    work.url,
    work.canonical_doi ? `https://doi.org/${work.canonical_doi}` : null,
  ].filter(Boolean)) {
    if (looksPdfUrl(landing)) continue;
    const html = await fetchHtml(landing);
    if (html.ok) discovered.push(...extractPdfLinksFromHtml(html.html, html.finalUrl));
  }

  const unpaywall = await unpaywallPdfUrls(work.canonical_doi);
  return [...new Set([...direct, ...discovered, ...unpaywall])];
}

// Lazily-launched Playwright context for Cloudflare-walled hosts (--browser).
let _browserCtx = null;
async function getBrowserCtx() {
  if (_browserCtx) return _browserCtx;
  const { chromium } = await import("playwright-core");
  _browserCtx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false, channel: "msedge", acceptDownloads: true, userAgent: BROWSER_UA,
  });
  return _browserCtx;
}
async function closeBrowserCtx() { if (_browserCtx) { try { await _browserCtx.close(); } catch { /* noop */ } _browserCtx = null; } }

async function fetchPdfViaBrowser(url) {
  const ctx = await getBrowserCtx();
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3500); // let the Cloudflare JS challenge clear (sets cf_clearance)
  } catch { /* PDF viewer/download can abort navigation — the clearance cookie is still set */ }
  const resp = await ctx.request.get(encodeURI(url), { headers: { "User-Agent": BROWSER_UA }, timeout: 45_000 });
  if (!resp.ok()) return { ok: false, status: resp.status(), finalUrl: url, reason: "http_browser" };
  const buffer = Buffer.from(await resp.body());
  if (buffer.length > MAX_BYTES) return { ok: false, status: resp.status(), finalUrl: url, reason: "too_large" };
  if (buffer.slice(0, 4).toString("latin1") !== "%PDF") return { ok: false, status: resp.status(), finalUrl: url, reason: "not_pdf_magic_browser" };
  return { ok: true, status: resp.status(), finalUrl: url, buffer };
}

async function fetchPdfBytes(url) {
  try {
    const response = await fetchWithTimeout(url, { "Accept": "application/pdf,*/*;q=0.5" });
    const contentType = response.headers.get("content-type") || "";
    const size = Number(response.headers.get("content-length") || "0");
    if (!response.ok) {
      if (USE_BROWSER) return await fetchPdfViaBrowser(url);
      return { ok: false, status: response.status, finalUrl: response.url, reason: "http" };
    }
    if (size > MAX_BYTES) return { ok: false, status: response.status, finalUrl: response.url, reason: "too_large" };
    if (!contentType.includes("application/pdf") && !looksPdfUrl(response.url)) {
      if (USE_BROWSER) return await fetchPdfViaBrowser(url);
      return { ok: false, status: response.status, finalUrl: response.url, reason: "not_pdf" };
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_BYTES) return { ok: false, status: response.status, finalUrl: response.url, reason: "too_large" };
    if (buffer.slice(0, 4).toString("latin1") !== "%PDF") {
      if (USE_BROWSER) return await fetchPdfViaBrowser(url);
      return { ok: false, status: response.status, finalUrl: response.url, reason: "not_pdf_magic" };
    }
    return { ok: true, status: response.status, finalUrl: response.url, buffer };
  } catch (err) {
    if (USE_BROWSER) { try { return await fetchPdfViaBrowser(url); } catch { /* fall through */ } }
    return { ok: false, status: 0, finalUrl: url, reason: err.name === "AbortError" ? "timeout" : "fetch_error" };
  }
}

async function parsePdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const pages = Array.from({ length: PDF_PAGES }, (_, index) => index + 1);
    const result = await parser.getText({ partial: pages });
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

async function fetchTargets() {
  if (IDS.length) {
    const rows = [];
    const CHUNK = 100;
    for (let i = 0; i < IDS.length; i += CHUNK) {
      const chunk = IDS.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("works")
        .select("id,title,year,venue,url,open_access_pdf_url,canonical_doi,citation_count,abstract,abs_rating,repec_percentile,source,source_family,corpus_source,publication_type,venue_kind,raw_data")
        .in("id", chunk);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
    }
    return applyCoreFilters(rows).slice(0, LIMIT);
  }

  const all = [];
  let from = 0;
  const PAGE = 1000;
  const targetScan = PRIORITY_MODE ? SCAN_LIMIT : LIMIT;
  while (all.length < targetScan) {
    let query = supabase
      .from("works")
      .select("id,title,year,venue,url,open_access_pdf_url,canonical_doi,citation_count,abstract,abs_rating,repec_percentile,source,source_family,corpus_source,publication_type,venue_kind,raw_data");

    if (!ALL_VENUES) query = query.in("venue", VENUES);
    query = applyAbsRatingFilter(query);
    if (!INCLUDE_TRUNCATED) query = missingAbstract(query);
    if (YEAR_MIN) query = query.gte("year", Number(YEAR_MIN));

    const { data, error } = await query
      .order(ORDER_BY, { ascending: ORDER_BY === "id", nullsFirst: false })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...applyCoreFilters(data));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return orderTargets(all).slice(0, LIMIT);
}

async function processWork(work) {
  const attempts = [];
  const urls = await candidatePdfUrls(work);
  if (!urls.length) return { status: "no_pdf_url", work, attempts };

  for (const url of urls) {
    const fetched = await fetchPdfBytes(url);
    attempts.push({ url, status: fetched.status, finalUrl: fetched.finalUrl, reason: fetched.reason || null });
    if (!fetched.ok) continue;

    let text = "";
    try {
      text = await parsePdfText(fetched.buffer);
    } catch (err) {
      attempts[attempts.length - 1].reason = `parse_error:${err.name || "error"}`;
      continue;
    }

    const extracted = extractAbstractFromPdfText(text, work.title);
    if (!extracted) {
      attempts[attempts.length - 1].reason = "no_abstract_section";
      continue;
    }

    if (!DRY_RUN) {
      const { error } = await supabase.from("works").update({ abstract: extracted.abstract }).eq("id", work.id);
      if (error) return { status: "update_error", work, attempts, error: error.message };
    }

    return {
      status: DRY_RUN ? "would_update" : "updated",
      work,
      url,
      finalUrl: fetched.finalUrl,
      source: extracted.source,
      abstractLength: extracted.abstract.length,
      abstractPreview: extracted.abstract.slice(0, 280),
      attempts,
    };
  }

  return { status: "not_found", work, attempts };
}

async function runPool(items, workerFn) {
  let cursor = 0;
  const results = [];
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      const result = await workerFn(items[index]);
      results[index] = result;
      const done = results.filter(Boolean).length;
      const updated = results.filter((r) => r?.status === "updated" || r?.status === "would_update").length;
      process.stdout.write(`\r  processed ${done}/${items.length} | found ${updated}`);
      await sleep(100);
    }
  }
  // --browser shares one persistent page → must run sequentially.
  const effConcurrency = USE_BROWSER ? 1 : Math.max(1, CONCURRENCY);
  await Promise.all(Array.from({ length: effConcurrency }, () => worker()));
  process.stdout.write("\n");
  return results;
}

async function main() {
  console.log("\n=== Abstract backfill (PDF extraction) ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Scan limit: ${PRIORITY_MODE ? SCAN_LIMIT : LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Priority mode: ${PRIORITY_MODE}`);
  console.log(`Include truncated: ${INCLUDE_TRUNCATED}`);
  console.log(`Allow first paragraph fallback: ${ALLOW_FIRST_PARAGRAPH}`);
  console.log(`Unpaywall: ${USE_UNPAYWALL}`);
  if (IDS.length) console.log(`IDs: ${IDS.length}`);
  if (IDS_FILE) console.log(`IDs file: ${IDS_FILE}`);
  if (STORED_PDF_ONLY) console.log("Stored PDF URLs only: true");
  console.log(`Venues: ${ALL_VENUES ? "(all)" : VENUES.join(", ")}`);
  console.log(`Exclude generic/commentary: ${!INCLUDE_GENERIC_TITLES}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  const targets = await fetchTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;

  const results = await runPool(targets, processWork);
  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    limit: LIMIT,
    scan_limit: PRIORITY_MODE ? SCAN_LIMIT : LIMIT,
    priority_mode: PRIORITY_MODE,
    year_min: YEAR_MIN ? Number(YEAR_MIN) : null,
    min_abs_rating: MIN_ABS_RATING || null,
    venues: ALL_VENUES ? [] : VENUES,
    all_venues: ALL_VENUES,
    exclude_generic_commentary: !INCLUDE_GENERIC_TITLES,
    include_truncated: INCLUDE_TRUNCATED,
    allow_first_paragraph: ALLOW_FIRST_PARAGRAPH,
    ids: IDS,
    ids_file: IDS_FILE || null,
    stored_pdf_only: STORED_PDF_ONLY,
    targets: targets.length,
    updated: results.filter((r) => r?.status === "updated").length,
    would_update: results.filter((r) => r?.status === "would_update").length,
    no_pdf_url: results.filter((r) => r?.status === "no_pdf_url").length,
    not_found: results.filter((r) => r?.status === "not_found").length,
    update_error: results.filter((r) => r?.status === "update_error").length,
    by_source: Object.fromEntries(
      [...results.reduce((map, r) => {
        if (r?.source) map.set(r.source, (map.get(r.source) || 0) + 1);
        return map;
      }, new Map()).entries()].sort((a, b) => b[1] - a[1]),
    ),
  };

  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
  await closeBrowserCtx();
}

main().catch(async (err) => {
  console.error("Fatal:", err.message);
  await closeBrowserCtx();
  process.exit(1);
});
