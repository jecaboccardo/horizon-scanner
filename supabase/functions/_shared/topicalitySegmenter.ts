// Topicality segmenter — labels evidence papers CORE / CONTEXT / OFF for a query, so
// the brief + plugin can show a "Core evidence" vs "Related context" split (OFF flagged,
// NEVER auto-dropped — recall-safe). Validated offline (eval-core-bar-ab.mjs): loose CORE
// bar, generous OFF bar, concept-preserving extraction → 0 false-drops across 4 queries.
//
// 🔒 Golden-rule-safe: read-only signal. Never writes `works`. Labels persist on
// `search_runs.work_segments` only.
//
// The extractor is HARDENED (the A/B caught it leaking region/time back into the core,
// which had caused on-topic RCTs to be dropped on geography):
//   1. deterministic region/time strip AFTER the LLM (don't trust the model),
//   2. in-memory cache keyed by normalized query,
//   3. fallback to the region-stripped raw query if the LLM fails / returns garbage.
import { qwenGenerate } from "./qwenClient.ts";

export type Segment = "core" | "context" | "off";

// --- Deterministic geo/time strip ---------------------------------------------------
// Geo tokens — keep in sync with the UX-region buckets in rerank.ts (UX_REGION_BY_COUNTRY).
// Region is a SEPARATE ranking signal (boost/floor); the topicality judge must never see it.
const GEO_TOKENS = [
  "latin america", "central america", "south america", "north america", "caribbean", "lac",
  "brazil", "mexico", "colombia", "argentina", "chile", "peru", "ecuador", "bolivia", "uruguay",
  "paraguay", "venezuela", "costa rica", "panama", "honduras", "guatemala", "el salvador",
  "nicaragua", "dominican republic", "haiti", "jamaica", "trinidad and tobago", "barbados",
  "guyana", "suriname", "belize",
  "sub-saharan africa", "sub-saharan", "africa", "nigeria", "kenya", "south africa", "ethiopia",
  "ghana", "tanzania", "uganda", "zambia", "rwanda", "malawi", "zimbabwe", "senegal",
  "south asia", "southeast asia", "india", "pakistan", "bangladesh", "sri lanka", "indonesia",
  "vietnam", "thailand", "philippines", "malaysia", "singapore", "nepal", "cambodia",
  "united states", "u.s.", "u.s.a.", "usa", "canada",
  "europe", "european union", "central asia", "eastern europe", "western europe",
  "middle east", "north africa", "mena",
  "china", "japan", "south korea", "east asia", "oceania", "australia",
  "oecd", "developing countries", "developing world", "developing economies",
  "low-income countries", "middle-income countries", "high-income countries",
  "low- and middle-income countries", "lmics", "global south", "the global south",
];
const TIME_PATTERNS: RegExp[] = [
  /\b(since|after|before|post|pre)[-\s]?(19|20)\d{2}\b/gi,
  /\b(19|20)\d{2}s?\b/g,
  /\b20\d{2}\+/g,
  /\b(recent(ly)?|frontier|cutting[-\s]edge|state[-\s]of[-\s]the[-\s]art|nowadays|currently)\b/gi,
  /\b(the\s)?(last|past|previous|coming|next)\s+(\d+|few|several|couple of)\s+(years|decades?|months)\b/gi,
];
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const GEO_REGEX = new RegExp(
  "\\b(" + [...GEO_TOKENS].sort((a, b) => b.length - a.length).map(escapeRe).join("|") + ")\\b",
  "gi",
);

/** Remove geography, time-period and dangling scope connectors from an extracted core. */
export function stripGeoTime(text: string): string {
  let s = ` ${text} `;
  s = s.replace(GEO_REGEX, " ");
  for (const re of TIME_PATTERNS) s = s.replace(re, " ");
  // empty parens / lone year-range dashes left by the strip
  s = s.replace(/\(\s*[-–—]?\s*\)/g, " ");
  // dangling scope/list connectors orphaned by removal ("...in ?", "in and", "for |")
  s = s.replace(/\b(in|for|across|within|among|amongst|throughout|of|from|on)\s+(and\s+|&\s+)?(?=[|,.;?!)(]|\s*$)/gi, " ");
  s = s.replace(/\b(and|&)\s+(?=[|,.;?!)]|\s*$)/gi, " ");
  s = s.replace(/\s*[?!]+\s*$/g, "");
  // normalize " | " segments: trim each, drop empties / stub fragments
  if (s.includes("|")) {
    s = s.split("|").map((x) => x.trim()).filter((x) => x.replace(/[^a-z0-9]/gi, "").length >= 2).join(" | ");
  }
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([,;.])/g, "$1").trim();
  s = s.replace(/^[\s|,;.]+|[\s|,;.]+$/g, "").trim();
  return s;
}

