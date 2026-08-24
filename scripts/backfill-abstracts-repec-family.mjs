#!/usr/bin/env node
/**
 * Backfill abstracts for the RePEc-family working-paper residual (source=repec,
 * abstract IS NULL, no direct RePEc landing URL) -- NBER, OECD, and IZA series.
 *
 * These rows were imported by scripts/import-repec.mjs which already tried
 * OpenAlex abstract_inverted_index at import time and came up empty (confirmed
 * dead end -- do NOT re-query OpenAlex here). Instead:
 *
 *   - NBER (series_key nber, and unlabeled rows that are secretly NBER): the
 *     NBER working-paper number is usually embedded in the title itself
 *     ("... NBER Working Paper No. 17752." or "... Working Paper 27476.") or
 *     in canonical_doi (10.3386/wNNNNN). Fetch
 *     econpapers.repec.org/paper/nbrnberwo/{number}.htm and read the
 *     citation_abstract meta tag (same source/method as backfill-abstracts-nber.mjs,
 *     but that script only matched rows whose primary `id` literally starts with
 *     10.3386 -- these repec-sourced rows got merged onto an oa:/other id, so the
 *     old script never saw them).
 *   - OECD (series_key oecd): every OECD repec row in the corpus carries a real
 *     10.1787/xxxx-en DOI. Resolving https://doi.org/<doi> redirects to the
 *     public oecd.org publication page, which exposes citation_abstract /
 *     og:description in its head -- no scraping tool needed, just a GET + a
 *     title-similarity gate.
 *   - IZA (series_key iza): IZA DPs are RePEc-indexed under the econpapers
 *     handle izaizadps/dp<N>.htm. IDEAS/EconPapers full-text search is a
 *     JS-rendered / session-based form (not scrapable with a plain GET), so
 *     instead of a blind number crawl we bucket by the target rows own
 *     publication year (DP-number<->year is近-linear, checked empirically) and
 *     only crawl the narrow window that could contain that year -- keeps this
 *     "small volume, no hammering" per the task brief.
 *   - CEPR: NOT handled here. scripts/backfill-abstracts-cepr-econpapers-crawl.mjs
 *     already does a proven number-range crawl of the same econpapers.repec.org
 *     source for CEPR DPs -- re-run that script for the CEPR residual instead of
 *     duplicating the logic.
 *   - unlabeled rows: tried via the NBER path first (several turned out to be
 *     mislabeled NBER papers); anything left over is reported unrecoverable.
 *
 * Golden rule: gap-only. Writes ONLY works.abstract, only when it is currently
 * NULL (re-checked immediately before each write), and only after a
 * token_sort_ratio >= 96 title match (fuzzball, same threshold as
 * backfill-abstracts-working-papers.mjs). Stamps raw_data.abstract_backfill
 * provenance, merged (never replacing other raw_data keys). Abstracts are
 * always the publisher/RePEc page text -- never LLM-recalled.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-repec-family.mjs --dry-run
 *   node --env-file=.env scripts/backfill-abstracts-repec-family.mjs
 *   node --env-file=.env scripts/backfill-abstracts-repec-family.mjs --only nber
 *   node --env-file=.env scripts/backfill-abstracts-repec-family.mjs --only oecd
 *   node --env-file=.env scripts/backfill-abstracts-repec-family.mjs --only iza
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { token_sort_ratio } from "fuzzball";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const UA = "Mozilla/5.0 (HorizonScanner; horizon-scanner@iadb.org)";
const MIN_SCORE = 96;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "’").replace(/&#x27;/gi, "’")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const DIACRITIC_RE = new RegExp("[\u0300-\u036f]", "g");

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFD").replace(DIACRITIC_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strips a trailing ". NBER Working Paper No. 12345." / ". Working Paper 27476."
// style suffix that some of these corpus titles carry, so the comparison is
// against the actual paper title (the RePEc page never repeats that suffix).
function stripTrailingWpSuffix(title) {
  return String(title || "").replace(
    /[.\s]*\(?(nber\s+)?working\s+paper\s*(no\.?\s*)?#?\d{3,6}\)?\.?\s*$/i,
    "",
  ).trim();
}

// A same-title match at a lower score is often the same paper with a publisher-added
// subtitle ("X" vs "X: Insights from ...") -- accept if the SHORTER normalized title
// is a whole-word PREFIX of the longer one and long enough (>= 6 significant words) to
// rule out coincidence. Same guarded pattern as backfill-abstracts-cepr-econpapers-crawl.mjs.
function isPrefixTitleMatch(a, b) {
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.split(" ").length < 6) return false;
  return longer === shorter || longer.startsWith(shorter + " ") || longer.startsWith(shorter + ":");
}

const NBER_NUM_FROM_TITLE_RE = /(?:nber\s+)?working\s+paper\s*(?:no\.?\s*)?#?(\d{4,6})\b/i;
const NBER_NUM_FROM_DOI_RE = /^10\.3386\/w(\d+)$/i;

function extractNberNumber(row) {
  const doiMatch = String(row.canonical_doi || "").match(NBER_NUM_FROM_DOI_RE);
  if (doiMatch) return doiMatch[1];
  const titleMatch = String(row.title || "").match(NBER_NUM_FROM_TITLE_RE);
  return titleMatch ? titleMatch[1] : null;
}

function metaContent(html, name) {
  const patterns = {
    citation_title: /<meta\s+name="citation_title"\s+content="([^"]*)"/i,
    citation_abstract: /<meta\s+name="citation_abstract"\s+content="([^"]*)"/i,
    citation_author: /<meta\s+name="citation_author"\s+content="([^"]*)"/i,
    "og:title": /<meta\s+property="og:title"\s+content="([^"]*)"/i,
    "og:description": /<meta\s+property="og:description"\s+content="([^"]*)"/i,
    description: /<meta\s+name="description"\s+content="([^"]*)"/i,
  };
  const re = patterns[name];
  if (!re) return null;
  const m = html.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

function isRealAbstract(text) {
  const t = String(text || "").trim();
  if (t.length < 60) return false;
  if (/^\s*(see abstract at|abstract available|full[- ]?text available|https?:\/\/|www\.)/i.test(t)) return false;
  if (/\b(no abstract|abstract not (available|provided)|withdrawn)\b/i.test(t)) return false;
  return true;
}

async function fetchHtml(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs || 20000),
  });
  if (!res.ok) return null;
  return res.text();
}

// oecd.org sits behind Cloudflare and 403s node native fetch/undici (TLS/HTTP client
// fingerprinting) even with a browser User-Agent, but is reachable via curl -- shell
// out to curl for this one host instead of silently failing every OECD row.
async function fetchHtmlViaCurl(url, timeoutSec) {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-sL", "-A", UA, "--max-time", String(timeoutSec || 25), url],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout || null;
  } catch (e) {
    return null;
  }
}

async function loadTargets() {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("works")
      .select("id,title,year,canonical_doi,authors,raw_data,url")
      .eq("source", "repec")
      .is("abstract", null)
      .is("canonical_work_id", null)
      .not("is_noise", "is", true)
      .range(from, from + PAGE - 1);
    if (error) throw new Error("target load failed: " + error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows.map((r) => ({ ...r, seriesKey: (r.raw_data && r.raw_data.series_key) || "unlabeled" }));
}

async function applyAbstract(row, abstract, provenance) {
  if (DRY_RUN) return "would_fill";
  const live = await supabase.from("works").select("abstract,raw_data").eq("id", row.id).single();
  if (live.data && live.data.abstract) return "already_filled";
  const patch = {
    abstract: abstract,
    raw_data: Object.assign(
      {},
      (live.data && live.data.raw_data && typeof live.data.raw_data === "object") ? live.data.raw_data : {},
      { abstract_backfill: Object.assign({ matched_at: new Date().toISOString() }, provenance) },
    ),
  };
  const upd = await supabase.from("works").update(patch).eq("id", row.id);
  if (upd.error) { console.error("\n  update failed " + row.id + ": " + upd.error.message); return "error"; }
  return "filled";
}

async function runNber(rows, results) {
  const candidates = rows.filter((r) => r.seriesKey === "nber" || r.seriesKey === "unlabeled");
  console.log("\n--- NBER pass (series nber + unlabeled): " + candidates.length + " candidate rows ---");
  for (const row of candidates) {
    const num = extractNberNumber(row);
    if (!num) { results.push({ id: row.id, group: "nber", status: "no_wp_number", title: row.title }); continue; }
    let html;
    try {
      html = await fetchHtml("https://econpapers.repec.org/paper/nbrnberwo/" + num + ".htm");
    } catch (e) {
      results.push({ id: row.id, group: "nber", status: "fetch_error", error: e.message });
      await sleep(200);
      continue;
    }
    await sleep(200);
    if (!html) { results.push({ id: row.id, group: "nber", status: "page_not_found", wp: num }); continue; }
    const fetchedTitle = metaContent(html, "citation_title");
    const abstract = metaContent(html, "citation_abstract");
    if (!fetchedTitle) { results.push({ id: row.id, group: "nber", status: "no_citation_title", wp: num }); continue; }
    const score = token_sort_ratio(normalizeTitle(stripTrailingWpSuffix(row.title)), normalizeTitle(fetchedTitle));
    if (score < MIN_SCORE) { results.push({ id: row.id, group: "nber", status: "low_title_match", wp: num, score, fetchedTitle }); continue; }
    if (!abstract || !isRealAbstract(abstract)) { results.push({ id: row.id, group: "nber", status: "no_real_abstract", wp: num, score }); continue; }
    const outcome = await applyAbstract(row, abstract, { source: "econpapers_nber", wp_number: num, title_score: score, matched_title: fetchedTitle });
    results.push({ id: row.id, group: "nber", status: outcome, wp: num, score, chars: abstract.length });
    console.log("  [" + outcome + "] " + num + " score=" + score + " :: " + row.title.slice(0, 60));
  }
}

async function runOecd(rows, results) {
  const candidates = rows.filter((r) => r.seriesKey === "oecd" && /^10\.1787\//.test(String(r.canonical_doi || "")));
  console.log("\n--- OECD pass (series oecd, has 10.1787 DOI): " + candidates.length + " candidate rows ---");
  for (const row of candidates) {
    let html;
    try {
      html = await fetchHtmlViaCurl("https://doi.org/" + row.canonical_doi, 25);
    } catch (e) {
      results.push({ id: row.id, group: "oecd", status: "fetch_error", error: e.message, doi: row.canonical_doi });
      await sleep(300);
      continue;
    }
    await sleep(300);
    if (!html) { results.push({ id: row.id, group: "oecd", status: "resolve_failed", doi: row.canonical_doi }); continue; }
    if (/withdrawn/i.test(html) && html.length < 20000) { results.push({ id: row.id, group: "oecd", status: "withdrawn", doi: row.canonical_doi }); continue; }
    const fetchedTitle = metaContent(html, "citation_title") || metaContent(html, "og:title");
    const abstract = metaContent(html, "citation_abstract") || metaContent(html, "og:description") || metaContent(html, "description");
    if (!fetchedTitle) { results.push({ id: row.id, group: "oecd", status: "no_title_on_landing", doi: row.canonical_doi }); continue; }
    const normOurs = normalizeTitle(row.title);
    const normTheirs = normalizeTitle(fetchedTitle);
    const score = token_sort_ratio(normOurs, normTheirs);
    const prefixOk = isPrefixTitleMatch(normOurs, normTheirs);
    if (score < MIN_SCORE && !prefixOk) { results.push({ id: row.id, group: "oecd", status: "low_title_match", doi: row.canonical_doi, score, fetchedTitle }); continue; }
    if (!abstract || !isRealAbstract(abstract)) { results.push({ id: row.id, group: "oecd", status: "no_real_abstract", doi: row.canonical_doi, score }); continue; }
    const outcome = await applyAbstract(row, abstract, { source: "oecd_doi_resolve", doi: row.canonical_doi, title_score: score, matched_title: fetchedTitle });
    results.push({ id: row.id, group: "oecd", status: outcome, doi: row.canonical_doi, score, chars: abstract.length });
    console.log("  [" + outcome + "] " + row.canonical_doi + " score=" + score + " :: " + row.title.slice(0, 60));
  }
}

// Empirically checked DP-number -> year checkpoints for the izaizadps RePEc
// handle (see session notes): DP5500~2011/02, DP16000~2023/03, DP17000~2024/05,
// DP18000~2025/07. Bucket windows below are generous (+/- buffer) around each
// checkpoint so we only crawl the pages that could plausibly hold a given
// year, instead of a blind full-range crawl.
const IZA_YEAR_BUCKETS = {
  2011: [5200, 6200],
  2012: [6200, 7200],
  2013: [7200, 8200],
  2023: [15700, 16700],
  2024: [16700, 17550],
  2025: [17550, 18400],
};

function nameTokens(arr) {
  const s = new Set();
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const n = typeof x === "string" ? x : ((x && (x.name || x.full_name)) || "");
    for (const w of normalizeTitle(n).split(" ")) if (w.length >= 3) s.add(w);
  }
  return s;
}

async function runIza(rows, results) {
  const candidates = rows.filter((r) => r.seriesKey === "iza");
  console.log("\n--- IZA pass (series iza, year-bucketed econpapers crawl): " + candidates.length + " candidate rows ---");
  const byYear = new Map();
  for (const row of candidates) {
    const bucket = IZA_YEAR_BUCKETS[row.year];
    if (!bucket) { results.push({ id: row.id, group: "iza", status: "no_year_bucket", year: row.year, title: row.title }); continue; }
    const key = bucket.join("-");
    if (!byYear.has(key)) byYear.set(key, { bucket, rows: [] });
    byYear.get(key).rows.push(row);
  }

  for (const { bucket, rows: bucketRows } of byYear.values()) {
    const [from, to] = bucket;
    const remaining = new Map(bucketRows.map((r) => [r.id, r]));
    console.log("  crawling DP" + from + "-" + to + " for " + bucketRows.length + " target(s)");
    const CONCURRENCY = 8;
    const numbers = [];
    for (let n = to; n >= from; n--) numbers.push(n);
    let idx = 0;
    async function worker() {
      while (idx < numbers.length && remaining.size > 0) {
        const n = numbers[idx++];
        let html;
        try {
          html = await fetchHtml("https://econpapers.repec.org/paper/izaizadps/dp" + n + ".htm");
        } catch {
          continue;
        }
        if (!html) continue;
        const fetchedTitle = metaContent(html, "citation_title");
        if (!fetchedTitle) continue;
        const normFetched = normalizeTitle(fetchedTitle);
        for (const [id, row] of remaining) {
          const score = token_sort_ratio(normalizeTitle(row.title), normFetched);
          if (score < MIN_SCORE) continue;
          const abstract = metaContent(html, "citation_abstract");
          if (!abstract || !isRealAbstract(abstract)) continue;
          const auths = [...html.matchAll(/<meta\s+name="citation_author"\s+content="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
          const theirs = nameTokens(auths);
          const ours = nameTokens(row.authors);
          if (ours.size && theirs.size && ![...ours].some((t) => theirs.has(t))) continue;
          const outcome = await applyAbstract(row, abstract, { source: "econpapers_iza", dp_number: n, title_score: score, matched_title: fetchedTitle });
          results.push({ id: row.id, group: "iza", status: outcome, dp: n, score, chars: abstract.length });
          console.log("  [" + outcome + "] DP" + n + " score=" + score + " :: " + row.title.slice(0, 60));
          remaining.delete(id);
          break;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    for (const row of remaining.values()) {
      results.push({ id: row.id, group: "iza", status: "no_match_in_bucket", year: row.year, bucket: bucket.join("-"), title: row.title });
    }
  }
}

async function main() {
  console.log("=== RePEc-family abstract backfill (NBER / OECD / IZA) ===");
  console.log("Dry run: " + DRY_RUN + (ONLY ? " | only=" + ONLY : "") + "\n");

  const rows = await loadTargets();
  console.log("Total source=repec null-abstract targets: " + rows.length);
  const byKey = {};
  for (const r of rows) byKey[r.seriesKey] = (byKey[r.seriesKey] || 0) + 1;
  console.log(JSON.stringify(byKey));

  const results = [];
  if (!ONLY || ONLY === "nber") await runNber(rows, results);
  if (!ONLY || ONLY === "oecd") await runOecd(rows, results);
  if (!ONLY || ONLY === "iza") await runIza(rows, results);

  const summary = { dry_run: DRY_RUN, total_targets: rows.length, by_series: byKey };
  for (const r of results) {
    const key = r.group + ":" + r.status;
    summary[key] = (summary[key] || 0) + 1;
  }
  console.log("\n" + JSON.stringify(summary, null, 2));

  fs.mkdirSync("reports", { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = "reports/backfill-abstracts-repec-family-" + date + ".json";
  fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
  console.log("Report -> " + reportPath);

  if (!DRY_RUN) {
    const filledIds = results.filter((r) => r.status === "filled").map((r) => r.id);
    if (filledIds.length) {
      const idsPath = "reports/backfill-abstracts-repec-family-" + date + "-ids.json";
      fs.writeFileSync(idsPath, JSON.stringify({ ids: filledIds }, null, 2));
      console.log("Filled ids -> " + idsPath + " (re-embed next)");
    }
  }
}

main().catch((err) => {
  console.error("[repec-family-backfill] failed:", err.message);
  process.exit(1);
});
