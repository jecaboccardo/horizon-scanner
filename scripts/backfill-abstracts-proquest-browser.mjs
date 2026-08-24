#!/usr/bin/env node
/**
 * Backfill missing abstracts via ProQuest ABI/INFORM (authenticated browser).
 *
 * Targets the 2000+ publisher-restricted gap (Elsevier/Wiley/Chicago/AEA econ &
 * business) that free APIs miss by DOI. ProQuest ABI/INFORM indexes these WITH
 * selectable-text abstracts. DOI search returns the EXACT paper, so matching is
 * exact (a title-overlap check is kept as a safety gate).
 *
 * 🔒 GOLDEN RULE: gap-only. Only writes `abstract` when it is currently NULL.
 *    Never overwrites a populated value. Provenance: raw_data.abstract_backfill.
 *
 * Sessions (NYU alumni access) expire fast — run inside a live login:
 *   node scripts/backfill-abstracts-proquest-browser.mjs --manual-login --dry-run --limit 10
 *   node scripts/backfill-abstracts-proquest-browser.mjs --manual-login --limit 100 --year-min 2000
 *   node scripts/backfill-abstracts-proquest-browser.mjs --manual-login --ids 10.1111/...,10.1016/...
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Curated venue presets — use with --preset <name>
const VENUE_PRESETS = {
  // Applied economics journals with good ProQuest ABI/INFORM hit rates (42-60%)
  // Excludes theory/pure-econometrics journals (JET, Econometrica, J.Econometrics, Games)
  "applied-econ": [
    "Journal of Health Economics",
    "Journal of Environmental Economics and Management",
    "Journal of International Money and Finance",
    "European Economic Review",
    "Journal of Economic Behavior & Organization",
    "Journal of Development Economics",
    "Journal of Public Economics",
    "Journal of International Economics",
    "American Journal of Agricultural Economics",
    "Journal of Comparative Economics",
    "Economic Development and Cultural Change",
    "World Development",
    "Industrial and Labor Relations Review",
    "British Journal of Industrial Relations",
    "Journal of Population Economics",
    "Labour Economics",
    "Journal of Human Resources",
    "Journal of Labor Economics",
    "Review of Economics and Statistics",
    "Energy Economics",
    "Journal of Policy Analysis and Management",
    "Personnel Psychology",
    "Public Administration Review",
    "Empirical Economics",
    "National Tax Journal",
    "Journal of Applied Econometrics",
  ],
};

const argv = process.argv;
const argVal = (name, fb = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? fb) : fb; };
const DRY_RUN = argv.includes("--dry-run");
const MANUAL_LOGIN = argv.includes("--manual-login");
const LIMIT = Number(argVal("--limit", "50"));
const YEAR_MIN = Number(argVal("--year-min", "2000"));
// Optional inclusive upper bound — for the pre-2000 applied-econ gap pass:
//   --year-min 1900 --year-max 1999
const YEAR_MAX = (() => { const v = argVal("--year-max", null); return v != null ? Number(v) : null; })();
const PRESET = argVal("--preset", null);
const VENUES = PRESET
  ? (VENUE_PRESETS[PRESET] || (() => { console.error(`Unknown preset: ${PRESET}. Available: ${Object.keys(VENUE_PRESETS).join(", ")}`); process.exit(1); })())
  : String(argVal("--venues", "")).split(",").map((s) => s.trim()).filter(Boolean);
const EXCLUDE_VENUES = String(argVal("--exclude-venues", "")).split(",").map((s) => s.trim()).filter(Boolean);
const ABS_RATINGS = String(argVal("--abs-ratings", "")).split(",").map((s) => s.trim()).filter(Boolean);
const IDS = String(argVal("--ids", "")).split(",").map((s) => s.trim()).filter(Boolean);
const SLEEP_MS = Number(argVal("--sleep-ms", "6000"));
const JITTER_MS = Number(argVal("--jitter-ms", "4000"));
const LOGIN_WAIT_MS = Number(argVal("--login-wait-ms", MANUAL_LOGIN ? "150000" : "12000"));
const TIMEOUT_MS = Number(argVal("--timeout-ms", "45000"));
const PROFILE_DIR = resolve(argVal("--profile-dir", ".playwright-proquest-profile"));
const START_URL = "https://www.proquest.com/abicompletealumni/index?accountid=33843";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(SLEEP_MS + Math.floor(Math.random() * JITTER_MS));
const compact = (s) => String(s || "").replace(/\s+/g, " ").trim();
const good = (s, min = 100) => compact(s).length >= min;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function doiOf(w) {
  const d = w.canonical_doi || (String(w.id).startsWith("10.") ? w.id : null);
  return d ? String(d).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim() : null;
}
// Title-overlap safety gate: ≥60% of the shorter title's tokens shared.
function titlesMatch(a, b) {
  const ta = new Set(norm(a).split(" ").filter((t) => t.length > 3));
  const tb = new Set(norm(b).split(" ").filter((t) => t.length > 3));
  if (!ta.size || !tb.size) return false;
  let shared = 0; for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

async function loadTargets() {
  if (IDS.length) {
    const { data } = await supabase.from("works").select("id,title,year,venue,canonical_doi,abstract,raw_data,is_noise")
      .in("id", IDS);
    return (data || []).filter((r) => !r.is_noise && r.abstract == null);
  }
  let q = supabase.from("works")
    .select("id,title,year,venue,canonical_doi,abstract,raw_data,is_noise,excluded,citation_count")
    .is("abstract", null).is("canonical_work_id", null).not("is_noise", "is", true)
    .filter("raw_data->proquest_attempt", "is", null)  // skip already-attempted (failed) papers
    .gte("year", YEAR_MIN).not("canonical_doi", "is", null)
    .order("citation_count", { ascending: false, nullsFirst: false }).limit(LIMIT * 4);
  if (YEAR_MAX != null) q = q.lte("year", YEAR_MAX);
  if (VENUES.length) q = q.in("venue", VENUES);
  if (EXCLUDE_VENUES.length) q = q.not("venue", "in", `(${EXCLUDE_VENUES.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")})`);
  if (ABS_RATINGS.length) q = q.in("abs_rating", ABS_RATINGS);
  const { data, error } = await q;
  if (error) { console.error("target load:", error.message); return []; }
  // JS guard backs up the SQL filter in case PostgREST jsonb-null semantics differ.
  return (data || []).filter((r) => doiOf(r) && !r.raw_data?.proquest_attempt).slice(0, LIMIT);
}

function isExpired(url) { return /sessionexpired/i.test(url || ""); }

async function searchAndExtract(page, work) {
  const doi = doiOf(work);
  // Submit DOI in the visible basic-search box (ProQuest field: queryTermField).
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
  if (isExpired(page.url())) return { status: "session_expired" };
  const box = page.locator("#searchTerm, textarea[name='searchTerm']").first();
  if (!(await box.count().catch(() => 0))) return { status: "no_search_box" };
  await box.click().catch(() => {});
  // Search by QUOTED TITLE — ProQuest indexes titles reliably, whereas a DOI in
  // the keyword box tokenizes and returns nothing or the wrong paper. Result is
  // verified by title match below, so order/fuzziness is safe.
  const query = work.title ? '"' + compact(work.title).replace(/["\\]/g, " ").slice(0, 200) + '"' : doi;
  await box.fill(query).catch(() => {});
  // Enter in a <textarea> inserts a newline rather than submitting — submit the
  // form's button (in-page) or the form directly. Fall back to Enter.
  const submitted = await page.evaluate(() => {
    const ta = document.querySelector("#searchTerm");
    const form = ta && ta.closest("form");
    if (!form) return false;
    const btn = form.querySelector("#searchToResultPage, button[type='submit'], input[type='submit']");
    if (btn) { btn.click(); return true; }
    try { form.submit(); return true; } catch { return false; }
  }).catch(() => false);
  if (!submitted) await box.press("Enter").catch(() => {});
  // Poll up to ~14s for the results SPA / docview to render.
  for (let t = 0; t < 7; t++) {
    await page.waitForTimeout(2000);
    if (isExpired(page.url())) return { status: "session_expired" };
    if (/\/docview\//i.test(page.url())) break;
    if (await page.locator("a[href*='docview']").first().count().catch(() => 0)) break;
  }
  // Pick a result to open: prefer one whose link text matches the target title,
  // but ProQuest TRUNCATES titles in the result list, so most matches fail there.
  // Fall back to the TOP result and verify against the docview's FULL title below
  // (the docview shows the complete title — we only write if THAT matches).
  if (!/\/docview\//i.test(page.url())) {
    const cands = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='docview']")).map((a) => ({ href: a.href, txt: (a.textContent || "").trim() })));
    if (!cands.length) return { status: "no_result" };
    const chosen = cands.find((c) => c.txt.length > 10 && titlesMatch(work.title, c.txt)) || cands[0];
    await page.goto(chosen.href, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  if (!/\/docview\//i.test(page.url())) return { status: "no_result" };
  const body = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
  // Verify against the docview's FULL title (complete, unlike the truncated
  // result-list text). Only write when the full title matches the target — this
  // is the safety gate that makes "open the top result" safe.
  const fullTitle = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const dt = (document.title || "").replace(/\s*[-|]\s*ProQuest\s*$/i, "");
    return ((h1?.textContent || "").trim() || dt).trim();
  }).catch(() => "");
  if (work.title && !titlesMatch(work.title, fullTitle) && !titlesMatch(work.title, body.slice(0, 600))) {
    return { status: "title_mismatch", url: page.url() };
  }
  const m = body.replace(/\r/g, "\n").match(
    /\bAbstract\b\s*(?:Translate[^\n]*)?\n+([\s\S]{80,2200}?)(?=\n\s*(?:Full Text|Full text|Indexing|Details|Subject|References|Show less|You have requested)\b|$)/i,
  );
  let abs = m ? compact(m[1].replace(/^Learn more about Translate\s*/i, "")) : "";
  if (!good(abs, 100)) return { status: "no_abstract", url: page.url() };
  return { status: "ok", abstract: abs, url: page.url() };
}

