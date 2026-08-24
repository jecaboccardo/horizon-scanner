#!/usr/bin/env node
/**
 * Backfill JSTOR missing abstracts through an authenticated browser session.
 *
 * This does not download PDFs. It opens JSTOR article pages in a persistent
 * Playwright-controlled browser profile, extracts visible metadata/full-text or
 * first-page OCR text, and either records a formal JSTOR abstract or generates
 * an abstract-like summary with explicit provenance.
 *
 * Usage:
 *   node scripts/backfill-abstracts-jstor-browser.mjs --dry-run --limit 10
 *   node scripts/backfill-abstracts-jstor-browser.mjs --limit 100 --manual-login
 *   node scripts/backfill-abstracts-jstor-browser.mjs --limit 25 --manual-login --access-prefix "https://go.openathens.net/redirector/nyu.edu?url="
 *   node scripts/backfill-abstracts-jstor-browser.mjs --limit 25 --manual-login --login-url "https://globalhome.nyu.edu/services/search/elibrary"
 *   node scripts/backfill-abstracts-jstor-browser.mjs --venues "Econometrica,The Economic Journal"
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
  console.error("[jstor-browser] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
const HEADLESS = process.argv.includes("--headless");
const MANUAL_LOGIN = process.argv.includes("--manual-login");
const NO_LLM = process.argv.includes("--no-llm");
// --formal-only: write ONLY real formal abstracts; never write a generated/fallback
// summary (keeps the corpus free of non-real abstracts). Book reviews still get noised.
const FORMAL_ONLY = process.argv.includes("--formal-only");
const LIMIT = Number(argValue("--limit", "25"));
const YEAR_MIN = Number(argValue("--year-min", "0")) || 0;
const YEAR_MAX = Number(argValue("--year-max", "0")) || 0;
const ORDER_BY = argValue("--order-by", "citation_count");
// Target only papers whose publication_type is labelled as such (default: journal articles).
// Skips book reviews / other non-article types up front. Override with --pubtypes a,b,c.
const PUBTYPES = String(argValue("--pubtypes", "journal_article")).split(",").map((s) => s.trim()).filter(Boolean);
const PROFILE_DIR = resolve(argValue("--profile-dir", ".playwright-jstor-profile"));
const LOGIN_WAIT_MS = Number(argValue("--login-wait-ms", MANUAL_LOGIN ? "90000" : "15000"));
const TIMEOUT_MS = Number(argValue("--timeout-ms", "45000"));
// Slower default pacing = fewer "are you a robot" challenges. Rapid sequential
// article opens are the #1 behavioural tell. Override with --sleep-ms/--jitter-ms.
const SLEEP_MS = Number(argValue("--sleep-ms", process.env.JSTOR_SLEEP_MS || "9000")) || 9000;
const JITTER_MS = Number(argValue("--jitter-ms", process.env.JSTOR_JITTER_MS || "7000")) || 0;
const VERIFY_WAIT_MS = Number(argValue("--verify-wait-ms", process.env.JSTOR_VERIFY_WAIT_MS || (HEADLESS ? "0" : "120000"))) || 0;
const ACCESS_PREFIX = argValue("--access-prefix", process.env.JSTOR_ACCESS_PREFIX || "");
const LOGIN_URL = argValue("--login-url", process.env.JSTOR_LOGIN_URL || "");
const MODEL = argValue("--model", process.env.JSTOR_SUMMARY_MODEL || process.env.TIER2_MODEL || "qwen2.5:14b-synthesis");
const LLM_ENDPOINT =
  process.env.LLM_ENDPOINT ||
  (process.env.LLM_BASE_URL ? `${process.env.LLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions` : "https://llm.iotaimpact.com/v1/chat/completions");
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "not-needed";
const IDS = String(argValue("--ids", ""))
  .split(",")
  .map((s) => normDoi(s))
  .filter(Boolean);
const VENUES = String(argValue("--venues", "Econometrica,The Economic Journal,Journal of Political Economy"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VENUE_DENYLIST = loadVenueDenylist();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `targeted-abstract-jstor-browser-backfill-${TODAY}.json`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function isGoodText(text, min = 120) {
  const t = compactText(text);
  if (t.length < min || t.length > 5000) return false;
  if (/\b(access check|unusual traffic|recaptcha|not a robot|block reference|institutional login|log in through your library)\b/i.test(t)) {
    return false;
  }
  if (/\b(cookie|privacy preference|access provided by)\b/i.test(t) && t.length < 500) {
    return false;
  }
  return true;
}

function jstorUrlFor(work) {
  const urls = [work.url, work.open_access_pdf_url].filter(Boolean);
  for (const raw of urls) {
    const url = String(raw);
    const redirect = url.match(/[?&]redirectUri=([^&]+)/i)?.[1];
    if (redirect) {
      const decoded = decodeURIComponent(redirect);
      const stable = decoded.match(/\/stable\/([^/?#]+)/i)?.[1];
      if (stable) return `https://www.jstor.org/stable/${stable}`;
    }
    const stable = url.match(/jstor\.org\/stable\/([^/?#]+)/i)?.[1];
    if (stable) return `https://www.jstor.org/stable/${stable}`;
  }
  const doi = normDoi(work.canonical_doi);
  const stableId = doi.match(/^10\.2307\/(.+)$/i)?.[1];
  return stableId ? `https://www.jstor.org/stable/${stableId}` : null;
}

function accessUrlFor(jstorUrl) {
  if (!ACCESS_PREFIX) return jstorUrl;
  return `${ACCESS_PREFIX}${encodeURIComponent(jstorUrl)}`;
}

function looksJstor(work) {
  const doi = normDoi(work.canonical_doi);
  return doi.startsWith("10.2307/") || /jstor\.org/i.test(`${work.url || ""} ${work.open_access_pdf_url || ""}`);
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

function absRatingValue(value) {
  const text = String(value || "").trim();
  if (text === "4*") return 4.5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function prioritySort(a, b) {
  return (
    absRatingValue(b.abs_rating) - absRatingValue(a.abs_rating) ||
    Number(b.citation_count || 0) - Number(a.citation_count || 0) ||
    Number(b.year || 0) - Number(a.year || 0)
  );
}

async function loadTargets() {
  const select = "id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,url,open_access_pdf_url,is_noise,excluded,publication_type,abs_rating";
  let query = supabase.from("works").select(select);
  if (IDS.length) query = query.in("canonical_doi", IDS);
  else {
    query = query.in("venue", VENUES).or("abstract.is.null,abstract.eq.");
    if (PUBTYPES.length) query = query.in("publication_type", PUBTYPES);
    if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
    if (YEAR_MAX > 0) query = query.lte("year", YEAR_MAX);
  }
  query = query.order("citation_count", { ascending: false, nullsFirst: false });
  const rows = filterDeniedVenues(await selectAll(query), VENUE_DENYLIST)
    .filter((row) => !String(row.abstract || "").trim())
    .filter((row) => !row.is_noise)
    .filter((row) => !row.excluded)
    .filter((row) => !isGenericNonPrimaryTitle(row.title))
    .filter((row) => {
      const src = row.raw_data?.abstract_backfill?.source || "";
      const status = row.raw_data?.abstract_backfill?.status || "";
      // Skip if already successfully extracted by jstor_browser; allow retry on not_accessible
      if (!src.includes("jstor_browser")) return true;
      return status === "not_accessible";
    })
    .filter(looksJstor)
    .map((row) => {
      const jstorUrl = jstorUrlFor(row);
      return { ...row, jstor_url: jstorUrl, access_url: jstorUrl ? accessUrlFor(jstorUrl) : null };
    })
    .filter((row) => row.jstor_url)
    .sort(prioritySort);
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

function extractFormalAbstractFromText(text) {
  const normalized = String(text || "").replace(/\r/g, "\n");
  const match = normalized.match(/\bAbstract\b\s*\n?([\s\S]{120,2200}?)(?=\n\s*(?:Download|Full Text|References|Citation|Article|Notes|Footnotes|Stable URL|Published by|JSTOR is|Page \d+|Keywords)\b|$)/i);
  if (!match) return null;
  const cleaned = compactText(match[1]);
  return isGoodText(cleaned, 100) ? cleaned : null;
}

function firstPageTextFromVisibleText(text, title) {
  let cleaned = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\bAccess Check\b[\s\S]*$/i, " ")
    .replace(/\bSkip to Main Content\b[\s\S]{0,1000}?\bJSTOR Home\b/gi, " ")
    .replace(/\bThis item is part of JSTOR\b[\s\S]{0,600}/gi, " ")
    .replace(/\bTerms and Conditions\b[\s\S]*$/gi, " ")
    .replace(/\bJSTOR is a not-for-profit\b[\s\S]*$/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const titleIdx = title ? cleaned.toLowerCase().indexOf(String(title).toLowerCase().slice(0, 40)) : -1;
  if (titleIdx >= 0) cleaned = cleaned.slice(titleIdx);
  return compactText(cleaned).slice(0, 4500);
}

function fallbackSummary(work, firstPageText) {
  const text = compactText(firstPageText);
  const sentence = text.match(/(?:^|[.!?]\s+)([A-Z][^.!?]{80,260}[.!?])/);
  const topic = sentence ? sentence[1].trim() : `This item appears to discuss ${work.title}.`;
  return compactText(`No formal abstract is available in the accessible JSTOR metadata. Based on the title, venue metadata, and first-page text, ${topic}`);
}

async function generateSummary(work, firstPageText) {
  if (NO_LLM) return fallbackSummary(work, firstPageText);
  const prompt = [
    "Write a concise abstract-like summary for a scholarly article.",
    "Important: The article has no formal abstract available. Do not claim this is the original abstract.",
    "Use only the title, metadata, and first-page/OCR text below. If evidence is thin, be cautious.",
    "Return 2-4 sentences, 80-160 words, no bullets.",
    "",
    `Title: ${work.title || ""}`,
    `Venue: ${work.venue || ""}`,
    `Year: ${work.year || ""}`,
    `Authors: ${Array.isArray(work.authors) ? work.authors.join("; ") : work.authors || ""}`,
    "",
    `First-page/OCR text:\n${firstPageText.slice(0, 4500)}`,
  ].join("\n");
  const response = await fetch(LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You write careful, non-fabricated academic summaries from limited source text." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 260,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = await response.json();
  const summary = compactText(json?.choices?.[0]?.message?.content || "");
  return isGoodText(summary, 80) ? summary : fallbackSummary(work, firstPageText);
}

async function launchBrowser() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const options = {
    headless: HEADLESS,
    viewport: { width: 1360, height: 900 },
    ignoreHTTPSErrors: true,
    locale: "en-US",
    // Anti-bot: drop the "controlled by automated software" banner + the
    // --enable-automation flag, which JSTOR's challenge heuristics key on.
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  // Mask the headless/automation fingerprints that survive the launch flags.
  const harden = async (ctx) => {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // headless Chrome has no window.chrome runtime; give it a benign one
      window.chrome = window.chrome || { runtime: {} };
    });
    return ctx;
  };
  try {
    return await harden(await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "msedge" }));
  } catch (err) {
    console.warn(`[jstor-browser] Could not launch Edge channel (${err.message}); trying Chrome channel.`);
    return harden(await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: "chrome" }));
  }
}

// JSTOR renders the formal abstract inside a Pharos micro-frontend accordion
// (div.abstract-container > div.abstract), whose text is NOT present in
// body.innerText when the accordion is collapsed or lives in a web-component.
// Reading the element's textContent directly (piercing one level of shadow
// roots) is the reliable source — body.innerText alone silently misses real
// abstracts. Returns the cleaned abstract, or null when no substantive
// container text is present (genuinely abstract-less pages).
async function extractAbstractFromDom(page) {
  const raw = await page.evaluate(() => {
    const SEL = ".abstract-container, div.abstract, [class*='abstract' i]";
    const pick = (root) => {
      const el = root.querySelector(SEL);
      return el ? (el.textContent || "").trim() : "";
    };
    let txt = pick(document);
    if (!txt || txt.length < 80) {
      for (const host of Array.from(document.querySelectorAll("*"))) {
        if (host.shadowRoot) {
          const t = pick(host.shadowRoot);
          if (t && t.length > txt.length) txt = t;
        }
      }
    }
    return txt;
  }).catch(() => "");
  if (!raw) return null;
  // Drop a leading "Abstract" heading, then cut trailing page chrome that the
  // container sometimes includes (References / copyright / nav).
  let cleaned = compactText(String(raw).replace(/^\s*abstract\s*[:.]?\s*/i, ""));
  cleaned = cleaned.split(/\b(?:References|Terms and copyright|This item is part of a JSTOR Collection|Request Permissions|ABOUT US|Search matches)\b/i)[0].trim();
  return isGoodText(cleaned, 100) ? cleaned : null;
}

