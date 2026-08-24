#!/usr/bin/env node
/**
 * Backfill missing abstracts from landing-page metadata.
 *
 * This is a targeted companion to the DOI API backfills. It reads works with
 * missing abstracts, fetches their url/open_access_pdf_url/DOI landing pages,
 * and extracts embedded metadata such as citation_abstract, dc.description,
 * JSON-LD description, and abstract sections. It intentionally skips PDFs:
 * those need a real PDF text parser rather than brittle byte scraping.
 *
 * Usage:
 *   node scripts/backfill-abstracts-page-metadata.mjs --dry-run --limit 100
 *   node scripts/backfill-abstracts-page-metadata.mjs --limit 1000
 *   node scripts/backfill-abstracts-page-metadata.mjs --venues "Journal of Econometrics,Econometrica,Journal of Applied Econometrics"
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[page-abstracts] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
const LIMIT = Number(argValue("--limit", "1000"));
const SCAN_LIMIT = Number(argValue("--scan-limit", String(Math.max(LIMIT * 5, LIMIT))));
const YEAR_MIN = argValue("--year-min", null);
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", "0")) || 0;
const ORDER_BY = argValue("--order-by", "citation_count");
const PRIORITY_MODE = process.argv.includes("--priority-mode");
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

const CONCURRENCY = Number(argValue("--concurrency", "8"));
const TIMEOUT_MS = Number(argValue("--timeout-ms", "18000"));
const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-page-backfill-${TODAY}.json`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function applyCoreFilters(rows) {
  return filterDeniedVenues(rows, VENUE_DENYLIST)
    .filter((row) => INCLUDE_GENERIC_TITLES || !isExcludedNonPrimary(row))
    .filter((row) => uniqueUrls(row).length > 0);
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
  if (row.open_access_pdf_url) score += 10;
  if (row.url) score += 8;
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

function stripTags(value) {
  return decodeEntities(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAbstract(value, title = "") {
  const text = stripTags(value)
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 80 || text.length > 8000) return null;
  const lower = text.toLowerCase();
  const titleLower = String(title || "").toLowerCase().trim();
  if (titleLower && lower === titleLower) return null;
  if (lower.includes("just a moment") || lower.includes("enable cookies")) return null;
  if (lower.includes("access denied") || lower.includes("request blocked")) return null;
  if (lower.includes("science direct") && lower.includes("shopping cart")) return null;
  if (lower.includes("read the latest articles") || lower.includes("view pdf")) return null;
  if (lower.includes("this site uses cookies")) return null;
  if (lower.includes("repository") && lower.includes("store and provide digital resources")) return null;
  if (lower.includes("scholarly information repository") || lower.includes("institutional repository")) return null;
  if (lower.includes("main purpose is to develop digital collections")) return null;
  if (lower.includes("web") && lower.includes("library") && lower.includes("operates")) return null;
  if (lower.includes("kurenai") || text.includes("\u4eac\u90fd\u5927\u5b66\u5b66\u8853\u60c5\u5831\u30ea\u30dd\u30b8\u30c8\u30ea")) return null;
  if (lower.includes("gratefully acknowledges financial support")) return null;
  if (lower.includes("affiliated to") && lower.includes("financial support")) return null;
  return text;
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

function extractJsonLd(html, title) {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      const parsed = JSON.parse(decodeEntities(body));
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        const candidate = item.abstract || item.description;
        const cleaned = cleanAbstract(Array.isArray(candidate) ? candidate.join(" ") : candidate, title);
        if (cleaned) return { abstract: cleaned, source: "json_ld" };
        for (const value of Object.values(item)) {
          if (Array.isArray(value)) queue.push(...value);
          else if (value && typeof value === "object") queue.push(value);
        }
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return null;
}

function extractMeta(html, title) {
  const priority = [
    "citation_abstract",
    "dc.description",
    "dcterms.abstract",
    "dcterms.description",
    "eprints.abstract",
    "description",
    "og:description",
    "twitter:description",
  ];
  const found = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    const key = (attrs.name || attrs.property || attrs.itemprop || "").toLowerCase();
    const content = attrs.content;
    if (!key || !content) continue;
    if (!found.has(key)) found.set(key, content);
  }
  for (const key of priority) {
    const cleaned = cleanAbstract(found.get(key), title);
    if (cleaned) return { abstract: cleaned, source: `meta:${key}` };
  }
  return null;
}

function extractAbstractSection(html, title) {
  const patterns = [
    /<(section|div|article)[^>]+(?:id|class)=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]{80,6000}?)(?:<\/\1>)/i,
    /<h[1-6][^>]*>\s*abstract\s*<\/h[1-6]>([\s\S]{80,6000}?)(?:<h[1-6]\b|<\/section>|<\/article>|<\/main>)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const body = match?.[2] || match?.[1];
    const cleaned = cleanAbstract(body, title);
    if (cleaned) return { abstract: cleaned, source: "html_abstract_section" };
  }
  return null;
}

function extractFromHtml(html, title) {
  return extractMeta(html, title) || extractJsonLd(html, title) || extractAbstractSection(html, title);
}

function uniqueUrls(work) {
  const urls = [
    work.url,
    work.open_access_pdf_url,
    work.canonical_doi ? `https://doi.org/${work.canonical_doi}` : null,
  ]
    .filter(Boolean)
    .map((url) => String(url).trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "User-Agent": "HorizonScanner/1.0 (abstract metadata backfill; mailto:horizon-scanner@iadb.org)",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) return { ok: false, status: response.status, finalUrl: response.url, reason: "http" };
    if (contentType.includes("application/pdf") || response.url.toLowerCase().endsWith(".pdf")) {
      return { ok: false, status: response.status, finalUrl: response.url, reason: "pdf" };
    }
    const text = await response.text();
    return { ok: true, status: response.status, finalUrl: response.url, text };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, reason: err.name === "AbortError" ? "timeout" : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTargets() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  const targetScan = PRIORITY_MODE ? SCAN_LIMIT : LIMIT;
  while (all.length < targetScan) {
    let query = supabase
      .from("works")
      .select("id,title,year,venue,url,open_access_pdf_url,canonical_doi,citation_count,abs_rating,repec_percentile,source,source_family,corpus_source,publication_type,venue_kind,raw_data");
    if (!ALL_VENUES) query = query.in("venue", VENUES);
    query = missingAbstract(applyAbsRatingFilter(query));
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
  const urls = uniqueUrls(work);
  const attempts = [];
  for (const url of urls) {
    const fetched = await fetchText(url);
    attempts.push({ url, status: fetched.status, finalUrl: fetched.finalUrl, reason: fetched.reason || null });
    if (!fetched.ok) continue;
    const extracted = extractFromHtml(fetched.text, work.title);
    if (!extracted) continue;
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
      abstractPreview: extracted.abstract.slice(0, 240),
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
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));
  process.stdout.write("\n");
  return results;
}

async function main() {
  console.log("\n=== Abstract backfill (landing-page metadata) ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Scan limit: ${PRIORITY_MODE ? SCAN_LIMIT : LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Priority mode: ${PRIORITY_MODE}`);
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
    targets: targets.length,
    updated: results.filter((r) => r?.status === "updated").length,
    would_update: results.filter((r) => r?.status === "would_update").length,
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
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