async function main() {
  const targets = await loadTargets();
  console.log(`=== ProQuest ABI/INFORM abstract backfill ===`);
  console.log(`Dry run: ${DRY_RUN} | targets: ${targets.length} | year>=${YEAR_MIN}${YEAR_MAX != null ? ` | year<=${YEAR_MAX}` : ""}${VENUES.length ? " | venues:" + VENUES.length : ""}`);
  if (!targets.length) { console.log("No targets."); return; }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: true,
    args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"], channel: "msedge",
  }).catch(async () => chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome" }));
  const page = (await ctx.pages())[0] || await ctx.newPage();
  await page.goto("https://globalhome.nyu.edu", { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
  console.log(`[pq] Log into ProQuest ABI/INFORM. Continuing in ${LOGIN_WAIT_MS / 1000}s...`);
  await page.waitForTimeout(LOGIN_WAIT_MS);

  const stats = { ok: 0, no_abstract: 0, no_result: 0, title_mismatch: 0, no_search_box: 0, session_expired: 0, error: 0 };
  const writtenIds = [];
  for (let i = 0; i < targets.length; i++) {
    const w = targets[i];
    let r;
    try { r = await searchAndExtract(page, w); } catch (e) { r = { status: "error", err: e.message }; }
    stats[r.status] = (stats[r.status] || 0) + 1;
    console.log(`${i + 1}/${targets.length} ${r.status} ${doiOf(w)} :: ${compact(w.title).slice(0, 55)}`);
    if (r.status === "session_expired") { console.log("Session expired — stopping. Re-login and re-run."); break; }
    if (r.status === "ok" && !DRY_RUN) {
      const rd = { ...(w.raw_data || {}), abstract_backfill: { source: "proquest_abi", status: "formal_abstract", matched_at: new Date().toISOString(), url: r.url } };
      const { error } = await supabase.from("works").update({ abstract: r.abstract, raw_data: rd }).eq("id", w.id).is("abstract", null);
      if (error) { console.log(`   write error: ${error.message}`); stats.error++; } else { writtenIds.push(w.id); }
    } else if (r.status === "ok") {
      console.log(`   would_write (${r.abstract.length} chars): ${r.abstract.slice(0, 100)}...`);
    } else if (!DRY_RUN && ["no_abstract", "title_mismatch", "no_result", "error"].includes(r.status)) {
      // Mark as attempted so future batches SKIP it (no abstract on ProQuest /
      // not found / bad DB title). Additive to raw_data; never touches abstract
      // (golden-rule safe). session_expired is NOT marked — it's transient.
      const rd = { ...(w.raw_data || {}), proquest_attempt: { status: r.status, at: new Date().toISOString() } };
      await supabase.from("works").update({ raw_data: rd }).eq("id", w.id);
    }
    await jitter();
  }
  console.log("=== Done ===", JSON.stringify(stats));
  if (writtenIds.length) {
    const fs = await import("node:fs");
    const path = `reports/proquest-written-ids-${new Date().toISOString().slice(0, 10)}.json`;
    fs.mkdirSync("reports", { recursive: true });
    // Merge with any earlier same-day batch so a multi-session day re-embeds all of them.
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(path, "utf8")).ids || []; } catch {}
    const ids = [...new Set([...existing, ...writtenIds])];
    fs.writeFileSync(path, JSON.stringify({ ids }));
    console.log(`wrote ${ids.length} ids → ${path}\n  re-embed: node scripts/backfill-reembed-with-abstract.mjs --ids-file ${path}`);
  }
  await ctx.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