function isBookReviewPage(text) {
  return /\bReviewed Work:/i.test(text || "") || /\bReview by:/i.test(text || "");
}

function isVerificationPage(text) {
  return /\b(i(?:'m| am) not a robot|prove you(?:'re| are) human|verify you(?:'re| are) human|unusual traffic|please confirm you(?:'re| are) not a robot|captcha|access check|checking your browser|just a moment)\b/i.test(text || "");
}

async function waitForVerification(page, workId) {
  if (VERIFY_WAIT_MS <= 0) return;
  console.log(`[jstor-browser] Verification challenge detected for ${workId} — complete it in the browser. Waiting up to ${VERIFY_WAIT_MS / 1000}s...`);
  const deadline = Date.now() + VERIFY_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const text = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
    if (!isVerificationPage(text)) {
      console.log(`[jstor-browser] Verification passed for ${workId}.`);
      await page.waitForTimeout(SLEEP_MS);
      return;
    }
  }
  console.log(`[jstor-browser] Verification timed out for ${workId}.`);
}

function jitteredSleep() {
  const ms = SLEEP_MS + Math.floor(Math.random() * JITTER_MS);
  return sleep(ms);
}

async function extractFromJstorPage(page, work) {
  await page.goto(work.access_url || work.jstor_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  // Human-like behaviour so JSTOR's challenge heuristics relax: move the mouse,
  // scroll a little, dwell. Cheap and meaningfully reduces "are you a robot" hits.
  await page.mouse.move(280 + Math.random() * 500, 180 + Math.random() * 360).catch(() => {});
  await page.evaluate(() => window.scrollBy(0, 240 + Math.random() * 600)).catch(() => {});
  await jitteredSleep();
  const initialText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (isVerificationPage(initialText)) await waitForVerification(page, work.id);
  const bodyText = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  if (isBookReviewPage(bodyText)) {
    return { kind: "book_review", note: "JSTOR page identified as a book review (Reviewed Work / Review by). Skipping abstract; publication_type will be corrected." };
  }
  // Primary: read the abstract straight from the DOM container (handles the
  // collapsed Pharos accordion / web-component that body.innerText misses).
  // Fall back to the body-text regex only if the container yields nothing.
  const formal = (await extractAbstractFromDom(page)) || extractFormalAbstractFromText(bodyText);
  if (formal) {
    return {
      kind: "formal_abstract",
      abstract: formal,
      note: "Formal abstract extracted from JSTOR article page.",
      firstPageText: firstPageTextFromVisibleText(bodyText, work.title).slice(0, 1200),
    };
  }
  const firstPageText = firstPageTextFromVisibleText(bodyText, work.title);
  if (!isGoodText(firstPageText, 180)) {
    return {
      kind: "not_accessible",
      firstPageText,
      note: "No usable JSTOR article text was visible in the browser session. Check JSTOR login/access.",
    };
  }
  const summary = await generateSummary(work, firstPageText);
  return {
    kind: "generated_summary_no_formal_abstract",
    abstract: summary,
    firstPageText: firstPageText.slice(0, 1800),
    note: "No formal abstract available; summary generated from title/metadata/first page.",
  };
}

function rawDataFor(work, extracted) {
  return {
    ...(work.raw_data || {}),
    abstract_backfill: {
      source: extracted.kind === "formal_abstract" ? "jstor_browser_formal_abstract" : "jstor_browser_generated_summary",
      status: extracted.kind,
      matched_at: new Date().toISOString(),
      provenance_note: extracted.note,
      jstor_url: work.jstor_url,
      access_prefix: ACCESS_PREFIX || null,
      model: extracted.kind === "generated_summary_no_formal_abstract" && !NO_LLM ? MODEL : null,
      first_page_text_preview: compactText(extracted.firstPageText || "").slice(0, 900),
    },
  };
}

async function apply(work, extracted) {
  if (extracted.kind === "book_review") {
    if (!DRY_RUN) {
      await supabase.from("works").update({ publication_type: "book_review", is_noise: true }).eq("id", work.id);
    }
    return { status: "book_review_skipped", work, extracted };
  }
  if (FORMAL_ONLY && extracted.kind === "generated_summary_no_formal_abstract") {
    return { status: "formal_only_skipped", work, extracted };
  }
  if (!extracted.abstract) return { status: extracted.kind || "not_found", work, extracted };
  if (DRY_RUN) return { status: "would_update", work, extracted };
  const { error } = await supabase
    .from("works")
    .update({ abstract: extracted.abstract, raw_data: rawDataFor(work, extracted) })
    .eq("id", work.id);
  if (error) return { status: "update_error", work, extracted, error: error.message };
  return { status: "updated", work, extracted };
}

async function main() {
  console.log("\n=== JSTOR browser abstract-like backfill ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Venues: ${VENUES.join(", ")}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Login URL: ${LOGIN_URL || "(first JSTOR target)"}`);
  console.log(`Access prefix: ${ACCESS_PREFIX || "(direct JSTOR)"}`);
  console.log(`Per-page sleep: ${SLEEP_MS}ms + up to ${JITTER_MS}ms random jitter`);
  console.log(`Verification wait: ${VERIFY_WAIT_MS ? `${VERIFY_WAIT_MS / 1000}s` : "disabled (headless)"}`);
  console.log(`No PDF downloads; generated summaries are marked as non-formal.\n`);

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;

  const context = await launchBrowser();
  const page = await context.newPage();
  if (MANUAL_LOGIN || !HEADLESS) {
    await page.goto(LOGIN_URL || targets[0].access_url || targets[0].jstor_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    console.log(`[jstor-browser] Browser is open. Log in through NYU/JSTOR institutional access if needed; continuing in ${LOGIN_WAIT_MS}ms...`);
    await sleep(LOGIN_WAIT_MS);
  }

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const work = targets[i];
    try {
      const extracted = await extractFromJstorPage(page, work);
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
    venues: VENUES,
    targets: targets.length,
    updated: results.filter((r) => r.status === "updated").length,
    would_update: results.filter((r) => r.status === "would_update").length,
    formal_abstracts: results.filter((r) => r.extracted?.kind === "formal_abstract").length,
    generated_summaries: results.filter((r) => r.extracted?.kind === "generated_summary_no_formal_abstract").length,
    book_reviews_skipped: results.filter((r) => r.status === "book_review_skipped").length,
    not_accessible: results.filter((r) => r.status === "not_accessible").length,
    update_error: results.filter((r) => r.status === "update_error").length,
    errors: results.filter((r) => r.status === "error").length,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[jstor-browser] failed:", err);
  process.exit(1);
});
