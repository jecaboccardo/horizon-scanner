#!/usr/bin/env node
/**
 * Backfill abstracts by BROWSING a journal in ProQuest ABI/INFORM (NYU login),
 * matching results back to the corpus BY DOI — not by per-paper title search.
 *
 * Why: per-title search (backfill-abstracts-proquest-browser.mjs) fails on JDE
 * (title tokenization → no_result) and is gap-by-gap. This instead searches the
 * PUBLICATION directly — PUB("Journal of Development Economics") AND YR(year) —
 * pages through the journal's indexed articles, opens each docview, extracts the
 * abstract + DOI, and writes it to our row only if the DOI matches a corpus gap.
 *
 * 🔒 GOLDEN RULE: gap-only. Writes `abstract` only when currently NULL; never
 *    overwrites. Provenance: raw_data.abstract_backfill (source=proquest_journal).
 *
 * Reuses the same NYU login profile as backfill-abstracts-proquest-browser.mjs.
 *
 * Usage (run inside a live NYU login):
 *   node scripts/backfill-abstracts-proquest-journal.mjs --manual-login --dry-run --year-min 2018
 *   node scripts/backfill-abstracts-proquest-journal.mjs --manual-login --limit 1000
 *   node scripts/backfill-abstracts-proquest-journal.mjs --manual-login --venue "World Development" --year-min 2015
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const argv = process.argv;
const argVal = (name, fb = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? fb) : fb; };
const DRY_RUN = argv.includes("--dry-run");
const DEBUG = argv.includes("--debug");
const MANUAL_LOGIN = argv.includes("--manual-login");
const VENUE = String(argVal("--venue", "Journal of Development Economics"));
const YEAR_MIN = Number(argVal("--year-min", "1974"));   // JDE began 1974
const YEAR_MAX = Number(argVal("--year-max", String(new Date().getFullYear())));
const LIMIT = Number(argVal("--limit", "1000"));          // max abstracts to WRITE this run
const MAX_PAGES = Number(argVal("--max-pages", "8"));     // result pages per year (≈20 results/page)
const SLEEP_MS = Number(argVal("--sleep-ms", "5000"));
const JITTER_MS = Number(argVal("--jitter-ms", "3000"));
const LOGIN_WAIT_MS = Number(argVal("--login-wait-ms", MANUAL_LOGIN ? "150000" : "12000"));
const TIMEOUT_MS = Number(argVal("--timeout-ms", "45000"));
const PROFILE_DIR = resolve(argVal("--profile-dir", ".playwright-proquest-profile"));
const START_URL = "https://www.proquest.com/abicompletealumni/index?accountid=33843";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(SLEEP_MS + Math.floor(Math.random() * JITTER_MS));
const compact = (s) => String(s || "").replace(/\s+/g, " ").trim();
const good = (s, min = 100) => compact(s).length >= min;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const normDoi = (d) => String(d || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
function titlesMatch(a, b) {
  const ta = new Set(norm(a).split(" ").filter((t) => t.length > 3));
  const tb = new Set(norm(b).split(" ").filter((t) => t.length > 3));
  if (!ta.size || !tb.size) return false;
  let shared = 0; for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}
const isExpired = (url) => /sessionexpired/i.test(url || "");

// --- Build the corpus gap map: JDE rows missing an abstract, keyed by DOI + title ---
async function loadGapMap() {
  const byDoi = new Map(), byTitleTokens = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("works")
      .select("id,title,canonical_doi,abstract,raw_data,is_noise")
      .eq("venue", VENUE).is("abstract", null).is("canonical_work_id", null)
      .not("is_noise", "is", true).not("canonical_doi", "is", null)
      .range(from, from + 999);
    if (error) { console.error("gap load:", error.message); break; }
    if (!data?.length) break;
    for (const w of data) {
      const d = normDoi(w.canonical_doi);
      if (d) byDoi.set(d, w);
      if (w.title) byTitleTokens.push(w);
    }
    if (data.length < 1000) break;
  }
  return { byDoi, byTitleTokens };
}

// --- Extract abstract + DOI from a ProQuest docview page ---
async function extractDocview(page) {
  const body = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  const fullTitle = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const dt = (document.title || "").replace(/\s*[-|]\s*ProQuest\s*$/i, "");
    return ((h1?.textContent || "").trim() || dt).trim();
  }).catch(() => "");
  // DOI: from the page text (Details/Indexing section) or any doi.org link.
  let doi = null;
  const m1 = body.match(/\b(?:DOI|Digital Object Identifier)\b[:\s]*\n?\s*(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,}\/[^\s"<)\]]+)/i);
  if (m1) doi = m1[1];
  if (!doi) {
    const href = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href*='doi.org/10.']"))[0];
      return a ? a.getAttribute("href") : null;
    }).catch(() => null);
    if (href) { const m = href.match(/(10\.\d{4,}\/[^\s"<)\]]+)/); if (m) doi = m[1]; }
  }
  // Abstract: the formal "Abstract … (until Full Text/Details/…)" block.
  const ma = body.replace(/\r/g, "\n").match(
    /\bAbstract\b\s*(?:Translate[^\n]*)?\n+([\s\S]{80,2600}?)(?=\n\s*(?:Full Text|Full text|Indexing|Details|Subject|References|Show less|You have requested)\b|$)/i,
  );
  let abs = ma ? compact(ma[1].replace(/^Learn more about Translate\s*/i, "")) : "";
  return { abstract: good(abs, 100) ? abs : "", doi: doi ? normDoi(doi) : null, fullTitle, body };
}

