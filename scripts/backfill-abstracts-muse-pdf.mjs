#!/usr/bin/env node
/**
 * Backfill missing abstracts from authenticated Project MUSE PDFs.
 *
 * This is a narrow fallback for MUSE rows where the HTML page did not expose a
 * formal abstract and MUSE redirected to a PDF. It uses a persistent Playwright
 * profile for NYU/MUSE access, parses only early PDF pages, and only writes a
 * labeled Abstract/Summary section. It does not generate summaries.
 *
 * Usage:
 *   node scripts/backfill-abstracts-muse-pdf.mjs --dry-run --limit 10 --manual-login
 *   node scripts/backfill-abstracts-muse-pdf.mjs --ids 10.1353/jhr.2009.0008,10.1353/jhr.2010.0003 --manual-login
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PDFParse } from "pdf-parse";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[muse-pdf] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
const INCLUDE_TEXT_PREVIEW = process.argv.includes("--include-text-preview");
const LIMIT = Number(argValue("--limit", "25"));
const YEAR_MIN = Number(argValue("--year-min", process.env.MUSE_YEAR_MIN || "2010")) || 0;
const MIN_ABS_RATING = Number(argValue("--min-abs-rating", process.env.MUSE_MIN_ABS_RATING || "3")) || 0;
const JOURNAL_ONLY = !process.argv.includes("--all-publication-types");
const PROFILE_DIR = resolve(argValue("--profile-dir", ".playwright-muse-profile"));
const LOGIN_URL = argValue("--login-url", process.env.MUSE_LOGIN_URL || "https://globalhome.nyu.edu/services/search/elibrary");
const LOGIN_WAIT_MS = Number(argValue("--login-wait-ms", MANUAL_LOGIN ? "90000" : "15000"));
const VERIFY_WAIT_MS = Number(argValue("--verify-wait-ms", process.env.MUSE_VERIFY_WAIT_MS || (HEADLESS ? "0" : "120000"))) || 0;
const TIMEOUT_MS = Number(argValue("--timeout-ms", "45000"));
const PDF_PAGES = Number(argValue("--pages", "4"));
const MAX_BYTES = Number(argValue("--max-bytes", String(20 * 1024 * 1024)));
const IDS = String(argValue("--ids", ""))
  .split(",")
  .map((s) => normDoi(s))
  .filter(Boolean);
const VENUE_DENYLIST = loadVenueDenylist();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-muse-pdf-backfill-${TODAY}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normDoi(raw) {
  return String(raw || "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim()
    .toLowerCase();
}

function compactText(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
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

function ratingValue(value) {
  const text = String(value || "").trim();
  if (text === "4*") return 4.5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExcludedNonPrimary(row) {
  return (
    isGenericNonPrimaryTitle(row.title) ||
    row.venue_kind === "commentary" ||
    row.raw_data?.excluded_from_evidence === true ||
    row.raw_data?.excluded_reason === "generic discussion/commentary"
  );
}

function isJournal(row) {
  return row.venue_kind === "journal" || row.publication_type === "journal_article";
}

function looksMuse(row) {
  const hay = `${row.url || ""} ${row.open_access_pdf_url || ""} ${row.venue || ""}`.toLowerCase();
  const doi = normDoi(row.canonical_doi || row.id);
  return doi.startsWith("10.1353/") || hay.includes("muse.jhu.edu") || hay.includes("project muse");
}

function priorPdfUrl(row) {
  const finalUrl = row.raw_data?.abstract_backfill?.final_url;
  if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(finalUrl || "")) return finalUrl;
  return null;
}

function doiUrl(row) {
  const doi = normDoi(row.canonical_doi || row.id);
  return doi ? `https://doi.org/${doi}` : null;
}

function candidateStartUrl(row) {
  return priorPdfUrl(row) || row.open_access_pdf_url || doiUrl(row) || row.url;
}

function pdfUrlFromCurrent(url) {
  if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(url || "")) return url;
  if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+(?:[?#].*)?$/i.test(url || "")) {
    return String(url).replace(/([?#].*)?$/, "/pdf");
  }
  return null;
}

function cleanCandidate(value, title) {
  const text = compactText(value)
    .replace(/^\s*(abstract|summary)\s*[:.\-]?\s*/i, "")
    .replace(/\b(JEL classification|JEL codes?|Keywords?|Key words?)\b[\s\S]*$/i, "")
    .trim();
  if (text.length < 120 || text.length > 5000) return null;
  const lower = text.toLowerCase();
  const titleLower = compactText(title).toLowerCase();
  if (titleLower && lower === titleLower) return null;
  if (/\b(downloaded from|terms and conditions|all rights reserved|copyright|access denied)\b/i.test(text)) return null;
  if (lower.split(/\s+/).filter(Boolean).length < 20) return null;
  return text;
}

