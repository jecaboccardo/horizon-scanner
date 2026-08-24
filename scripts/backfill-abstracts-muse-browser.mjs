#!/usr/bin/env node
/**
 * Backfill Project MUSE missing abstracts through an authenticated browser session.
 *
 * This opens a persistent Playwright browser profile so you can authenticate
 * through NYU/Project MUSE manually, then extracts formal abstracts visible on
 * MUSE landing pages. It does not download PDFs and does not generate summaries.
 *
 * Usage:
 *   node scripts/backfill-abstracts-muse-browser.mjs --dry-run --limit 10 --manual-login
 *   node scripts/backfill-abstracts-muse-browser.mjs --dry-run --ids 10.1353/example.2024.a123456
 *   node scripts/backfill-abstracts-muse-browser.mjs --list-targets --limit 50
 *   node scripts/backfill-abstracts-muse-browser.mjs --limit 25 --manual-login --login-url "https://globalhome.nyu.edu/services/search/elibrary"
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[muse-browser] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
const MARK_FROM_REPORT = process.argv.includes("--mark-from-report");
const HEADLESS = process.argv.includes("--headless");
const MANUAL_LOGIN = process.argv.includes("--manual-login");
const INCLUDE_GENERIC_TITLES = process.argv.includes("--include-generic-titles");
const LIMIT = Number(argValue("--limit", "25"));
const YEAR_MIN = Number(argValue("--year-min", process.env.MUSE_YEAR_MIN || "2010")) || 0;
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", process.env.MUSE_MIN_ABS_RATING || "3")) || 0;
const JOURNAL_ONLY = !process.argv.includes("--all-publication-types");
const ORDER_BY = argValue("--order-by", "priority");
const PROFILE_DIR = resolve(argValue("--profile-dir", ".playwright-muse-profile"));
const LOGIN_URL = argValue("--login-url", process.env.MUSE_LOGIN_URL || "https://globalhome.nyu.edu/services/search/elibrary");
const LOGIN_WAIT_MS = Number(argValue("--login-wait-ms", MANUAL_LOGIN ? "90000" : "15000"));
const TIMEOUT_MS = Number(argValue("--timeout-ms", "45000"));
const SLEEP_MS = Number(argValue("--sleep-ms", process.env.MUSE_SLEEP_MS || "5000")) || 5000;
const VERIFY_WAIT_MS = Number(argValue("--verify-wait-ms", process.env.MUSE_VERIFY_WAIT_MS || (HEADLESS ? "0" : "120000"))) || 0;
const IDS = String(argValue("--ids", ""))
  .split(",")
  .map((s) => normDoi(s))
  .filter(Boolean);
const VENUE_DENYLIST = loadVenueDenylist();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-muse-browser-backfill-${TODAY}.json`);
const INPUT_REPORT_PATH = argValue("--report", REPORT_PATH);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isVerificationText(text) {
  return /\b(verification required|friendly captcha)\b/i.test(text || "");
}

function normDoi(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase();
}

function compactText(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAbstract(raw, title = "") {
  const text = compactText(raw)
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .trim();
  if (text.length < 80 || text.length > 8000) return null;
  const lower = text.toLowerCase();
  const titleLower = compactText(title).toLowerCase();
  if (titleLower && lower === titleLower) return null;
  if (/\b(access denied|request blocked|enable cookies|just a moment|captcha|not a robot)\b/i.test(text)) return null;
  if (/\b(your institution does not have access|purchase access|access options|login through your institution)\b/i.test(text)) return null;
  if (/\b(project muse promotes the creation|browse journals and books|about project muse)\b/i.test(text)) return null;
  return text;
}

function normalizeTitle(raw) {
  return compactText(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(raw) {
  return normalizeTitle(raw)
    .split(" ")
    .filter((token) => token.length > 3);
}

function titleMatches(expected, observed) {
  const expectedTokens = titleTokens(expected);
  const observedTokens = new Set(titleTokens(observed));
  if (!expectedTokens.length || !observedTokens.size) return true;
  const hits = expectedTokens.filter((token) => observedTokens.has(token)).length;
  return hits / expectedTokens.length >= 0.5;
}

function articleUrlFor(work) {
  const urls = [work.url, work.open_access_pdf_url].filter(Boolean).map(String);
  for (const raw of urls) {
    const url = raw.replace(/\/pdf(?:[?#].*)?$/i, "");
    if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i.test(url)) return url;
  }
  const doi = normDoi(work.canonical_doi);
  const articleId = doi.match(/\.a(\d+)$/i)?.[1];
  if (doi.startsWith("10.1353/") && articleId) return `https://muse.jhu.edu/article/${articleId}`;
  return urls.find((url) => /muse\.jhu\.edu/i.test(url)) || (doi ? `https://doi.org/${doi}` : null);
}

function looksMuse(work) {
  const hay = `${work.url || ""} ${work.open_access_pdf_url || ""} ${work.venue || ""}`.toLowerCase();
  const doi = normDoi(work.canonical_doi);
  return hay.includes("muse.jhu.edu") || hay.includes("project muse") || doi.startsWith("10.1353/");
}

function priorMuseAttemptStatus(work) {
  return work.raw_data?.abstract_backfill?.source === "project_muse_browser_formal_abstract"
    ? work.raw_data?.abstract_backfill?.status
    : null;
}

function isGenericNonArticleTitle(title) {
  return isGenericNonPrimaryTitle(title);
}

function ratingValue(value) {
  const text = String(value || "").trim();
  if (text === "4*") return 4.5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExcludedNonPrimary(row) {
  return (
    isGenericNonArticleTitle(row.title) ||
    row.venue_kind === "commentary" ||
    row.raw_data?.excluded_from_evidence === true ||
    row.raw_data?.excluded_reason === "generic discussion/commentary"
  );
}

function isJournal(row) {
  return row.venue_kind === "journal" || row.publication_type === "journal_article";
}

function prioritySort(a, b) {
  if (ORDER_BY !== "priority") return 0;
  return (
    ratingValue(b.abs_rating) - ratingValue(a.abs_rating) ||
    Number(b.year || 0) - Number(a.year || 0) ||
    Number(b.citation_count || 0) - Number(a.citation_count || 0) ||
    String(a.id).localeCompare(String(b.id))
  );
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
  const select = "id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,url,open_access_pdf_url,abs_rating,publication_type,venue_kind";
  const buildBaseQuery = () => {
    let query = supabase.from("works").select(select);
    if (IDS.length) return query.in("canonical_doi", IDS);
    query = query.or("abstract.is.null,abstract.eq.");
    if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
    if (MIN_ABS_RATING > 0) query = query.in("abs_rating", ["3", "4", "4*"]);
    if (JOURNAL_ONLY) query = query.or("venue_kind.eq.journal,publication_type.eq.journal_article");
    return query;
  };
  const queryOrder = ORDER_BY === "priority" ? "citation_count" : ORDER_BY;
  const ordered = (query) => query.order(queryOrder, { ascending: queryOrder === "id", nullsFirst: false });
  const candidateRows = IDS.length
    ? await selectAll(ordered(buildBaseQuery()))
    : [
        ...(await selectAll(ordered(buildBaseQuery().ilike("canonical_doi", "10.1353/%")))),
        ...(await selectAll(ordered(buildBaseQuery().or("url.ilike.%muse.jhu.edu%,open_access_pdf_url.ilike.%muse.jhu.edu%,venue.ilike.%Project MUSE%")))),
      ];
  const uniqueRows = [...new Map(candidateRows.map((row) => [row.id, row])).values()];
  const rows = filterDeniedVenues(uniqueRows, VENUE_DENYLIST)
    .filter((row) => !String(row.abstract || "").trim())
    .filter(looksMuse)
    .filter((row) => !isExcludedNonPrimary(row))
    .filter((row) => !["pdf_only", "not_found"].includes(priorMuseAttemptStatus(row)))
    .filter((row) => MIN_ABS_RATING <= 0 || ratingValue(row.abs_rating) >= MIN_ABS_RATING)
    .filter((row) => !JOURNAL_ONLY || isJournal(row))
    .filter((row) => INCLUDE_GENERIC_TITLES || !isGenericNonArticleTitle(row.title))
    .map((row) => ({ ...row, muse_url: articleUrlFor(row) }))
    .filter((row) => row.muse_url)
    .sort(prioritySort);
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
    console.warn(`[muse-browser] Could not launch Edge channel (${err.message}); trying Chrome channel.`);
    return chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" });
  }
}

async function extractFromMusePage(page, work) {
  await page.goto(work.muse_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForTimeout(SLEEP_MS);
  if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(page.url())) {
    await page.goto(page.url().replace(/\/pdf(?:[?#].*)?$/i, ""), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(SLEEP_MS);
  }
  const initialText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  const movedUrl = initialText.match(/\bURL Has Changed\b[\s\S]{0,300}?\bhttps:\/\/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i)?.[0]
    ?.match(/https:\/\/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i)?.[0];
  if (movedUrl && movedUrl !== page.url()) {
    await page.goto(movedUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(SLEEP_MS);
    if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(page.url())) {
      await page.goto(page.url().replace(/\/pdf(?:[?#].*)?$/i, ""), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.waitForTimeout(SLEEP_MS);
    }
  }
  const verifyText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (VERIFY_WAIT_MS > 0 && isVerificationText(verifyText)) {
    console.log(`[muse-browser] Verification page is open for ${work.id}; complete it in the browser. Waiting up to ${VERIFY_WAIT_MS}ms for the article page...`);
    const started = Date.now();
    while (Date.now() - started < VERIFY_WAIT_MS) {
      await sleep(2000);
      const currentText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
      if (!isVerificationText(currentText)) break;
    }
    await page.waitForTimeout(SLEEP_MS);
    if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(page.url())) {
      await page.goto(page.url().replace(/\/pdf(?:[?#].*)?$/i, ""), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.waitForTimeout(SLEEP_MS);
    }
  }
  if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(page.url())) {
    return {
      kind: "pdf_only",
      source: "muse_pdf_redirect",
      pageTitle: "",
      finalUrl: page.url(),
      pageText: "",
      note: "Project MUSE redirected to PDF-only access; no visible HTML abstract was available without PDF extraction.",
    };
  }
  const extracted = await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const metas = Array.from(document.querySelectorAll("meta")).map((meta) => ({
      key: (meta.getAttribute("name") || meta.getAttribute("property") || "").toLowerCase(),
      content: meta.getAttribute("content") || "",
    }));
    const metaKeys = [
      "citation_abstract",
      "dc.description",
      "dcterms.abstract",
      "dcterms.description",
      "description",
      "og:description",
      "twitter:description",
    ];
    const title =
      document.querySelector("meta[name='citation_title']")?.getAttribute("content") ||
      document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
      document.querySelector("h1")?.innerText ||
      document.title ||
      "";
    for (const key of metaKeys) {
      const hit = metas.find((meta) => meta.key === key && meta.content);
      if (hit) return { text: compact(hit.content), source: `meta:${key}`, title: compact(title) };
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
      if (text) return { text, source: `selector:${selector}`, title: compact(title) };
    }

    const bodyText = document.body?.innerText || "";
    const match = bodyText.match(/\bAbstract\b\s*([\s\S]{80,4000}?)(?=\n\s*(?:Keywords|References|Notes|Article|Full Text|PDF|Citation|Issue|Volume)\b|$)/i);
    return match ? { text: compact(match[1]), source: "visible_text_abstract", title: compact(title) } : { text: "", source: "none", title: compact(title) };
  });
  const abstract = cleanAbstract(extracted.text, work.title);
  const bodyPreview = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (!abstract || !titleMatches(work.title, extracted.title)) {
    return {
      kind: "not_found",
      source: extracted.source,
      pageTitle: extracted.title,
      finalUrl: page.url(),
      pageText: compactText(bodyPreview).slice(0, 1200),
      note: !abstract
        ? "No usable formal Project MUSE abstract was visible in the browser session."
        : "Project MUSE page title did not match the target work title.",
    };
  }
  return {
    kind: "formal_abstract",
    abstract,
    source: extracted.source,
    pageTitle: extracted.title,
    finalUrl: page.url(),
    pageText: compactText(bodyPreview).slice(0, 1200),
    note: "Formal abstract extracted from Project MUSE article page.",
  };
}

function rawDataFor(work, extracted) {
  return {
    ...(work.raw_data || {}),
    abstract_backfill: {
      source: "project_muse_browser_formal_abstract",
      status: extracted.kind,
      matched_at: new Date().toISOString(),
      provenance_note: extracted.note,
      muse_url: work.muse_url,
      final_url: extracted.finalUrl || null,
      extraction_source: extracted.source,
      page_title: extracted.pageTitle || null,
      page_text_preview: compactText(extracted.pageText || "").slice(0, 900),
    },
  };
}

async function apply(work, extracted) {
  if (DRY_RUN) return { status: "would_update", work, extracted };
  if (!extracted.abstract) {
    const { error } = await supabase
      .from("works")
      .update({ raw_data: rawDataFor(work, extracted) })
      .eq("id", work.id);
    if (error) return { status: "update_error", work, extracted, error: error.message };
    return { status: extracted.kind || "not_found", work, extracted };
  }
  const { error } = await supabase
    .from("works")
    .update({ abstract: extracted.abstract, raw_data: rawDataFor(work, extracted) })
    .eq("id", work.id);
  if (error) return { status: "update_error", work, extracted, error: error.message };
  return { status: "updated", work, extracted };
}

async function markPdfOnlyFromReport() {
  const report = JSON.parse(readFileSync(INPUT_REPORT_PATH, "utf8"));
  const candidates = (report.results || []).filter((result) =>
    !result.extracted?.abstract &&
    /muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(result.extracted?.finalUrl || "")
  );
  console.log(`[muse-browser] PDF-only candidates from report: ${candidates.length}`);
  let updated = 0;
  for (const result of candidates) {
    const extracted = {
      ...(result.extracted || {}),
      kind: "pdf_only",
      source: result.extracted?.source || "muse_pdf_redirect",
      note: "Project MUSE redirected to PDF-only access; no visible HTML abstract was available without PDF extraction.",
    };
    if (DRY_RUN) {
      console.log(`[muse-browser] would mark pdf_only ${result.work?.id}`);
      continue;
    }
    const { error } = await supabase
      .from("works")
      .update({ raw_data: rawDataFor(result.work, extracted) })
      .eq("id", result.work.id);
    if (error) throw new Error(`mark pdf_only ${result.work.id}: ${error.message}`);
    updated += 1;
    console.log(`[muse-browser] marked pdf_only ${result.work.id}`);
  }
  console.log(JSON.stringify({ report: INPUT_REPORT_PATH, pdf_only_candidates: candidates.length, updated }, null, 2));
}

async function main() {
  console.log("\n=== Project MUSE browser abstract backfill ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`List targets only: ${LIST_TARGETS}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Journal only: ${JOURNAL_ONLY}`);
  console.log(`Order by: ${ORDER_BY}`);
  console.log(`Include generic titles: ${INCLUDE_GENERIC_TITLES}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Login URL: ${LOGIN_URL || "(first MUSE target)"}`);
  console.log(`Per-page sleep: ${SLEEP_MS}ms`);
  console.log(`Verification wait: ${VERIFY_WAIT_MS}ms`);
  console.log("No PDF downloads; only formal visible abstracts are used.\n");

  if (MARK_FROM_REPORT) {
    await markPdfOnlyFromReport();
    return;
  }

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;

  if (LIST_TARGETS) {
    for (const [index, work] of targets.entries()) {
      console.log(
        `${index + 1}/${targets.length} abs=${work.abs_rating || "?"} year=${work.year || "?"} cites=${work.citation_count || 0} ${work.venue || ""} :: ${work.title?.slice(0, 100) || work.id}`,
      );
    }
    mkdirSync("reports", { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify({
      summary: {
        generated_at: new Date().toISOString(),
        list_targets: true,
        limit: LIMIT,
        year_min: YEAR_MIN || null,
        min_abs_rating: MIN_ABS_RATING || null,
        journal_only: JOURNAL_ONLY,
        order_by: ORDER_BY,
        targets: targets.length,
      },
      targets,
    }, null, 2));
    console.log(JSON.stringify({ targets: targets.length, report: REPORT_PATH }, null, 2));
    return;
  }

  const context = await launchBrowser();
  const page = await context.newPage();
  if (MANUAL_LOGIN || !HEADLESS) {
    await page.goto(LOGIN_URL || targets[0].muse_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    console.log(`[muse-browser] Browser is open. Log in through NYU/Project MUSE institutional access if needed; continuing in ${LOGIN_WAIT_MS}ms...`);
    await sleep(LOGIN_WAIT_MS);
  }

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const work = targets[i];
    try {
      const extracted = await extractFromMusePage(page, work);
      const result = await apply(work, extracted);
      results.push(result);
      console.log(`${i + 1}/${targets.length} ${result.status} ${work.year || ""} ${work.venue || ""} :: ${work.title?.slice(0, 90) || work.id}`);
    } catch (err) {
      results.push({ status: "error", work, error: err.message });
      console.log(`${i + 1}/${targets.length} error ${work.title?.slice(0, 90) || work.id}: ${err.message}`);
    }
  }
  await context.close();

  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    limit: LIMIT,
    year_min: YEAR_MIN || null,
    min_abs_rating: MIN_ABS_RATING || null,
    journal_only: JOURNAL_ONLY,
    order_by: ORDER_BY,
    targets: targets.length,
    updated: results.filter((r) => r.status === "updated").length,
    would_update: results.filter((r) => r.status === "would_update").length,
    formal_abstracts: results.filter((r) => r.extracted?.kind === "formal_abstract").length,
    not_found: results.filter((r) => r.status === "not_found").length,
    pdf_only: results.filter((r) => r.status === "pdf_only").length,
    update_error: results.filter((r) => r.status === "update_error").length,
    errors: results.filter((r) => r.status === "error").length,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[muse-browser] failed:", err);
  process.exit(1);
});
