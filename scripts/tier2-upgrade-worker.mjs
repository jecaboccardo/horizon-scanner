#!/usr/bin/env node
/**
 * Consume evidence_card_upgrade_queue and upgrade existing evidence cards using
 * open-access PDFs. This is intentionally separate from extraction-worker.mjs
 * so fuller PDF extraction cannot slow Tier 1 card creation.
 */

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { PDFParse } from "pdf-parse";
import { hostname } from "node:os";
import { pid } from "node:process";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? process.env.QWEN_ENDPOINT ??
  (process.env.LLM_BASE_URL ? `${process.env.LLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions` : "https://llm.iotaimpact.com/v1/chat/completions");
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const LLM_MODEL = process.env.TIER2_MODEL ?? process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? "qwen2.5:14b-synthesis";

const BATCH_SIZE = Number(argValue("--batch-size", process.env.TIER2_BATCH_SIZE ?? "1"));
const MAX_ATTEMPTS = Number(argValue("--max-attempts", process.env.TIER2_MAX_ATTEMPTS ?? "2"));
const PDF_PAGES = Number(argValue("--pages", process.env.TIER2_PDF_PAGES ?? "16"));
const MAX_BYTES = Number(argValue("--max-bytes", process.env.TIER2_MAX_BYTES ?? String(20 * 1024 * 1024)));
const TIMEOUT_MS = Number(argValue("--timeout-ms", process.env.TIER2_TIMEOUT_MS ?? "30000"));
const POLL_MS = Number(argValue("--poll-ms", process.env.TIER2_POLL_MS ?? "5000"));
const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");
const WORKER_ID = `tier2-${hostname()}-${pid}`;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[tier2] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!LLM_API_KEY) {
  console.error(`[tier2] Missing LLM_API_KEY/OPENAI_API_KEY for ${LLM_ENDPOINT}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUsableText(value, minLength = 3) {
  if (value == null) return false;
  const text = String(value).trim();
  if (text.length < minLength) return false;
  const lower = text.toLowerCase();
  return !["unclear", "unknown", "n/a", "na", "none", "null"].includes(lower);
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

async function claimBatch() {
  const { data, error } = await supabase.rpc("claim_evidence_card_upgrade_batch", { batch_size: BATCH_SIZE });
  if (error) throw new Error(`claim_evidence_card_upgrade_batch error: ${error.message}`);
  return data || [];
}

async function fetchWorkAndCard(workId) {
  const [{ data: work, error: workError }, { data: card, error: cardError }] = await Promise.all([
    supabase
      .from("works")
      .select("id,title,abstract,methodology_design,open_access_pdf_url,url,canonical_doi")
      .eq("id", workId)
      .single(),
    supabase
      .from("evidence_cards")
      .select("*")
      .eq("work_id", workId)
      .single(),
  ]);
  if (workError || !work) throw new Error(`work not found: ${workId}`);
  if (cardError || !card) throw new Error(`evidence card not found: ${workId}`);
  return { work, card };
}

function looksPdfUrl(url) {
  return /\.pdf(?:$|[?#])|\/pdf(?:$|[?#])|pdfdirect|bitstream|\/download(?:$|[?#/])|servlets\/purl/i.test(String(url || ""));
}

const BLOCKED_PDF_HOST_PATTERNS = [
  /(^|\.)aeaweb\.org$/i,
  /(^|\.)academic\.oup\.com$/i,
  /(^|\.)journals\.sagepub\.com$/i,
  /(^|\.)publications\.iadb\.org$/i,
  /(^|\.)openknowledge\.worldbank\.org$/i,
  /(^|\.)doi\.org$/i,
  /(^|\.)dx\.doi\.org$/i,
];

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isKnownBlockedPdfHost(url) {
  const host = hostnameOf(url);
  return !!host && BLOCKED_PDF_HOST_PATTERNS.some((pattern) => pattern.test(host));
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

async function fetchHtml(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
        "User-Agent": "HorizonScanner/1.0 (tier2 evidence-card upgrade; mailto:horizon-scanner@iadb.org)",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("application/pdf")) return [];
    return extractPdfLinksFromHtml(await response.text(), response.url);
  } catch {
    return [];
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

async function candidatePdfUrls(work) {
  const direct = [work.open_access_pdf_url, work.url].filter(Boolean);
  const discovered = [];
  for (const landing of [
    work.open_access_pdf_url,
    work.url,
    work.canonical_doi ? `https://doi.org/${work.canonical_doi}` : null,
  ].filter(Boolean)) {
    if (!looksPdfUrl(landing)) {
      discovered.push(...await fetchHtml(landing));
    }
  }
  return [...new Set([...direct.filter((url) => looksPdfUrl(url)), ...discovered, ...direct])]
    .filter((url) => !isKnownBlockedPdfHost(url));
}