function extractAbstractFromPdfText(rawText, title) {
  const normalized = cleanPdfText(rawText)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n");
  const boundary = [
    "keywords?",
    "key words?",
    "jel classification",
    "jel codes?",
    "1\\.?\\s+introduction",
    "introduction",
    "i\\.\\s+introduction",
    "references",
    "notes",
  ].join("|");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*abstract\\s*[:.\\-]?\\s*\\n?([\\s\\S]{100,5000}?)(?=\\n\\s*(?:${boundary})\\b|\\n\\s*[0-9]+\\.?\\s+[A-Z][^\\n]{0,80}\\n|$)`, "i"),
    new RegExp(`(?:^|\\n)\\s*summary\\s*[:.\\-]?\\s*\\n?([\\s\\S]{100,5000}?)(?=\\n\\s*(?:${boundary})\\b|\\n\\s*[0-9]+\\.?\\s+[A-Z][^\\n]{0,80}\\n|$)`, "i"),
  ];
  for (const pattern of patterns) {
    const cleaned = cleanCandidate(normalized.match(pattern)?.[1], title);
    if (cleaned) return { abstract: cleaned, source: "muse_pdf_labeled_section" };
  }
  return null;
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
  let query = supabase.from("works").select(select).or("abstract.is.null,abstract.eq.");
  if (IDS.length) query = supabase.from("works").select(select).in("canonical_doi", IDS);
  else {
    if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
    if (MIN_ABS_RATING > 0) query = query.in("abs_rating", ["3", "4", "4*"]);
    if (JOURNAL_ONLY) query = query.or("venue_kind.eq.journal,publication_type.eq.journal_article");
  }

  const rows = filterDeniedVenues(await selectAll(query.order("citation_count", { ascending: false, nullsFirst: false })), VENUE_DENYLIST)
    .filter((row) => !String(row.abstract || "").trim())
    .filter((row) => !isExcludedNonPrimary(row))
    .filter(looksMuse)
    .filter((row) => IDS.length || row.raw_data?.abstract_backfill?.status === "pdf_only" || priorPdfUrl(row))
    .filter((row) => MIN_ABS_RATING <= 0 || ratingValue(row.abs_rating) >= MIN_ABS_RATING)
    .filter((row) => !JOURNAL_ONLY || isJournal(row))
    .map((row) => ({ ...row, muse_pdf_start_url: candidateStartUrl(row) }))
    .filter((row) => row.muse_pdf_start_url)
    .sort((a, b) =>
      ratingValue(b.abs_rating) - ratingValue(a.abs_rating) ||
      Number(b.year || 0) - Number(a.year || 0) ||
      Number(b.citation_count || 0) - Number(a.citation_count || 0),
    );
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
    console.warn(`[muse-pdf] Could not launch Edge channel (${err.message}); trying Chrome channel.`);
    return chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" });
  }
}

async function resolvePdfUrl(page, work) {
  const knownPdf = pdfUrlFromCurrent(work.muse_pdf_start_url);
  if (knownPdf) return knownPdf;
  await page.goto(work.muse_pdf_start_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(2000);
  let pdfUrl = pdfUrlFromCurrent(page.url());
  if (pdfUrl) return pdfUrl;

  const text = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (VERIFY_WAIT_MS > 0 && /\b(verification required|friendly captcha)\b/i.test(text)) {
    console.log(`[muse-pdf] Verification page is open for ${work.id}; complete it in the browser. Waiting up to ${VERIFY_WAIT_MS}ms...`);
    const started = Date.now();
    while (Date.now() - started < VERIFY_WAIT_MS) {
      await sleep(2000);
      pdfUrl = pdfUrlFromCurrent(page.url());
      if (pdfUrl) return pdfUrl;
      const current = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
      if (!/\b(verification required|friendly captcha)\b/i.test(current)) break;
    }
  }

  pdfUrl = pdfUrlFromCurrent(page.url());
  if (pdfUrl) return pdfUrl;
  const link = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const hit = anchors.find((a) => /\/pdf(?:[?#].*)?$/i.test(a.href) || /\bpdf\b/i.test(a.textContent || ""));
    return hit?.href || null;
  }).catch(() => null);
  return pdfUrlFromCurrent(link) || link;
}

async function fetchPdfBuffer(context, pdfUrl) {
  const response = await context.request.get(pdfUrl, {
    timeout: TIMEOUT_MS,
    maxRedirects: 5,
    headers: { Accept: "application/pdf,*/*;q=0.5" },
  });
  const finalUrl = response.url();
  if (!response.ok()) return { ok: false, finalUrl, status: response.status(), reason: "http" };
  const body = Buffer.from(await response.body());
  if (body.length > MAX_BYTES) return { ok: false, finalUrl, status: response.status(), reason: "too_large" };
  if (body.slice(0, 4).toString("latin1") !== "%PDF") {
    return { ok: false, finalUrl, status: response.status(), reason: "not_pdf_magic" };
  }
  return { ok: true, finalUrl, status: response.status(), buffer: body };
}

function rawDataFor(work, result) {
  return {
    ...(work.raw_data || {}),
    abstract_backfill: {
      source: "project_muse_pdf_formal_abstract",
      status: result.kind,
      matched_at: new Date().toISOString(),
      provenance_note: result.note,
      muse_pdf_url: result.pdfUrl || null,
      final_url: result.finalUrl || null,
      extraction_source: result.source || null,
      pages_checked: PDF_PAGES,
    },
  };
}

async function processWork(context, page, work) {
  const pdfUrl = await resolvePdfUrl(page, work);
  if (!pdfUrl) return { status: "no_pdf_url", work };
  const fetched = await fetchPdfBuffer(context, pdfUrl);
  if (!fetched.ok) return { status: "pdf_fetch_error", work, pdfUrl, fetched };

  let text = "";
  try {
    text = await parsePdfText(fetched.buffer);
  } catch (err) {
    return { status: "pdf_parse_error", work, pdfUrl, finalUrl: fetched.finalUrl, error: err.message };
  }

  const extracted = extractAbstractFromPdfText(text, work.title);
  const textPreview = INCLUDE_TEXT_PREVIEW ? compactText(text).slice(0, 1800) : undefined;
  if (!extracted) {
    const result = {
      kind: "pdf_no_abstract_section",
      note: "Project MUSE PDF was readable, but no labeled Abstract/Summary section was found in the checked pages.",
      pdfUrl,
      finalUrl: fetched.finalUrl,
      source: "pdf_text",
    };
    if (!DRY_RUN) await supabase.from("works").update({ raw_data: rawDataFor(work, result) }).eq("id", work.id);
    return { status: "pdf_no_abstract_section", work, pdfUrl, finalUrl: fetched.finalUrl, textPreview };
  }

  const result = {
    kind: "formal_abstract",
    note: "Formal labeled Abstract/Summary section extracted from authenticated Project MUSE PDF.",
    pdfUrl,
    finalUrl: fetched.finalUrl,
    source: extracted.source,
  };
  if (!DRY_RUN) {
    const { error } = await supabase
      .from("works")
      .update({ abstract: extracted.abstract, raw_data: rawDataFor(work, result) })
      .eq("id", work.id);
    if (error) return { status: "update_error", work, pdfUrl, error: error.message };
  }
  return {
    status: DRY_RUN ? "would_update" : "updated",
    work,
    pdfUrl,
    finalUrl: fetched.finalUrl,
    source: extracted.source,
    abstractLength: extracted.abstract.length,
    abstractPreview: extracted.abstract.slice(0, 280),
  };
}

async function main() {
  console.log("\n=== Project MUSE PDF abstract backfill ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`List targets only: ${LIST_TARGETS}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Journal only: ${JOURNAL_ONLY}`);
  console.log(`PDF pages: ${PDF_PAGES}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Login URL: ${LOGIN_URL || "(first target)"}`);
  console.log("Only labeled PDF Abstract/Summary sections are written.\n");

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;

  if (LIST_TARGETS) {
    for (const [index, work] of targets.entries()) {
      console.log(`${index + 1}/${targets.length} abs=${work.abs_rating || "?"} year=${work.year || "?"} cites=${work.citation_count || 0} ${work.venue || ""} :: ${work.title?.slice(0, 100) || work.id}`);
    }
    return;
  }

  const context = await launchBrowser();
  const page = await context.newPage();
  if (MANUAL_LOGIN || !HEADLESS) {
    await page.goto(LOGIN_URL || targets[0].muse_pdf_start_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    console.log(`[muse-pdf] Browser is open. Log in through NYU/Project MUSE institutional access if needed; continuing in ${LOGIN_WAIT_MS}ms...`);
    await sleep(LOGIN_WAIT_MS);
  }

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const work = targets[i];
    try {
      const result = await processWork(context, page, work);
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
    pages: PDF_PAGES,
    targets: targets.length,
    updated: results.filter((r) => r.status === "updated").length,
    would_update: results.filter((r) => r.status === "would_update").length,
    pdf_no_abstract_section: results.filter((r) => r.status === "pdf_no_abstract_section").length,
    no_pdf_url: results.filter((r) => r.status === "no_pdf_url").length,
    pdf_fetch_error: results.filter((r) => r.status === "pdf_fetch_error").length,
    pdf_parse_error: results.filter((r) => r.status === "pdf_parse_error").length,
    update_error: results.filter((r) => r.status === "update_error").length,
    errors: results.filter((r) => r.status === "error").length,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[muse-pdf] failed:", err);
  process.exit(1);
});