// --- Core extraction (LLM + strip + cache + fallback) -------------------------------
const EXTRACT_SYS = `Extract the KEY CONCEPTS of a research query as a short list.
Include: (1) the primary OUTCOME, (2) the INTERVENTION or MECHANISM, (3) any other defining concept (e.g. "information provision", "informality", "selection").
🔴 Do NOT drop the intervention/mechanism — it is as important as the outcome.
STRIP OUT only geography/country/region, time period, and population qualifiers.
Output 2-4 short concepts separated by " | ", no preamble.`;

const coreCache = new Map<string, string>();
const CORE_CACHE_MAX = 1000;
const normKey = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

/** De-regionalized key-concept string for a query. Cached; never throws. */
export async function extractCore(query: string, tenantId?: string): Promise<string> {
  const key = normKey(query);
  const cached = coreCache.get(key);
  if (cached !== undefined) return cached;

  let core = "";
  try {
    const raw = await qwenGenerate(`Query: ${query}`, {
      system: EXTRACT_SYS, temperature: 0, timeoutMs: 20_000, operation: "topicality_extract", tenantId, background: true,
    });
    core = stripGeoTime((raw || "").trim().replace(/^["']+|["']+$/g, ""));
  } catch {
    core = "";
  }
  // Fallback: LLM failed / empty / region-only collapse -> region-stripped raw query.
  if (!core || core.replace(/[|\s]/g, "").length < 4) core = stripGeoTime(query);
  if (!core || core.replace(/[|\s]/g, "").length < 3) core = query.trim(); // last resort
  if (coreCache.size > CORE_CACHE_MAX) coreCache.clear();
  coreCache.set(key, core);
  return core;
}

// --- Judge (loose CORE bar, generous OFF) -------------------------------------------
const JUDGE_RULES = `- CORE: the paper directly studies the topic's primary OUTCOME (the intervention/mechanism may be implicit or any). A paper that only touches a mechanism/input WITHOUT studying the outcome is CONTEXT.
- CONTEXT: relates to AT LEAST ONE key concept, or an adjacent outcome/mechanism. Useful background.
- OFF: unrelated to EVERY key concept.
🔴 (1) GEOGRAPHY AND TIME PERIOD ARE IRRELEVANT — never a reason to downgrade. (2) Be GENEROUS: partial concept coverage is CONTEXT, never OFF; only OFF if unrelated to ALL concepts.`;

const JUDGE_SYS = `You assign a paper to CORE, CONTEXT, or OFF for a topic given as KEY CONCEPTS.
${JUDGE_RULES}
Return ONLY JSON: {"label":"CORE|CONTEXT|OFF"}`;

// Batched judge: same rules, N papers per call. One label per numbered paper.
const JUDGE_BATCH_SYS = `You assign EACH numbered paper to CORE, CONTEXT, or OFF for a topic given as KEY CONCEPTS.
${JUDGE_RULES}
Return ONLY JSON mapping every paper number to its label, e.g. {"1":"CORE","2":"OFF","3":"CONTEXT"}. Include EVERY number exactly once.`;

function toSegment(label: string): Segment {
  const l = (label || "").toUpperCase();
  if (l.includes("CORE")) return "core";
  if (l.includes("OFF")) return "off";
  return "context";
}

function parseLabel(text: string): Segment {
  const m = (text || "").match(/\{[\s\S]*\}/);
  let label = "";
  try { label = (JSON.parse(m ? m[0] : text)?.label || "").toUpperCase(); }
  catch { label = (text || "").toUpperCase(); }
  return toSegment(label);
}

/** Parse a batch response into per-index segments; null if unusable. Accepts
 *  {"1":"CORE",...} or {"labels":{...}} (models wrap despite instructions). */
function parseBatchLabels(text: string, count: number): Segment[] | null {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  // deno-lint-ignore no-explicit-any
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (obj && typeof obj.labels === "object" && obj.labels !== null) obj = obj.labels;
  if (!obj || typeof obj !== "object") return null;
  const out: Segment[] = [];
  let found = 0;
  for (let j = 0; j < count; j++) {
    const v = obj[String(j + 1)] ?? obj[j + 1];
    if (typeof v === "string") { out.push(toSegment(v)); found++; }
    else out.push("context"); // missing entry — soft-fail: keep, never drop
  }
  // Require most entries present, else treat the whole response as garbage.
  return found >= Math.ceil(count / 2) ? out : null;
}

export interface SegPaper { id: string; title?: string | null; abstract?: string | null; }

// Papers per judge call. 15 × ~900-char abstracts ≈ 4k tokens of context —
// comfortably inside the Qwen proxy window while cutting a 50-row brief from
// ~51 LLM calls (1 extract + 50 judges) to ~5 (1 extract + 4 batch judges).
const JUDGE_BATCH_SIZE = 15;

/** Judge one batch. On a failed/garbled batch call, fall back to per-paper
 *  judges for JUST this batch (previous behavior), soft-failing to "context". */
async function segmentBatch(
  core: string,
  batch: SegPaper[],
  segments: Record<string, Segment>,
  tenantId?: string,
): Promise<void> {
  const listing = batch
    .map((p, j) => `PAPER ${j + 1}\nTitle: ${p.title ?? ""}\nAbstract: ${(p.abstract ?? "(no abstract)").slice(0, 900)}`)
    .join("\n\n");
  const user = `Key concepts: ${core}\n\n${listing}\n\nClassify EVERY paper 1-${batch.length} (geography & time irrelevant; partial match = CONTEXT not OFF).`;
  try {
    const txt = await qwenGenerate(user, {
      system: JUDGE_BATCH_SYS, temperature: 0, format: "json", timeoutMs: 60_000,
      operation: "topicality_judge", tenantId, background: true,
    });
    const labels = parseBatchLabels(txt, batch.length);
    if (labels) {
      batch.forEach((p, j) => { segments[p.id] = labels[j]; });
      return;
    }
  } catch { /* fall through to per-paper */ }

  // Batch call failed — per-paper fallback (bounded concurrency), so one bad
  // batch response degrades to the old per-paper cost instead of losing OFF-detection.
  let i = 0;
  async function worker() {
    while (i < batch.length) {
      const p = batch[i++];
      const single = `Key concepts: ${core}\n\nPaper title: ${p.title ?? ""}\nAbstract: ${(p.abstract ?? "(no abstract)").slice(0, 1100)}\n\nClassify (geography & time irrelevant; partial match = CONTEXT not OFF).`;
      try {
        const txt = await qwenGenerate(single, { system: JUDGE_SYS, temperature: 0, format: "json", timeoutMs: 20_000, operation: "topicality_judge", tenantId, background: true });
        segments[p.id] = parseLabel(txt);
      } catch {
        segments[p.id] = "context"; // soft-fail: keep, never drop
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, batch.length) }, () => worker()));
}

/**
 * Label each paper core/context/off. Batched judge calls (JUDGE_BATCH_SIZE
 * papers per call) with per-paper fallback on batch failure; soft-fail to
 * "context" (never drops on error). Returns { core, map }.
 */
export async function segmentWorks(
  query: string,
  papers: SegPaper[],
  opts: { tenantId?: string; concurrency?: number } = {},
): Promise<{ core: string; segments: Record<string, Segment> }> {
  const core = await extractCore(query, opts.tenantId);
  const segments: Record<string, Segment> = {};
  const batches: SegPaper[][] = [];
  for (let b = 0; b < papers.length; b += JUDGE_BATCH_SIZE) {
    batches.push(papers.slice(b, b + JUDGE_BATCH_SIZE));
  }
  // Batch prompts are ~15× heavier than the old per-paper ones — cap in-flight
  // batch calls at 2 regardless of the caller's (per-paper era) concurrency.
  const conc = Math.max(1, Math.min(2, opts.concurrency ?? 2, batches.length));
  let bi = 0;
  async function worker() {
    while (bi < batches.length) {
      const batch = batches[bi++];
      await segmentBatch(core, batch, segments, opts.tenantId);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return { core, segments };
}
