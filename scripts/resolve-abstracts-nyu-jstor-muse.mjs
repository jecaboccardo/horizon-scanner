#!/usr/bin/env node
/**
 * Resolve priority missing abstracts through NYU-authenticated JSTOR/MUSE search.
 *
 * This does not rely on stored JSTOR/MUSE URLs. It takes priority missing
 * papers from our DB, searches JSTOR and/or Project MUSE by title in a
 * Playwright browser profile, verifies title similarity, extracts only formal
 * visible abstracts, and records resolver status in works.raw_data.
 *
 * Usage:
 *   node scripts/resolve-abstracts-nyu-jstor-muse.mjs --list-targets --limit 25
 *   node scripts/resolve-abstracts-nyu-jstor-muse.mjs --dry-run --limit 10 --manual-login
 *   node scripts/resolve-abstracts-nyu-jstor-muse.mjs --limit 50 --manual-login --sources jstor,muse
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[nyu-resolver] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
const LIST_TARGETS = process.argv.includes("--list-targets");
const HEADLESS = process.argv.includes("--headless");
const MANUAL_LOGIN = process.argv.includes("--manual-login");
const INCLUDE_GENERIC_TITLES = process.argv.includes("--include-generic-titles");
const RETRY_PRIOR = process.argv.includes("--retry-prior");
const MANUAL_RESULT_SELECT = process.argv.includes("--manual-result-select");
const LIMIT = Number(argValue("--limit", "25"));
const YEAR_MIN = Number(argValue("--year-min", process.env.NYU_RESOLVER_YEAR_MIN || "2020")) || 0;
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", process.env.NYU_RESOLVER_MIN_ABS_RATING || "3")) || 0;
const ORDER_BY = argValue("--order-by", "citation_count");
const SOURCES = String(argValue("--sources", "jstor,muse"))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => ["jstor", "muse"].includes(s));
const PROFILE_DIR = resolve(argValue("--profile-dir", ".playwright-nyu-resolver-profile"));
const LOGIN_URL = argValue("--login-url", process.env.NYU_RESOLVER_LOGIN_URL || "https://globalhome.nyu.edu/services/search/elibrary");
const LOGIN_WAIT_MS = Number(argValue("--login-wait-ms", MANUAL_LOGIN ? "90000" : "15000"));
const VERIFY_WAIT_MS = Number(argValue("--verify-wait-ms", "300000"));
const KEEP_OPEN_MS = Number(argValue("--keep-open-ms", "0")) || 0;
const RESULT_SELECT_WAIT_MS = Number(argValue("--result-select-wait-ms", "180000"));
const TIMEOUT_MS = Number(argValue("--timeout-ms", "45000"));
const SLEEP_MS = Number(argValue("--sleep-ms", "2500"));
const MAX_CANDIDATES = Number(argValue("--max-candidates", "4"));
const MIN_TITLE_SCORE = Number(argValue("--min-title-score", "0.72"));
const MIN_CANDIDATE_SCORE = Number(argValue("--min-candidate-score", "0.42"));
const SEARCH_MODE = argValue("--search-mode", "title-author");
const VENUE_DENYLIST = loadVenueDenylist();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `nyu-jstor-muse-resolver-${TODAY}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isVerificationUrl(url) {
  return /\b(verify|captcha|recaptcha|access-check|accesscheck)\b/i.test(String(url || ""));
}

function isVerificationText(text) {
  return /\b(verify|verification required|captcha|recaptcha|friendly captcha|not a robot|human|access check|unusual traffic)\b/i.test(String(text || ""));
}

function compactText(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDoi(raw) {
  return String(raw || "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase();
}

function normalizeTitle(raw) {
  return compactText(raw)
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|of|and|or|in|on|for|to|with|by|from)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "for", "to", "with", "by", "from",
  "case", "evidence", "analysis", "effects", "effect", "impact", "impacts", "role",
  "does", "how", "what", "using", "based", "study", "studies",
]);

function authorSurname(work) {
  const first = Array.isArray(work.authors) ? work.authors[0] : String(work.authors || "").split(/[;,]/)[0];
  const parts = compactText(first)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : "";
}

function significantTitleTerms(title, maxTerms = 8) {
  return normalizeTitle(title)
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !SEARCH_STOPWORDS.has(term))
    .filter((term, index, arr) => arr.indexOf(term) === index)
    .slice(0, maxTerms);
}

function titleScore(expected, observed) {
  const a = normalizeTitle(expected);
  const b = normalizeTitle(observed);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 30 && (a.includes(b) || b.includes(a))) return 0.95;
  const aTokens = a.split(" ").filter((t) => t.length > 2);
  const bTokens = new Set(b.split(" ").filter((t) => t.length > 2));
  if (!aTokens.length || !bTokens.size) return 0;
  const hits = aTokens.filter((token) => bTokens.has(token)).length;
  const recall = hits / aTokens.length;
  const precision = hits / bTokens.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function cleanAbstract(raw, title = "") {
  const text = compactText(raw)
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .trim();
  if (text.length < 80 || text.length > 8000) return null;
  const lower = text.toLowerCase();
  if (normalizeTitle(text) === normalizeTitle(title)) return null;
  if (/\b(access denied|request blocked|enable cookies|just a moment|captcha|not a robot)\b/i.test(text)) return null;
  if (/\b(your institution does not have access|purchase access|access options|login through your institution)\b/i.test(text)) return null;
  if (/\b(jstor is a digital library|project muse promotes the creation|browse journals and books)\b/i.test(text)) return null;
  return text;
}

function isExcludedNonPrimary(row) {
  return (
    isGenericNonPrimaryTitle(row.title) ||
    row.venue_kind === "commentary" ||
    row.raw_data?.excluded_from_evidence === true ||
    row.raw_data?.excluded_reason === "generic discussion/commentary"
  );
}

function priorStatus(row, source) {
  return row.raw_data?.nyu_resolver?.[source]?.status || null;
}

function shouldTrySource(row, source) {
  if (RETRY_PRIOR) return true;
  return !["not_found", "low_confidence_match", "formal_abstract", "matched_no_abstract", "access_blocked"].includes(priorStatus(row, source));
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
  const select = "id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,url,open_access_pdf_url,abs_rating,publication_type,venue_kind,source,source_family,corpus_source";
  let query = supabase
    .from("works")
    .select(select)
    .or("abstract.is.null,abstract.eq.");
  if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
  if (MIN_ABS_RATING > 0) query = query.in("abs_rating", ["3", "4", "4*"]);
  const orderColumn = ["id", "year", "citation_count"].includes(ORDER_BY) ? ORDER_BY : "citation_count";
  const rows = filterDeniedVenues(
    await selectAll(query.order(orderColumn, { ascending: orderColumn === "id", nullsFirst: false })),
    VENUE_DENYLIST,
  )
    .filter((row) => !String(row.abstract || "").trim())
    .filter((row) => INCLUDE_GENERIC_TITLES || !isExcludedNonPrimary(row))
    .filter((row) => SOURCES.some((source) => shouldTrySource(row, source)));
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

async function launchBrowser() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const options = {
    headless: HEADLESS,
    viewport: { width: 1360, height: 900 },
    ignoreHTTPSErrors: true,
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "msedge" });
  } catch (err) {
    console.warn(`[nyu-resolver] Could not launch Edge channel (${err.message}); trying Chrome channel.`);
    return chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" });
  }
}

async function waitForVerificationIfNeeded(page, label) {
  const text = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (!isVerificationUrl(page.url()) && !isVerificationText(text)) return;
  console.log(`[nyu-resolver] Verification page detected for ${label}. Complete it in the browser; waiting up to ${VERIFY_WAIT_MS}ms...`);
  const started = Date.now();
  while (Date.now() - started < VERIFY_WAIT_MS) {
    await sleep(2000);
    const currentText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
    if (!isVerificationUrl(page.url()) && !isVerificationText(currentText)) {
      await page.waitForTimeout(SLEEP_MS);
      return;
    }
  }
  console.log(`[nyu-resolver] Verification wait expired for ${label}; continuing cautiously.`);
}

function isArticleUrlForSource(source, url) {
  if (source === "jstor") return /jstor\.org\/stable\/[^/?#]+/i.test(String(url || ""));
  if (source === "muse") return /muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i.test(String(url || ""));
  return false;
}

async function waitForManualResultSelection(page, source, work) {
  if (!MANUAL_RESULT_SELECT) return null;
  console.log(`[nyu-resolver] Search page is open for ${source} ${work.id}. Click the correct result in the browser; waiting up to ${RESULT_SELECT_WAIT_MS}ms...`);
  const started = Date.now();
  while (Date.now() - started < RESULT_SELECT_WAIT_MS) {
    await sleep(2000);
    await waitForVerificationIfNeeded(page, `${source} manual result ${work.id}`);
    if (isArticleUrlForSource(source, page.url())) {
      return extractArticlePage(page, source, page.url(), work);
    }
  }
  console.log(`[nyu-resolver] Manual result wait expired for ${source} ${work.id}; falling back to automatic candidates.`);
  return null;
}

function searchQuery(work) {
  const title = compactText(work.title).replace(/\s+/g, " ");
  if (SEARCH_MODE === "title") return title.length > 180 ? title.slice(0, 180) : title;
  const terms = significantTitleTerms(title);
  const surname = authorSurname(work);
  const query = [...terms, ...(surname ? [surname] : [])].join(" ");
  return query || (title.length > 180 ? title.slice(0, 180) : title);
}

function jstorSearchUrl(work) {
  return `https://www.jstor.org/action/doBasicSearch?Query=${encodeURIComponent(searchQuery(work))}`;
}

function museSearchUrl(work) {
  return `https://muse.jhu.edu/search?action=search&query=${encodeURIComponent(searchQuery(work))}`;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

async function collectJstorCandidates(page, work) {
  await page.goto(jstorSearchUrl(work), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForTimeout(SLEEP_MS);
  await waitForVerificationIfNeeded(page, `JSTOR search ${work.id}`);
  const candidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => {
        const container = a.closest("li, article, .search-result, .item, .result, div") || a;
        return {
          url: a.href,
          text: (a.textContent || "").replace(/\s+/g, " ").trim(),
          context: (container.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((a) => /jstor\.org\/stable\/[^/?#]+/i.test(a.url))
      .slice(0, 20);
  });
  return uniqueCandidates(candidates)
    .map((c) => ({ ...c, source: "jstor", linkScore: Math.max(titleScore(work.title, c.text), titleScore(work.title, c.context)) }))
    .sort((a, b) => b.linkScore - a.linkScore)
    .filter((c, index) => index === 0 || c.linkScore >= MIN_CANDIDATE_SCORE)
    .slice(0, MAX_CANDIDATES);
}

async function collectMuseCandidates(page, work) {
  await page.goto(museSearchUrl(work), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForTimeout(SLEEP_MS);
  await waitForVerificationIfNeeded(page, `MUSE search ${work.id}`);
  const candidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => {
        const container = a.closest("li, article, .search-result, .item, .result, div") || a;
        return {
          url: a.href,
          text: (a.textContent || "").replace(/\s+/g, " ").trim(),
          context: (container.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((a) => /muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i.test(a.url))
      .slice(0, 20);
  });
  return uniqueCandidates(candidates)
    .map((c) => ({ ...c, source: "muse", linkScore: Math.max(titleScore(work.title, c.text), titleScore(work.title, c.context)) }))
    .sort((a, b) => b.linkScore - a.linkScore)
    .filter((c, index) => index === 0 || c.linkScore >= MIN_CANDIDATE_SCORE)
    .slice(0, MAX_CANDIDATES);
}

async function extractArticlePage(page, source, url, work) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForTimeout(SLEEP_MS);
  await waitForVerificationIfNeeded(page, `${source} article ${work.id}`);
  if (source === "muse") {
    const body = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
    const movedUrl = body.match(/\bURL Has Changed\b[\s\S]{0,300}?\bhttps:\/\/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i)?.[0]
      ?.match(/https:\/\/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i)?.[0];
    if (movedUrl && movedUrl !== page.url()) {
      await page.goto(movedUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.waitForTimeout(SLEEP_MS);
      await waitForVerificationIfNeeded(page, `${source} moved article ${work.id}`);
    }
  }
  const extracted = await page.evaluate((sourceName) => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const metas = Array.from(document.querySelectorAll("meta")).map((meta) => ({
      key: (meta.getAttribute("name") || meta.getAttribute("property") || "").toLowerCase(),
      content: meta.getAttribute("content") || "",
    }));
    const title =
      document.querySelector("meta[name='citation_title']")?.getAttribute("content") ||
      document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
      document.querySelector("h1")?.innerText ||
      document.title ||
      "";
    const metaKeys = [
      "citation_abstract",
      "dc.description",
      "dcterms.abstract",
      "dcterms.description",
      "description",
      "og:description",
      "twitter:description",
    ];
    for (const key of metaKeys) {
      const hit = metas.find((meta) => meta.key === key && meta.content);
      if (hit) return { title: compact(title), text: compact(hit.content), extractionSource: `meta:${key}`, bodyPreview: "" };
    }
    const selectors = [
      "[class*='abstract' i]",
      "[id*='abstract' i]",
      "section[aria-label*='abstract' i]",
      "div[aria-label*='abstract' i]",
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = compact(node?.innerText || node?.textContent || "");
      if (text) return { title: compact(title), text, extractionSource: `selector:${selector}`, bodyPreview: "" };
    }
    const bodyText = document.body?.innerText || "";
    const stop = sourceName === "jstor"
      ? "Download|Full Text|References|Citation|Article|Notes|Footnotes|Stable URL|Published by|JSTOR is|Keywords"
      : "Keywords|References|Notes|Article|Full Text|PDF|Citation|Issue|Volume";
    const match = bodyText.match(new RegExp(`\\bAbstract\\b\\s*([\\s\\S]{80,5000}?)(?=\\n\\s*(?:${stop})\\b|$)`, "i"));
    return {
      title: compact(title),
      text: compact(match?.[1] || ""),
      extractionSource: match ? "visible_text_abstract" : "none",
      bodyPreview: compact(bodyText).slice(0, 1200),
    };
  }, source);
  const score = titleScore(work.title, extracted.title);
  const abstract = cleanAbstract(extracted.text, work.title);
  return {
    source,
    url,
    finalUrl: page.url(),
    pageTitle: extracted.title,
    titleScore: score,
    abstract,
    extractionSource: extracted.extractionSource,
    bodyPreview: compactText(extracted.bodyPreview || "").slice(0, 900),
  };
}

function statusFromMatch(match) {
  if (!match) return "not_found";
  if (match.titleScore < MIN_TITLE_SCORE) return "low_confidence_match";
  if (match.abstract) return "formal_abstract";
  return "matched_no_abstract";
}

function resolverPatch(work, source, status, details) {
  return {
    ...(work.raw_data || {}),
    nyu_resolver: {
      ...(work.raw_data?.nyu_resolver || {}),
      [source]: {
        status,
        matched_at: new Date().toISOString(),
        query: searchQuery(work),
        title_score: details?.titleScore ?? null,
        page_title: details?.pageTitle ?? null,
        url: details?.url ?? null,
        final_url: details?.finalUrl ?? null,
        extraction_source: details?.extractionSource ?? null,
        body_preview: details?.bodyPreview ?? null,
      },
    },
  };
}

async function applyResult(work, source, status, details) {
  if (DRY_RUN || LIST_TARGETS) return { status: details?.abstract && status === "formal_abstract" ? "would_update" : status };
  const patch = { raw_data: resolverPatch(work, source, status, details) };
  if (details?.abstract && status === "formal_abstract") {
    patch.abstract = details.abstract;
  }
  const { error } = await supabase.from("works").update(patch).eq("id", work.id);
  if (error) return { status: "update_error", error: error.message };
  return { status: details?.abstract && status === "formal_abstract" ? "updated" : status };
}

async function resolveSource(page, source, work) {
  const candidates = source === "jstor"
    ? await collectJstorCandidates(page, work)
    : await collectMuseCandidates(page, work);
  const manual = await waitForManualResultSelection(page, source, work);
  if (manual) return { candidates, best: manual, status: statusFromMatch(manual) };
  if (!candidates.length || candidates[0].linkScore < MIN_CANDIDATE_SCORE) {
    return { candidates, best: null, status: "not_found" };
  }
  let best = null;
  for (const candidate of candidates) {
    const details = await extractArticlePage(page, source, candidate.url, work);
    details.linkText = candidate.text;
    details.linkScore = candidate.linkScore;
    if (!best || details.titleScore > best.titleScore || (details.abstract && !best.abstract)) best = details;
    if (details.titleScore >= MIN_TITLE_SCORE && details.abstract) break;
  }
  return { candidates, best, status: statusFromMatch(best) };
}

async function main() {
  console.log("\n=== NYU JSTOR/MUSE title resolver ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`List targets only: ${LIST_TARGETS}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Sources: ${SOURCES.join(", ")}`);
  console.log(`Retry prior: ${RETRY_PRIOR}`);
  console.log(`Manual result select: ${MANUAL_RESULT_SELECT}`);
  console.log(`Search mode: ${SEARCH_MODE}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Login URL: ${LOGIN_URL}`);
  console.log(`Verification wait: ${VERIFY_WAIT_MS}ms`);
  console.log(`Result select wait: ${RESULT_SELECT_WAIT_MS}ms`);
  console.log(`Keep browser open after run: ${KEEP_OPEN_MS}ms`);
  console.log(`Min title score: ${MIN_TITLE_SCORE}`);
  console.log(`Min candidate score: ${MIN_CANDIDATE_SCORE}`);
  console.log("Only formal visible abstracts are written; no summaries are generated.\n");

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;
  if (LIST_TARGETS) {
    for (const [index, work] of targets.entries()) {
      console.log(`${index + 1}/${targets.length} abs=${work.abs_rating || "?"} year=${work.year || "?"} cites=${work.citation_count || 0} ${work.venue || ""} :: ${work.title?.slice(0, 110) || work.id}`);
    }
    return;
  }

  const context = await launchBrowser();
  const page = await context.newPage();
  if (MANUAL_LOGIN || !HEADLESS) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    console.log(`[nyu-resolver] Browser is open. Log in through NYU/JSTOR/MUSE access if needed; continuing in ${LOGIN_WAIT_MS}ms...`);
    await sleep(LOGIN_WAIT_MS);
  }

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const work = targets[i];
    const perSource = [];
    for (const source of SOURCES) {
      if (!shouldTrySource(work, source)) {
        perSource.push({ source, status: "skipped_prior", prior: priorStatus(work, source) });
        continue;
      }
      try {
        const resolved = await resolveSource(page, source, work);
        const applied = await applyResult(work, source, resolved.status, resolved.best);
        perSource.push({
          source,
          status: applied.status,
          candidates: resolved.candidates.length,
          titleScore: resolved.best?.titleScore ?? null,
          pageTitle: resolved.best?.pageTitle ?? null,
          url: resolved.best?.url ?? null,
          error: applied.error || null,
        });
        if (applied.status === "updated" || applied.status === "would_update") break;
      } catch (err) {
        perSource.push({ source, status: "error", error: err.message });
      }
    }
    results.push({ work, sources: perSource });
    const summary = perSource.map((r) => `${r.source}:${r.status}${r.titleScore != null ? `:${r.titleScore.toFixed(2)}` : ""}`).join(" ");
    console.log(`${i + 1}/${targets.length} ${summary} ${work.year || ""} ${work.venue || ""} :: ${work.title?.slice(0, 90) || work.id}`);
  }
  if (KEEP_OPEN_MS > 0) {
    console.log(`[nyu-resolver] Keeping browser open for ${KEEP_OPEN_MS}ms...`);
    await sleep(KEEP_OPEN_MS);
  }
  await context.close();

  const flat = results.flatMap((result) => result.sources);
  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    limit: LIMIT,
    year_min: YEAR_MIN || null,
    min_abs_rating: MIN_ABS_RATING || null,
    sources: SOURCES,
    targets: targets.length,
    updated: flat.filter((r) => r.status === "updated").length,
    would_update: flat.filter((r) => r.status === "would_update").length,
    formal_abstract: flat.filter((r) => r.status === "formal_abstract").length,
    matched_no_abstract: flat.filter((r) => r.status === "matched_no_abstract").length,
    low_confidence_match: flat.filter((r) => r.status === "low_confidence_match").length,
    not_found: flat.filter((r) => r.status === "not_found").length,
    errors: flat.filter((r) => r.status === "error").length,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[nyu-resolver] failed:", err);
  process.exit(1);
});