async function submitSearch(page, query) {
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
  if (isExpired(page.url())) return false;
  const box = page.locator("#searchTerm, textarea[name='searchTerm']").first();
  if (!(await box.count().catch(() => 0))) return false;
  await box.click().catch(() => {});
  await box.fill(query).catch(() => {});
  const submitted = await page.evaluate(() => {
    const ta = document.querySelector("#searchTerm");
    const form = ta && ta.closest("form");
    if (!form) return false;
    const btn = form.querySelector("#searchToResultPage, button[type='submit'], input[type='submit']");
    if (btn) { btn.click(); return true; }
    try { form.submit(); return true; } catch { return false; }
  }).catch(() => false);
  if (!submitted) await box.press("Enter").catch(() => {});
  for (let t = 0; t < 8; t++) { await page.waitForTimeout(1800); if (isExpired(page.url())) return false; if (await page.locator("a[href*='docview']").first().count().catch(() => 0)) break; }
  return true;
}

// Collect docview hrefs across up to MAX_PAGES result pages for the current search.
async function collectResultHrefs(page) {
  const hrefs = new Set();
  for (let p = 0; p < MAX_PAGES; p++) {
    const pageHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='docview']")).map((a) => a.href).filter(Boolean));
    pageHrefs.forEach((h) => hrefs.add(h.split("#")[0]));
    // Try to advance to the next results page.
    const advanced = await page.evaluate(() => {
      const next = document.querySelector("a[title='Next Page'], a[aria-label='Next page'], a.next, a[href*='&page='][rel='next']");
      if (next) { next.click(); return true; }
      return false;
    }).catch(() => false);
    if (!advanced) break;
    await page.waitForTimeout(2500);
  }
  return [...hrefs];
}