async function fetchPdfBytes(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: "application/pdf,text/html;q=0.7,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: new URL(url).origin,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 HorizonScanner/1.0",
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const size = Number(response.headers.get("content-length") || "0");
  if (!response.ok) throw new Error(`PDF fetch HTTP ${response.status}`);
  if (size > MAX_BYTES) throw new Error(`PDF too large (${size} bytes)`);
  if (!contentType.includes("application/pdf") && !looksPdfUrl(response.url)) {
    throw new Error(`not a PDF (${contentType || "unknown content-type"})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error(`PDF too large (${buffer.length} bytes)`);
  if (buffer.slice(0, 4).toString("latin1") !== "%PDF") throw new Error("not a PDF by magic bytes");
  return buffer;
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

function compactText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRelevantText(pdfText, title, abstract) {
  const sections = [];
  const patterns = [
    ["methods", /(?:^|\n)\s*(?:[0-9.]+\s*)?(methods?|methodology|empirical strategy|identification strategy|research design|data and methods?)\s*\n([\s\S]{800,5000}?)(?=\n\s*(?:[0-9.]+\s*)?(?:results?|findings?|discussion|conclusion|references)\b|$)/i],
    ["results", /(?:^|\n)\s*(?:[0-9.]+\s*)?(results?|findings?|impact estimates?|main results?)\s*\n([\s\S]{800,7000}?)(?=\n\s*(?:[0-9.]+\s*)?(?:discussion|conclusion|references|appendix)\b|$)/i],
    ["conclusion", /(?:^|\n)\s*(?:[0-9.]+\s*)?(discussion|conclusion|concluding remarks)\s*\n([\s\S]{800,5000}?)(?=\n\s*(?:references|appendix)\b|$)/i],
  ];
  for (const [name, pattern] of patterns) {
    const match = pdfText.match(pattern);
    if (match?.[2]) sections.push(`## ${name}\n${compactText(match[2]).slice(0, 6500)}`);
  }

  const titleChunk = title ? `## title\n${title}` : "";
  const abstractChunk = abstract ? `## abstract\n${abstract}` : "";
  if (sections.length) return [titleChunk, abstractChunk, ...sections].filter(Boolean).join("\n\n");

  const fallback = compactText(pdfText).slice(0, 18000);
  return [titleChunk, abstractChunk, `## pdf excerpt\n${fallback}`].filter(Boolean).join("\n\n");
}

function buildUpgradePrompt({ work, card, targetFields, sourceText }) {
  return `You are upgrading an existing evidence card for a policy research database using PDF text.

Rules:
- Only use facts explicitly present in the supplied PDF text.
- Do not invent missing values.
- If a target field is not supported by the text, return null for that field and list it in ungrounded_fields.
- Preserve the paper's language for free-text extracted values.
- For effect_direction, output exactly: positive, negative, null, mixed, or unclear.
- For study_design, output exactly: RCT, quasi-experimental, observational, qualitative, review, or descriptive.
- For source_text, provide the shortest verbatim passage that supports the upgraded fields.

Target fields to improve: ${targetFields.join(", ")}

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
  "source_section": "results|methods|conclusion|table|mixed",
  "source_text": "short verbatim quote from PDF text",
  "ungrounded_fields": ["string"],
  "finding_short": "30-300 word grounded summary"
}`;
}

function pickCardForPrompt(card) {
  const keys = [
    "study_design", "intervention", "outcome", "treatment_group", "control_group",
    "effect_direction", "effect_size_text", "statistical_significance", "sample_size",
    "sample_size_text", "identification_strategy", "time_horizon", "data_source",
    "source_text", "finding_short", "confidence", "confidence_score", "needs_review",
  ];
  return Object.fromEntries(keys.map((key) => [key, card[key]]));
}

async function generateJSON(prompt) {
  const response = await fetch(LLM_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "Extract structured evidence-card upgrades. Output JSON only." },
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
  const stripped = String(content).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(stripped);
}

function targetPatch(existing, extracted, targetFields) {
  const allowed = new Set([
    ...targetFields,
    "study_design",
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
    if (key === "effect_direction") {
      patch[key] = normalizeDirection(value);
    } else {
      patch[key] = value;
    }
  }

  const merged = { ...existing, ...patch };
  const conf = deriveConfidence(merged);
  patch.confidence = conf.band;
  patch.confidence_score = conf.score;
  patch.extraction_tier = 2;
  patch.extracted_by = `${LLM_MODEL}:tier2-pdf`;
  patch.extraction_prompt_version = "tier2-upgrade-v1";
  patch.extracted_at = new Date().toISOString();
  patch.needs_review = conf.band === "low";
  return patch;
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
  if (key === "limitations" || key === "ungrounded_fields") {
    return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  }
  return typeof value === "string" ? value.trim() : value;
}

async function updateCard(workId, patch) {
  if (DRY_RUN) return;
  const { error } = await supabase.from("evidence_cards").update(patch).eq("work_id", workId);
  if (error) throw new Error(`card update failed: ${error.message}`);
}

async function markQueue(workId, state, lastError = null) {
  if (DRY_RUN) return;
  const update = {
    state,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  };
  if (state === "done" || state === "failed" || state === "skipped") {
    update.completed_at = new Date().toISOString();
  }
  if (state === "queued") {
    update.started_at = null;
  }
  const { error } = await supabase.from("evidence_card_upgrade_queue").update(update).eq("work_id", workId);
  if (error) throw new Error(`queue update failed: ${error.message}`);
}

async function heartbeat() {
  try {
    await supabase.from("worker_heartbeat").upsert({
      worker_id: WORKER_ID,
      hostname: hostname(),
      pid,
      last_seen: new Date().toISOString(),
    }, { onConflict: "worker_id" });
  } catch {}
}

async function processOne(row) {
  const { work, card } = await fetchWorkAndCard(row.work_id);
  const urls = await candidatePdfUrls(work);
  if (!urls.length) {
    await markQueue(row.work_id, "skipped", "no PDF candidates");
    console.log(`[tier2] SKIP ${row.work_id} no PDF URL`);
    return;
  }

  const attempts = [];
  let pdf = null;
  for (const url of urls.slice(0, 5)) {
    try {
      pdf = await fetchPdfBytes(url);
      break;
    } catch (err) {
      attempts.push(`${url}: ${err.message}`);
    }
  }
  if (!pdf) throw new Error(`no fetchable PDF candidates; ${attempts.slice(0, 3).join(" | ")}`);
  const pdfText = await parsePdfText(pdf);
  if (!isUsableText(pdfText, 1000)) throw new Error("PDF text too thin after parsing");

  const sourceText = extractRelevantText(pdfText, work.title, work.abstract);
  const targetFields = Array.isArray(row.target_fields) && row.target_fields.length
    ? row.target_fields
    : ["effect_size_text", "statistical_significance", "sample_size", "treatment_group", "control_group"];
  const extracted = await generateJSON(buildUpgradePrompt({ work, card, targetFields, sourceText }));
  const patch = targetPatch(card, extracted, targetFields);
  if (Object.keys(patch).length <= 7) {
    throw new Error("no usable upgraded fields extracted");
  }
  await updateCard(row.work_id, patch);
  await markQueue(row.work_id, "done");
  console.log(`[tier2] OK ${row.work_id} confidence=${patch.confidence} fields=${Object.keys(patch).join(",")}`);
}

let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function main() {
  console.log(`[tier2 ${WORKER_ID}] starting batch=${BATCH_SIZE} pages=${PDF_PAGES} dry_run=${DRY_RUN}`);
  while (running) {
    await heartbeat();
    let batch = [];
    try {
      batch = await claimBatch();
    } catch (err) {
      console.error(`[tier2] claim failed: ${err.message}`);
      if (ONCE) break;
      await sleep(POLL_MS);
      continue;
    }

    if (!batch.length) {
      console.log("[tier2] no queued upgrades");
      if (ONCE) break;
      await sleep(POLL_MS);
      continue;
    }

    for (const row of batch) {
      try {
        await processOne(row);
      } catch (err) {
        const finalAttempt = Number(row.attempts || 0) >= Math.min(MAX_ATTEMPTS, Number(row.max_attempts || MAX_ATTEMPTS));
        const nextState = finalAttempt ? "failed" : "queued";
        console.error(`[tier2] FAIL ${row.work_id}: ${err.message}`);
        await markQueue(row.work_id, nextState, err.message.slice(0, 1000));
      }
    }

    if (ONCE) break;
  }
  console.log(`[tier2 ${WORKER_ID}] stopped`);
}

main().catch((err) => {
  console.error(`[tier2] Fatal: ${err.message}`);
  process.exit(1);
});
