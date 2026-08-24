#!/usr/bin/env node
/**
 * Upgrade existing evidence cards using authenticated Project MUSE PDF text.
 *
 * This does not write abstracts. It targets MUSE rows whose abstract backfill
 * found PDF-only access / no labeled abstract, fetches the PDF through the
 * persistent Playwright profile, extracts relevant sections, and asks the LLM
 * to upgrade grounded evidence-card fields.
 *
 * Usage:
 *   node scripts/enrich-evidence-muse-pdf.mjs --list-targets --limit 25
 *   node scripts/enrich-evidence-muse-pdf.mjs --dry-run --limit 2 --manual-login
 *   node scripts/enrich-evidence-muse-pdf.mjs --ids 10.1353/jhr.2009.0008,10.1353/jhr.2010.0003 --manual-login
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PDFParse } from "pdf-parse";
import { filterDeniedVenues, loadVenueDenylist } from "./lib/venue-denylist.mjs";
import { isGenericNonPrimaryTitle } from "./lib/generic-title-policy.mjs";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? process.env.QWEN_ENDPOINT ??
  (process.env.LLM_BASE_URL ? `${process.env.LLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions` : "https://llm.iotaimpact.com/v1/chat/completions");
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const LLM_MODEL = process.env.MUSE_PDF_EVIDENCE_MODEL ?? process.env.TIER2_MODEL ?? process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? "qwen2.5:14b-synthesis";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[muse-evidence] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

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
const KEEP_OPEN_MS = Number(argValue("--keep-open-ms", "0")) || 0;
const TIMEOUT_MS = Number(argValue("--timeout-ms", "45000"));
const LLM_TIMEOUT_MS = Number(argValue("--llm-timeout-ms", "180000"));
const PDF_PAGES = Number(argValue("--pages", process.env.MUSE_EVIDENCE_PDF_PAGES || "18"));
const MAX_BYTES = Number(argValue("--max-bytes", String(25 * 1024 * 1024)));
const IDS = String(argValue("--ids", ""))
  .split(",")
  .map((s) => normDoi(s))
  .filter(Boolean);
const TARGET_FIELDS = String(argValue("--target-fields", "study_design,country,region,setting,population_group,intervention,outcome,treatment_group,control_group,effect_direction,effect_size_text,statistical_significance,sample_size,sample_size_text,identification_strategy,time_horizon,data_source,limitations,heterogeneity,secondary_findings,mechanism,external_validity_note,finding_short"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VENUE_DENYLIST = loadVenueDenylist();
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join("reports", `muse-pdf-evidence-enrichment-${TODAY}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!LIST_TARGETS && !LLM_API_KEY) {
  console.error(`[muse-evidence] Missing LLM_API_KEY/OPENAI_API_KEY for ${LLM_ENDPOINT}`);
  process.exit(1);
}

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
    .trim();
}

function cleanPdfText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function ratingValue(value) {
  const text = String(value || "").trim();
  if (text === "4*") return 4.5;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUsableText(value, minLength = 3) {
  if (value == null) return false;
  const text = String(value).trim();
  if (text.length < minLength) return false;
  const lower = text.toLowerCase();
  return !["unclear", "unknown", "n/a", "na", "none", "null"].includes(lower);
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

function normalizeDirection(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (["positive", "negative", "null", "mixed", "unclear"].includes(s)) return s;
  if (s.includes("no significant") || s.includes("not significant") || s.includes("no detectable")) return "null";
  if (s.includes("mixed")) return "mixed";
  return "unclear";
}

function deriveConfidence(card) {
  function baseDesign(d) {
    const s = String(d || "").trim().toLowerCase();
    if (s === "rct") return 4;
    if (["quasi-experimental", "did", "iv", "rdd", "matching", "synthetic control"].includes(s)) return 3;
    if (["review", "systematic review", "meta-analysis"].includes(s)) return 3;
    if (s === "observational" || s === "qualitative") return 2;
    return 1;
  }
  function sampleAdj(n, d) {
    if (n == null || Number.isNaN(Number(n))) return -1;
    const value = Number(n);
    if (value >= 5000) return 1;
    if (value >= 500) return 0;
    const exp = ["rct", "quasi-experimental"].includes(String(d || "").toLowerCase());
    if (value >= 100) return exp ? -1 : 0;
    return -2;
  }
  function clarityAdj(dir, size, sig) {
    if (!isUsableText(dir)) return -2;
    if (isUsableText(size) && isUsableText(sig)) return 1;
    if (isUsableText(size)) return 0;
    return -1;
  }
  function controlAdj(t, c) {
    const tOk = isUsableText(t);
    const cOk = isUsableText(c);
    if (tOk && cOk) return 0;
    if (tOk || cOk) return -1;
    return -2;
  }
  const score = baseDesign(card.study_design) +
    sampleAdj(card.sample_size, card.study_design) +
    clarityAdj(card.effect_direction, card.effect_size_text, card.statistical_significance) +
    controlAdj(card.treatment_group, card.control_group);
  return { score, band: score >= 5 ? "high" : score >= 2 ? "medium" : "low" };
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
  const select = "id,title,year,venue,canonical_doi,authors,abstract,raw_data,citation_count,url,open_access_pdf_url,abs_rating,publication_type,venue_kind,methodology_design";
  let query = supabase.from("works").select(select);
  if (IDS.length) query = query.in("canonical_doi", IDS);
  else {
    if (YEAR_MIN > 0) query = query.gte("year", YEAR_MIN);
    if (MIN_ABS_RATING > 0) query = query.in("abs_rating", ["3", "4", "4*"]);
    if (JOURNAL_ONLY) query = query.or("venue_kind.eq.journal,publication_type.eq.journal_article");
  }
  const rows = filterDeniedVenues(await selectAll(query.order("citation_count", { ascending: false, nullsFirst: false })), VENUE_DENYLIST)
    .filter((row) => !isExcludedNonPrimary(row))
    .filter(looksMuse)
    .filter((row) => IDS.length || ["pdf_only", "pdf_no_abstract_section"].includes(row.raw_data?.abstract_backfill?.status) || priorPdfUrl(row))
    .filter((row) => MIN_ABS_RATING <= 0 || ratingValue(row.abs_rating) >= MIN_ABS_RATING)
    .filter((row) => !JOURNAL_ONLY || isJournal(row))
    .map((row) => ({ ...row, muse_pdf_start_url: candidateStartUrl(row) }))
    .filter((row) => row.muse_pdf_start_url)
    .sort((a, b) =>
      ratingValue(b.abs_rating) - ratingValue(a.abs_rating) ||
      Number(b.year || 0) - Number(a.year || 0) ||
      Number(b.citation_count || 0) - Number(a.citation_count || 0),
    );
  const limited = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  return attachCards(limited);
}

async function attachCards(works) {
  const out = [];
  for (let i = 0; i < works.length; i += 80) {
    const chunk = works.slice(i, i + 80);
    const { data, error } = await supabase
      .from("evidence_cards")
      .select("*")
      .in("work_id", chunk.map((row) => row.id));
    if (error) throw new Error(`evidence_cards fetch: ${error.message}`);
    const byWork = new Map((data || []).map((card) => [card.work_id, card]));
    for (const work of chunk) out.push({ work, card: byWork.get(work.id) || null });
  }
  return out;
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
    console.warn(`[muse-evidence] Could not launch Edge channel (${err.message}); trying Chrome channel.`);
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
    console.log(`[muse-evidence] Verification page is open for ${work.id}; complete it in the browser. Waiting up to ${VERIFY_WAIT_MS}ms...`);
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

async function requestPdfBuffer(context, pdfUrl) {
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

async function fetchPdfBuffer(context, page, pdfUrl, work) {
  let fetched = await requestPdfBuffer(context, pdfUrl);
  if (fetched.ok) return fetched;

  if (
    VERIFY_WAIT_MS > 0 &&
    fetched.reason === "not_pdf_magic" &&
    /muse\.jhu\.edu\/(?:verify\?|(?:pub\/\d+\/)?article\/\d+\/pdf)/i.test(fetched.finalUrl || pdfUrl || "")
  ) {
    const verifyUrl = /muse\.jhu\.edu\/verify\?/i.test(fetched.finalUrl || "") ? fetched.finalUrl : pdfUrl;
    console.log(`[muse-evidence] Opening MUSE PDF/verification page for ${work.id}; complete any verification in the browser. Waiting up to ${VERIFY_WAIT_MS}ms...`);
    await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    const started = Date.now();
    while (Date.now() - started < VERIFY_WAIT_MS) {
      await sleep(2000);
      fetched = await requestPdfBuffer(context, pdfUrl);
      if (fetched.ok) return fetched;
      const currentUrl = page.url();
      if (/muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+\/pdf(?:[?#].*)?$/i.test(currentUrl)) break;
      const text = await page.locator("body").innerText({ timeout: TIMEOUT_MS }).catch(() => "");
      if (!/\b(verification required|friendly captcha)\b/i.test(text) && /muse\.jhu\.edu\/(?:pub\/\d+\/)?article\/\d+/i.test(currentUrl)) {
        await sleep(2000);
      }
    }
    fetched = await requestPdfBuffer(context, pdfUrl);
    if (fetched.ok) return fetched;

    const currentPdf = pdfUrlFromCurrent(page.url());
    if (currentPdf && currentPdf !== pdfUrl) {
      fetched = await requestPdfBuffer(context, currentPdf);
      if (fetched.ok) return fetched;
      return { ...fetched, attemptedUrl: currentPdf };
    }
  }

  return fetched;
}

async function parsePdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const pages = Array.from({ length: PDF_PAGES }, (_, index) => index + 1);
    const result = await parser.getText({ partial: pages });
    return cleanPdfText(result.text || "");
  } finally {
    await parser.destroy();
  }
}

function extractRelevantText(pdfText, work) {
  const sections = [];
  const patterns = [
    ["abstract", /(?:^|\n)\s*(?:abstract|summary)\s*\n([\s\S]{400,3500}?)(?=\n\s*(?:keywords?|jel|introduction|i\.|1\.?)\b|$)/i],
    ["methods", /(?:^|\n)\s*(?:[0-9.]+\s*)?(methods?|methodology|empirical strategy|identification strategy|research design|data and methods?)\s*\n([\s\S]{700,6500}?)(?=\n\s*(?:[0-9.]+\s*)?(?:results?|findings?|discussion|conclusion|references)\b|$)/i],
    ["results", /(?:^|\n)\s*(?:[0-9.]+\s*)?(results?|findings?|impact estimates?|main results?)\s*\n([\s\S]{700,8000}?)(?=\n\s*(?:[0-9.]+\s*)?(?:discussion|conclusion|references|appendix)\b|$)/i],
    ["conclusion", /(?:^|\n)\s*(?:[0-9.]+\s*)?(discussion|conclusion|concluding remarks)\s*\n([\s\S]{700,5500}?)(?=\n\s*(?:references|appendix)\b|$)/i],
  ];
  for (const [name, pattern] of patterns) {
    const match = pdfText.match(pattern);
    const text = compactText(match?.[2] || match?.[1] || "");
    if (text.length >= 300) sections.push(`## ${name}\n${text.slice(0, 7000)}`);
  }
  const titleChunk = `## title\n${work.title || ""}`;
  const abstractChunk = work.abstract ? `## existing abstract\n${work.abstract}` : "";
  if (sections.length) return [titleChunk, abstractChunk, ...sections].filter(Boolean).join("\n\n");
  return [titleChunk, abstractChunk, `## pdf excerpt\n${compactText(pdfText).slice(0, 22000)}`].filter(Boolean).join("\n\n");
}

function pickCardForPrompt(card) {
  if (!card) return null;
  const keys = [
    "study_design", "intervention", "outcome", "treatment_group", "control_group",
    "effect_direction", "effect_size_text", "statistical_significance", "sample_size",
    "sample_size_text", "identification_strategy", "time_horizon", "data_source",
    "source_text", "finding_short", "confidence", "confidence_score", "needs_review",
  ];
  return Object.fromEntries(keys.map((key) => [key, card[key]]));
}

function buildPrompt({ work, card, sourceText }) {
  return `You are upgrading an existing evidence card for a policy research database using authenticated Project MUSE PDF text.

Rules:
- Only use facts explicitly present in the supplied PDF text.
- Do not invent missing values.
- If a target field is not supported by the text, return null for that field and list it in ungrounded_fields.
- Preserve the paper's language for free-text extracted values.
- For effect_direction, output exactly: positive, negative, null, mixed, or unclear.
- For study_design, output exactly: RCT, quasi-experimental, observational, qualitative, review, or descriptive.
- For source_text, provide the shortest verbatim passage that supports the upgraded fields.
- This is evidence-card enrichment, not abstract generation.

Target fields to improve: ${TARGET_FIELDS.join(", ")}

Paper:
Title: ${work.title || ""}
Existing abstract: ${work.abstract || ""}
Pre-classified methodology: ${work.methodology_design || "unknown"}

Existing evidence card:
${JSON.stringify(pickCardForPrompt(card), null, 2)}

PDF text:
${sourceText}

Return JSON only with this shape:
{
  "study_design": "RCT|quasi-experimental|observational|qualitative|review|descriptive|null",
  "country": ["string"],
  "region": ["string"],
  "setting": "string|null",
  "population_group": "string|null",
  "intervention": "string|null",
  "outcome": "string|null",
  "treatment_group": "string|unclear|null",
  "control_group": "string|unclear|null",
  "effect_direction": "positive|negative|null|mixed|unclear",
  "effect_size_text": "string|null",
  "effect_size_numeric": "number|null",
  "effect_type": "percentage_points|percent|SD|OR|RR|HR|absolute|unclear|null",
  "statistical_significance": "string|null",
  "sample_size": "integer|null",
  "sample_size_text": "string|null",
  "identification_strategy": "string|null",
  "time_horizon": "string|null",
  "data_source": "survey|administrative|mixed|experimental|unclear|null",
  "limitations": ["string"],
  "heterogeneity": "string|null",
  "secondary_findings": "string|null",
  "mechanism": "string|null",
  "external_validity_note": "string|null",
  "source_section": "results|methods|conclusion|table|mixed|pdf_excerpt",
  "source_text": "short verbatim quote from PDF text",
  "ungrounded_fields": ["string"],
  "finding_short": "30-300 word grounded summary"
}`;
}

async function generateJSON(prompt) {
  const response = await fetch(LLM_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "Extract structured evidence-card upgrades from PDF text. Output JSON only." },
        { role: "user", content: prompt },
      ],
      stream: false,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`LLM error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return JSON.parse(String(content).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
}

function normalizeValue(key, value) {
  if (value == null) return null;
  if (key === "sample_size") {
    const n = Number(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (key === "effect_size_numeric") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (["limitations", "ungrounded_fields", "country", "region", "secondary_outcomes"].includes(key)) {
    return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  }
  return typeof value === "string" ? value.trim() : value;
}

function buildPatch(existing, extracted) {
  const allowed = new Set([
    ...TARGET_FIELDS,
    "effect_size_numeric",
    "effect_type",
    "secondary_outcomes",
    "source_section",
    "source_text",
    "ungrounded_fields",
    "finding_short",
  ]);
  const patch = {};
  for (const key of allowed) {
    if (!(key in extracted)) continue;
    const value = normalizeValue(key, extracted[key]);
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (key === "source_text" && !isUsableText(value, 40)) continue;
    patch[key] = key === "effect_direction" ? normalizeDirection(value) : value;
  }
  const conf = deriveConfidence({ ...(existing || {}), ...patch });
  patch.confidence = conf.band;
  patch.confidence_score = conf.score;
  patch.extraction_tier = 2;
  patch.extracted_by = `${LLM_MODEL}:muse-pdf`;
  patch.extraction_prompt_version = "muse-pdf-evidence-v1";
  patch.extracted_at = new Date().toISOString();
  patch.needs_review = conf.band === "low";
  patch.source_language = "en";
  return patch;
}

function rawDataFor(work, enrichment) {
  return {
    ...(work.raw_data || {}),
    evidence_enrichment: {
      ...(work.raw_data?.evidence_enrichment || {}),
      project_muse_pdf: {
        status: enrichment.status,
        matched_at: new Date().toISOString(),
        model: LLM_MODEL,
        pages_checked: PDF_PAGES,
        pdf_url: enrichment.pdfUrl || null,
        final_url: enrichment.finalUrl || null,
        fields_updated: enrichment.fieldsUpdated || [],
        note: enrichment.note || null,
      },
    },
  };
}

async function updateOutputs({ work, card, patch, enrichment }) {
  if (DRY_RUN) return;
  const required = ["intervention", "outcome", "source_text", "finding_short"];
  for (const key of required) {
    if (!isUsableText(patch[key], key === "source_text" ? 40 : 3)) {
      throw new Error(`cannot ${card ? "update" : "create"} evidence card without ${key}`);
    }
  }
  const payload = card ? patch : { ...patch, work_id: work.id };
  const query = card
    ? supabase.from("evidence_cards").update(payload).eq("work_id", work.id)
    : supabase.from("evidence_cards").upsert(payload, { onConflict: "work_id" });
  const { error: cardError } = await query;
  if (cardError) throw new Error(`evidence_cards update: ${cardError.message}`);
  const { error: workError } = await supabase.from("works").update({ raw_data: rawDataFor(work, enrichment) }).eq("id", work.id);
  if (workError) throw new Error(`works raw_data update: ${workError.message}`);
}

async function processTarget(context, page, target) {
  const { work, card } = target;
  const pdfUrl = await resolvePdfUrl(page, work);
  if (!pdfUrl) return { status: "no_pdf_url", work };
  const fetched = await fetchPdfBuffer(context, page, pdfUrl, work);
  if (!fetched.ok) return { status: "pdf_fetch_error", work, pdfUrl, fetched };
  const pdfText = await parsePdfText(fetched.buffer);
  if (!isUsableText(pdfText, 1000)) return { status: "pdf_text_too_thin", work, pdfUrl, finalUrl: fetched.finalUrl };
  const sourceText = extractRelevantText(pdfText, work);
  const extracted = await generateJSON(buildPrompt({ work, card, sourceText }));
  const patch = buildPatch(card, extracted);
  const fieldsUpdated = Object.keys(patch).filter((key) => !["confidence", "confidence_score", "extraction_tier", "extracted_by", "extraction_prompt_version", "extracted_at", "needs_review", "source_language"].includes(key));
  if (!fieldsUpdated.length) return { status: "no_usable_fields", work, pdfUrl, finalUrl: fetched.finalUrl, extracted };
  await updateOutputs({
    work,
    card,
    patch,
    enrichment: { status: DRY_RUN ? "would_update" : "updated", pdfUrl, finalUrl: fetched.finalUrl, fieldsUpdated },
  });
  return {
    status: DRY_RUN ? "would_update" : card ? "updated" : "created",
    work,
    pdfUrl,
    finalUrl: fetched.finalUrl,
    fieldsUpdated,
    confidence: patch.confidence,
    confidenceScore: patch.confidence_score,
    textPreview: INCLUDE_TEXT_PREVIEW ? compactText(pdfText).slice(0, 1800) : undefined,
    patchPreview: Object.fromEntries(fieldsUpdated.slice(0, 12).map((key) => [key, patch[key]])),
  };
}

async function main() {
  console.log("\n=== Project MUSE PDF evidence-card enrichment ===");
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`List targets only: ${LIST_TARGETS}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Year min: ${YEAR_MIN || "(none)"}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING || "(none)"}`);
  console.log(`Journal only: ${JOURNAL_ONLY}`);
  console.log(`PDF pages: ${PDF_PAGES}`);
  console.log(`Model: ${LLM_MODEL}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Keep browser open after run: ${KEEP_OPEN_MS}ms`);
  console.log("Updates evidence_cards and works.raw_data.evidence_enrichment; abstracts are untouched.\n");

  const targets = await loadTargets();
  console.log(`Targets: ${targets.length}`);
  if (!targets.length) return;

  if (LIST_TARGETS) {
    for (const [index, { work, card }] of targets.entries()) {
      console.log(`${index + 1}/${targets.length} card=${card ? "yes" : "no"} abs=${work.abs_rating || "?"} year=${work.year || "?"} cites=${work.citation_count || 0} ${work.venue || ""} :: ${work.title?.slice(0, 100) || work.id}`);
    }
    return;
  }

  const context = await launchBrowser();
  const page = await context.newPage();
  if (MANUAL_LOGIN || !HEADLESS) {
    await page.goto(LOGIN_URL || targets[0].work.muse_pdf_start_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
    console.log(`[muse-evidence] Browser is open. Log in through NYU/Project MUSE institutional access if needed; continuing in ${LOGIN_WAIT_MS}ms...`);
    await sleep(LOGIN_WAIT_MS);
  }

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    try {
      const result = await processTarget(context, page, target);
      results.push(result);
      console.log(`${i + 1}/${targets.length} ${result.status} fields=${result.fieldsUpdated?.join(",") || "-"} ${target.work.year || ""} ${target.work.venue || ""} :: ${target.work.title?.slice(0, 80) || target.work.id}`);
    } catch (err) {
      results.push({ status: "error", work: target.work, error: err.message });
      console.log(`${i + 1}/${targets.length} error ${target.work.title?.slice(0, 80) || target.work.id}: ${err.message}`);
    }
  }
  if (KEEP_OPEN_MS > 0) {
    console.log(`[muse-evidence] Keeping browser open for ${KEEP_OPEN_MS}ms...`);
    await sleep(KEEP_OPEN_MS);
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
    model: LLM_MODEL,
    targets: targets.length,
    updated: results.filter((r) => r.status === "updated").length,
    created: results.filter((r) => r.status === "created").length,
    would_update: results.filter((r) => r.status === "would_update").length,
    no_pdf_url: results.filter((r) => r.status === "no_pdf_url").length,
    pdf_fetch_error: results.filter((r) => r.status === "pdf_fetch_error").length,
    pdf_text_too_thin: results.filter((r) => r.status === "pdf_text_too_thin").length,
    no_usable_fields: results.filter((r) => r.status === "no_usable_fields").length,
    errors: results.filter((r) => r.status === "error").length,
  };
  mkdirSync("reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error("[muse-evidence] failed:", err);
  process.exit(1);
});