async function main() {
  const { byDoi, byTitleTokens } = await loadGapMap();
  console.log(`=== ProQuest journal-browse abstract backfill ===`);
  console.log(`venue: "${VENUE}" | years ${YEAR_MAX}..${YEAR_MIN} | gap rows: ${byDoi.size} (with DOI) | dry-run: ${DRY_RUN}`);
  if (byDoi.size === 0) { console.log("No corpus gaps for this venue."); return; }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: true,
    args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"], channel: "msedge",
  }).catch(async () => chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome" }));
  const page = (await ctx.pages())[0] || await ctx.newPage();
  await page.goto("https://globalhome.nyu.edu", { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
  console.log(`[pq] Log into ProQuest ABI/INFORM. Continuing in ${LOGIN_WAIT_MS / 1000}s...`);
  await page.waitForTimeout(LOGIN_WAIT_MS);

  const stats = { years: 0, docviews: 0, matched: 0, written: 0, no_abstract: 0, no_match: 0, expired: 0 };
  const writtenRows = [];
  outer:
  for (let year = YEAR_MAX; year >= YEAR_MIN; year--) {
    if (stats.written >= LIMIT) break;
    const query = `PUB("${VENUE}") AND YR(${year})`;
    if (!(await submitSearch(page, query))) { if (isExpired(page.url())) { stats.expired++; console.log("Session expired — stopping."); break; } console.log(`${year}: no results page`); continue; }
    stats.years++;
    if (DEBUG) {
      const url = page.url();
      const title = await page.title().catch(() => "");
      const body = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
      const counts = await page.evaluate(() => ({
        docview: document.querySelectorAll("a[href*='docview']").length,
        docviewSlash: document.querySelectorAll("a[href*='/docview/']").length,
        resultItems: document.querySelectorAll(".resultItem, [data-doc-id], li.result, .result-item, [class*='result']").length,
        anchors: document.querySelectorAll("a").length,
        searchBox: document.querySelectorAll("#searchTerm, textarea[name='searchTerm']").length,
      })).catch(() => ({}));
      console.log(`\n[DEBUG ${year}] url=${url}`);
      console.log(`[DEBUG] title=${title}`);
      console.log(`[DEBUG] looksLoggedIn=${/proquest\.com\/abicomplete/i.test(url)} hasLoginWords=${/sign in|log in|institution|shibboleth|sso|login/i.test(body.slice(0,1500))}`);
      console.log(`[DEBUG] selector counts=${JSON.stringify(counts)}`);
      console.log(`[DEBUG] body[0:700]=${body.replace(/\s+/g, " ").slice(0, 700)}`);
      break;
    }
    const hrefs = await collectResultHrefs(page);
    console.log(`${year}: ${hrefs.length} result docs`);
    for (const href of hrefs) {
      if (stats.written >= LIMIT) break outer;
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
      if (isExpired(page.url())) { stats.expired++; console.log("Session expired — stopping."); break outer; }
      await page.waitForTimeout(1500);
      stats.docviews++;
      const { abstract, doi, fullTitle } = await extractDocview(page);
      // Match to a corpus gap: DOI first, then title fallback.
      let work = doi ? byDoi.get(doi) : null;
      if (!work && fullTitle) work = byTitleTokens.find((w) => titlesMatch(w.title, fullTitle)) || null;
      if (!work) { stats.no_match++; }
      else if (!abstract) { stats.no_abstract++; }
      else {
        stats.matched++;
        if (DRY_RUN) {
          console.log(`   would_write ${work.canonical_doi} (${abstract.length}c): ${abstract.slice(0, 80)}...`);
          stats.written++;
        } else {
          const rd = { ...(work.raw_data || {}), abstract_backfill: { source: "proquest_journal", status: "formal_abstract", matched_at: new Date().toISOString(), url: page.url(), via: doi ? "doi" : "title" } };
          const { error } = await supabase.from("works").update({ abstract, raw_data: rd }).eq("id", work.id).is("abstract", null);
          if (error) { console.log(`   write error ${work.id}: ${error.message}`); }
          else { stats.written++; writtenRows.push({ id: work.id, doi: work.canonical_doi, year }); byDoi.delete(doi || ""); console.log(`   wrote ${work.canonical_doi} (${abstract.length}c)`); }
        }
      }
      await jitter();
    }
  }
  console.log("=== Done ===", JSON.stringify(stats));
  try { mkdirSync("reports", { recursive: true }); writeFileSync(join("reports", `proquest-journal-${VENUE.replace(/\W+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ stats, writtenRows }, null, 2)); } catch { /* ignore */ }
  await ctx.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
