/**
 * supabase/functions/_shared/jelPaperPipeline.ts
 *
 * JEL Survey Paper — async generation pipeline.
 *
 * Entry point: runJelPaperJob(). Called fire-and-forget from the API handler.
 * Lifecycle: queued → running → done | error, written to jel_papers table.
 *
 * Steps:
 *   1. Fetch search run + evidence works + evidence_cards from Supabase
 *   2. Build in-memory coding sheet (design / geography / decade buckets)
 *   3. Call Gemini for JEL-style outline (5-7 sections; 7 is the hard cap)
 *   4. Load voice anchor from evals/jel-exemplars/ (first available)
 *   5. Draft each section sequentially with Gemini (~500-1800 words each)
 *      — writes each section to DB as it completes (live progress)
 *   6. Create feed entry + mark job done
 *
 * Audit step (Skill #5) is omitted from the MVP; can be added as a follow-up
 * pass without touching the rest of this pipeline.
 */

// deno-lint-ignore-file no-explicit-any

import { AsyncLocalStorage } from "node:async_hooks";
import { logUsageEvent, logLlmCall } from "./telemetry.ts";
import { getDossiers } from "./dossiers.ts";
import { callSynthProvider, currentProviderCfg, resolveProviderConfig, synthCtxStore, ProviderCallError, joinUserPrompt, type SplitUserPrompt } from "./synthesisProvider.ts";
import { qwenGate } from "./qwenGate.ts";
import { enforceCitationIntegrity } from "./citationIntegrity.ts";
import {
  JEL_CITATION_RULES,
  JEL_SPREAD_RULES,
  JEL_CITATION_CONTEXT_RULES,
  JEL_FRAMING_PROSE_RULE,
  JEL_SECTION_OUTPUT_RULE,
} from "./jelGenerationSpec.ts";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_QWEN_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_BASE,
} from "./llmConfig.ts";

const GEMINI_BASE = GEMINI_API_BASE;
const GEMINI_MODEL = Deno.env.get("GEMINI_JEL_MODEL") ?? DEFAULT_GEMINI_MODEL;
// QA / non-drafting passes (Devil's Advocate, coherence editor, claim audit, final
// review, revision routing, corrector) don't need the drafter's prose quality, so
// they run on the cheaper model — keeps the expensive Pro drafter for SECTION prose
// only. Defaults to the code default (flash-latest); override with GEMINI_JEL_QA_MODEL.
export const GEMINI_JEL_QA_MODEL = Deno.env.get("GEMINI_JEL_QA_MODEL") ?? DEFAULT_GEMINI_MODEL;
const GEMINI_KEY = () => Deno.env.get("GEMINI_API_KEY") ?? "";

// Qwen via LiteLLM — used for section drafting (100% citation grounding vs Gemini's 58%)
const LLM_BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
const LLM_API_KEY = () => Deno.env.get("LLM_API_KEY") ?? "";
const QWEN_SECTION_MODEL = Deno.env.get("QWEN_SECTION_MODEL") ?? DEFAULT_QWEN_MODEL;

// ---------------------------------------------------------------------------
// Evidence Dossier enrichment (Phase 1, flag-gated by DOSSIER_ENRICH=1).
// Attaches per-paper full-text briefs + uncited context notes (built by
// scripts/build-dossiers.mjs) to coding-sheet papers, lifting the section
// prompt's per-paper substance ceiling above abstract.slice(0,300).
// GOLDEN RULE: prompt-input only; never writes works. OFF by default → the
// production path is byte-for-byte unchanged unless the flag is set.
// ---------------------------------------------------------------------------
// Canonical flag: DOSSIER_ENRICH. `JEL_ENRICH` is a legacy alias (prod sets
// JEL_ENRICH=1) and has no other effect anywhere in the code. Default ON so the
// server matches the PLUGIN, which always applies the enrichment policy from the
// served generation-spec — this removes the app↔plugin asymmetry outside prod.
// Set DOSSIER_ENRICH=0 (or JEL_ENRICH=0) to disable (A/B baseline; fast local dev).
const DOSSIER_ENRICH = (Deno.env.get("DOSSIER_ENRICH") ?? Deno.env.get("JEL_ENRICH") ?? "1") !== "0";
const DOSSIER_CACHE_PATH = Deno.env.get("DOSSIER_CACHE_PATH") ?? "reports/dossier-cache.json";

// Always-on cost-scoped enrichment (2026-06-26). Expansion runs on EVERY
// generation (not just the Generate Now gate); the magnitude/context enrichment
// fetches web dossiers on-demand for the CORE papers only. All knobs env-tunable
// so cost/latency can be dialed without a deploy. See
// docs/superpowers/specs/2026-06-26-always-on-cost-scoped-jel-enrichment-design.md
const ENRICH_ALWAYS_EXPAND = (Deno.env.get("ENRICH_ALWAYS_EXPAND") ?? "1") === "1";
const ENRICH_NET_ADD_CAP   = Number(Deno.env.get("ENRICH_NET_ADD_CAP") ?? "8");   // papers expansion may add
const CORE_ENRICH_CAP      = Number(Deno.env.get("CORE_ENRICH_CAP") ?? "12");     // core papers enriched on-demand
// Cost guard (2026-07-06): how many top-ranked papers get FULL multi-line detail
// in each section prompt. Papers beyond this cap (unless CORE) render as one
// compact line — still citable (workId/authors/year/design/finding-short), just
// without the abstract. The whole corpus stays in every prompt; only the tail's
// per-paper substance is trimmed. Set very high to restore full detail for all.
const SECTION_EVIDENCE_FULL_CAP = Number(Deno.env.get("SECTION_EVIDENCE_FULL_CAP") ?? "30");
const DOSSIER_FETCH_TIMEOUT_MS = Number(Deno.env.get("DOSSIER_FETCH_TIMEOUT_MS") ?? "8000");
const DOSSIER_ENRICH_BUDGET_MS = Number(Deno.env.get("DOSSIER_ENRICH_BUDGET_MS") ?? "40000");
let _dossierCache: Record<string, { fulltext_md?: string; context_note?: string; fulltext_source?: string | null }> | null = null;
function loadDossierCache(): Record<string, { fulltext_md?: string; context_note?: string; fulltext_source?: string | null }> {
  if (_dossierCache) return _dossierCache;
  try {
    _dossierCache = JSON.parse(Deno.readTextFileSync(DOSSIER_CACHE_PATH));
  } catch {
    _dossierCache = {};
  }
  return _dossierCache!;
}

// ---------------------------------------------------------------------------
// CORE tiering ("cite what matters") — channel-dependent + relevance-gated.
// A paper is CORE iff it is RELEVANT (top-N% by max(query-cosine, keyword
// overlap) within the set) AND CREDIBLE under >=1 channel's own bar:
//   causal       : causal design AND sms>=3
//   foundational : year<2020 AND citation_count>=75   (NOT sms — pre-causal era)
//   recent       : year>=2020 AND sms>=3              (citations = recency artifact)
//   lac          : LAC geography AND has content
// Multi-channel mix is enforced softly downstream (>=CORE_CHANNEL_MIN per active
// channel). Flag-gated on DOSSIER_ENRICH; prod unchanged when off.
// ---------------------------------------------------------------------------
const CORE_RELEVANCE_TOP = Number(Deno.env.get("CORE_RELEVANCE_TOP") ?? "0.50"); // top 50%
const CORE_CHANNEL_MIN = Number(Deno.env.get("CORE_CHANNEL_MIN") ?? "5");
const CORE_LAC_KEYWORDS = ["latin america","latin american","america latina","américa latina","latam","lac","caribbean","caribe","south america","central america","mesoamerica","argentina","bolivia","brazil","brasil","chile","colombia","costa rica","cuba","dominican republic","república dominicana","ecuador","el salvador","guatemala","haiti","haití","honduras","jamaica","mexico","méxico","nicaragua","panama","panamá","paraguay","peru","perú","uruguay","venezuela","barbados","trinidad and tobago","guyana","suriname","belize","andean","mercosur","cono sur"];
const CORE_LAC_RE = new RegExp(`\\b(${CORE_LAC_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const CORE_CAUSAL_RE = /\b(rct|randomi|difference-in-difference|diff-in-diff|did|instrumental|iv|regression discontinuity|rdd|natural experiment)\b/i;
const CORE_STOP = new Set(["the","of","on","and","in","to","a","for","is","what","impact","effect","effects","study","studies","evidence","long","term","between","how","do","does","are"]);
const CHANNEL_IDS = ["causal", "foundational", "recent", "lac"] as const;

function coreCosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function coreParseVec(v: any): number[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v.replace(/^\[|\]$/g, "").split(",").map(Number); } }
  return null;
}
function corePercentiles(vals: number[]): number[] {
  const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(vals.length).fill(0);
  idx.forEach(([, i], rank) => { r[i] = vals.length > 1 ? rank / (vals.length - 1) : 1; });
  return r;
}
function paperHasContent(p: any): boolean {
  return !!(p.card?.findingShort || p.dossier?.fulltext_md || p.abstract);
}
// Definitional channel membership (used when retrieval provenance is absent or
// to complement it). Returns the channel ids whose CREDIBILITY bar this paper meets.
function paperChannels(p: any): string[] {
  const yr = p.year ?? null;
  const sms = p.smsLevel ?? 0;
  const out: string[] = [];
  if (CORE_CAUSAL_RE.test(p.card?.design ?? p.methodologyDesign ?? "") && sms >= 3) out.push("causal");
  if (yr != null && yr < 2020 && (p.citationCount ?? 0) >= 75) out.push("foundational");
  if (yr != null && yr >= 2020 && sms >= 3) out.push("recent");
  const geo = `${(p.geography ?? []).join(" ")} ${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
  if (CORE_LAC_RE.test(geo) && paperHasContent(p)) out.push("lac");
  return out;
}
// Attaches `_channels`, `_relevant`, `_core` to every coding paper. Async (embeds
// the query once). Soft-fails to relevance=true on embedding failure (keyword still
// applies) so CORE never silently empties.
async function assignCoreTiers(coding: { papers: any[] }, query: string, embById: Map<string, number[]>): Promise<void> {
  const { createEmbeddingClient } = await import("./embeddingClient.ts");
  const client = createEmbeddingClient();
  let qvec: number[] | null = null;
  try { qvec = client ? await client.embedText(query, "query") : null; } catch { qvec = null; }

  const qTokens = [...new Set(query.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !CORE_STOP.has(t)))];
  const cos: number[] = [], kw: number[] = [];
  for (const p of coding.papers) {
    const v = embById.get(p.workId);
    p._cos = (qvec && v && v.length === qvec.length) ? coreCosine(qvec, v) : 0;
    const text = `${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
    p._kw = qTokens.length ? qTokens.filter((t) => text.includes(t)).length / qTokens.length : 0;
    p._channels = paperChannels(p);
    cos.push(p._cos); kw.push(p._kw);
  }
  const cp = corePercentiles(cos), kp = corePercentiles(kw);
  // Adapt the CORE percentile to pool size (2026-06-17): the relevance floor can
  // hand JEL a SMALL evidence pool, where top-50% leaves too few CORE papers to
  // draft diverse sections. On pools < 20, widen the CORE band (keep ~top-80%).
  const _relTop = coding.papers.length < 20 ? Math.min(1, CORE_RELEVANCE_TOP + 0.30) : CORE_RELEVANCE_TOP;
  const cut = 1 - _relTop;
  coding.papers.forEach((p, i) => {
    p._relevant = Math.max(cp[i], kp[i]) >= cut;
    p._core = p._relevant && p._channels.length > 0;
  });
}

// Evidence corpus is the source of truth for the entire paper.
// Both outline and sections see ALL evidence rows — no caps. Ranking by design
// match / SMS / year is still applied so that if a model ever truncates a
// long prompt, the most relevant papers come first.
// Words to take from the voice-anchor exemplar
const VOICE_ANCHOR_WORDS = 1000; // tighter for Qwen's context budget

// ---------------------------------------------------------------------------
// Per-paper LLM cost instrumentation
//
// Every callGemini/callQwen below logs a row to `llm_calls` (operation-level
// token totals) AND, when a job context is active, accumulates per-paper totals
// that runJelPaperJob emits as one `usage_events` summary at completion. We use
// AsyncLocalStorage (not a module global) so concurrent papers in the same
// deno-api process never cross-contaminate each other's totals.
//
// Cost is DERIVED from the token counts — the tokens are ground truth, the $
// estimate uses Gemini-Flash list prices (override via env; verify periodically
// against current Google pricing). Qwen is self-hosted → ~$0 marginal.
// ---------------------------------------------------------------------------

interface JelUsageCtx {
  paperId: string;
  tenantId: string;
  geminiIn: number;
  geminiOut: number;
  geminiCalls: number;
  /** Running per-call USD estimate at each call's OWN model rates (Pro vs
   *  flash) incl. thinking + cache discount — the old paper-level
   *  flash-rate×(in,out) estimate understated Pro papers ~4-5x. */
  geminiUsd: number;
  qwenIn: number;
  qwenOut: number;
  qwenCalls: number;
}

const jelUsageStore = new AsyncLocalStorage<JelUsageCtx>();

// Gemini list prices (USD per 1M tokens). Estimate only — the token counts in
// `llm_calls` are authoritative; this just turns them into dollars. Must stay
// consistent with scripts/llm-cost-report.mjs MODEL_RATES.
const GEMINI_USD_PER_M_IN = Number(Deno.env.get("GEMINI_USD_PER_M_IN") ?? "0.30");
const GEMINI_USD_PER_M_OUT = Number(Deno.env.get("GEMINI_USD_PER_M_OUT") ?? "2.50");
const GEMINI_PRO_USD_PER_M_IN = Number(Deno.env.get("GEMINI_PRO_USD_PER_M_IN") ?? "1.25");
const GEMINI_PRO_USD_PER_M_OUT = Number(Deno.env.get("GEMINI_PRO_USD_PER_M_OUT") ?? "10");

function estimateGeminiCallUsd(model: string, tokensIn: number, tokensOut: number, thinking = 0, cachedIn = 0): number {
  const pro = /pro/i.test(model);
  const rIn = pro ? GEMINI_PRO_USD_PER_M_IN : GEMINI_USD_PER_M_IN;
  const rOut = pro ? GEMINI_PRO_USD_PER_M_OUT : GEMINI_USD_PER_M_OUT;
  const fresh = Math.max(0, tokensIn - cachedIn);
  // Batch Mode bills EVERYTHING (incl. thinking) at 50% — calls are logged with
  // an "@batch" model suffix so the cost report can price them the same way.
  const mult = /@batch/.test(model) ? 0.5 : 1;
  return mult * (
    (fresh / 1_000_000) * rIn +
    // Gemini implicit context-cache reads bill 0.25x the input rate.
    (cachedIn / 1_000_000) * rIn * 0.25 +
    // Thinking tokens bill at the OUTPUT rate and are NOT in candidatesTokenCount.
    ((tokensOut + thinking) / 1_000_000) * rOut
  );
}

// Abstract provenance values meaning "not retrieved from a real source" —
// bibliography entries built on these are flagged unverified in exports
// (2026-07-15, recalled-abstracts incident).
const UNVERIFIED_ABSTRACT_SOURCES = new Set(["gemini_recall", "qwen_recall", "recall_quarantined"]);

// Tolerant `authors` coercion — the column has appeared as jsonb array,
// stringified JSON, and plain text (2026-06-26 stringified-authors incident).
// An unguarded JSON.parse here killed finished papers at the bibliography step
// AFTER all LLM spend. Plain text falls through as a single display string.
function toAuthorArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String).filter(Boolean);
    } catch { /* not JSON — treat as plain text */ }
    return [v.trim()];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Gemini call helper
// ---------------------------------------------------------------------------

export async function callGemini(
  system: string,
  user: string | SplitUserPrompt,
  maxTokens = 8192,
  expectJson = true,
  op = "jel_gemini",
  model?: string,   // override the app-Gemini model (non-BYOK path); defaults to GEMINI_MODEL
  timeoutMs = 120_000, // drafting calls pass a longer budget — Pro thinking on a ~12k-token prompt regularly runs 60-100s
): Promise<any> {
  const byokCfg = currentProviderCfg();
  if (byokCfg) {
    const byokCtx = jelUsageStore.getStore();
    return await callSynthProvider(system, user, {
      maxTokens, expectJson, temperature: 0.4, op, timeoutMs,
      tenantId: byokCtx?.tenantId,
      // Per-paper cost rollup. BYOK calls previously bypassed usageCtx entirely,
      // so paper.generation_completed reported 0 tokens for exactly the papers
      // billed on a user's own key. The gemini* fields mean "billed synthesis
      // provider" (app Gemini OR BYOK Claude/Gemini) — see the payload's
      // provider field for which one.
      onUsage: byokCtx
        ? (u) => { byokCtx.geminiIn += u.tokensIn; byokCtx.geminiOut += u.tokensOut; byokCtx.geminiCalls += 1; }
        : undefined,
    }, byokCfg);
  }

  const key = GEMINI_KEY();
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const MODEL = model ?? GEMINI_MODEL;
  const url = `${GEMINI_BASE}/${MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    // Split prompts join prefix-first — Gemini's implicit prefix caching
    // discounts the shared prefix when consecutive calls repeat it.
    contents: [{ role: "user", parts: [{ text: joinUserPrompt(user) }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: maxTokens,
      // JSON mode only for structured callers. Section BODIES are requested as
      // plain text (expectJson=false): a truncated prose body is still usable,
      // whereas a truncated JSON envelope fails to parse and drops the section.
      ...(expectJson ? { responseMimeType: "application/json" } : {}),
      // Flash thinks by default, but the flash-routed JEL passes (QA: Devil's
      // Advocate, coherence, claim audit, final review, corrector, revision routing)
      // don't need chain-of-thought — a near-zero budget saves ~90k thinking
      // tokens/paper + latency at effectively zero quality cost (measured
      // 2026-07-09). Pro REJECTS budget 0 ("only works in thinking mode" → 400),
      // so gate on the model being flash.
      // 2026-07-22: budget=0 itself started 400ing on gemini-flash-latest too
      // (confirmed via direct reproduction — Google tightened flash to reject
      // a literal zero, same restriction Pro already had). budget=1 is accepted
      // and keeps thinking tokens negligible; do NOT revert this to 0.
      ...(/flash/i.test(MODEL) ? { thinkingConfig: { thinkingBudget: 1 } } : {}),
    },
  };

  const ctx = jelUsageStore.getStore();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = (err as Error).name === "AbortError";
    logLlmCall({ model: MODEL, operation: op, latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: (err as Error).message?.slice(0, 200), tenantId: ctx?.tenantId });
    if (isTimeout) throw new Error(`Gemini call timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  }

  // Body reads stay under the abort signal — clearing the timeout at
  // header-time meant a stalled response body hung the await forever and left
  // the paper stuck at "running" until the next deploy's watchdog. (callQwen
  // already clears in `finally`.)
  // deno-lint-ignore no-explicit-any
  let data: any;
  try {
    if (!r.ok) {
      const txt = await r.text();
      logLlmCall({ model: MODEL, operation: op, latencyMs: Date.now() - startedAt, status: "error", error: `${r.status} ${txt.slice(0, 160)}`, tenantId: ctx?.tenantId });
      throw new Error(`Gemini ${r.status}: ${txt.slice(0, 400)}`);
    }
    data = await r.json();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logLlmCall({ model: MODEL, operation: op, latencyMs: Date.now() - startedAt, status: "timeout", tenantId: ctx?.tenantId });
      throw new Error(`Gemini call timed out after ${Math.round(timeoutMs / 1000)}s (response body)`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  // Per-call token telemetry + per-paper accumulation (best-effort).
  const um = data?.usageMetadata;
  const tIn = typeof um?.promptTokenCount === "number" ? um.promptTokenCount : undefined;
  const tOut = typeof um?.candidatesTokenCount === "number" ? um.candidatesTokenCount : undefined;
  // Gemini implicit context-cache hit (part of promptTokenCount). Logged into
  // cache_read_tokens so llm-cost-report can price it at 0.25x + show hit rates —
  // this is how we SEE whether the byte-identical evidence prefix is caching.
  const cachedIn = typeof um?.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : undefined;
  // Pro reasoning tokens — billed as output, NOT in candidatesTokenCount. Log
  // separately so the cost report prices them (Pro thinking ≈ 3x prose tokens).
  const thoughts = typeof um?.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : undefined;
  logLlmCall({ model: MODEL, operation: op, tokensIn: tIn, tokensOut: tOut, cacheReadTokens: cachedIn, thinkingTokens: thoughts, latencyMs: Date.now() - startedAt, status: "ok", tenantId: ctx?.tenantId });
  if (ctx) {
    ctx.geminiIn += tIn ?? 0; ctx.geminiOut += tOut ?? 0; ctx.geminiCalls += 1;
    ctx.geminiUsd += estimateGeminiCallUsd(MODEL, tIn ?? 0, tOut ?? 0, thoughts ?? 0, cachedIn ?? 0);
  }

  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) {
    throw new Error(
      `Gemini returned no text. finishReason=${data?.candidates?.[0]?.finishReason}`,
    );
  }
  if (!expectJson) return text;
  try {
    return lenientJsonParse(text);
  } catch {
    throw new Error(`Gemini non-JSON. First 400: ${text.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------------------
// Gemini drafting with retry — Qwen is the LAST resort, not the first fallback
// ---------------------------------------------------------------------------
// JEL runs in the background, so waiting out a transient Gemini failure (503
// "model overloaded", 429, a timeout during degraded service) is cheap and
// vastly preferable to a Qwen-drafted section (weaker prose; observed
// 2026-07-13: a brief Gemini outage sent 3 sections to Qwen, one with wrong
// citations + a fabricated reference list).
//
// 2026-07-22 incident: a `Gemini 400 INVALID_ARGUMENT` was previously treated
// as non-retryable (assumed permanent config bug) and fell through to Qwen on
// the FIRST attempt with zero retries. Root-caused via llm_calls: this exact
// error had never occurred before or since, hit 3 unrelated call sites
// (gemini_synthesis/creative_planner/jel_gemini) in the same 6-minute window,
// and no code touched geminiClient.ts anywhere near that time — a transient
// Gemini-side hiccup on gemini-flash-latest, not a real bad-request bug. 400s
// are now retried too (bounded backoff cost, ~40-70s worst case) so a
// transient provider blip doesn't skip straight past Gemini retries to a
// weaker Qwen draft. 404 (unknown model — a genuine config error that
// retrying can never fix) still throws immediately.
const GEMINI_DRAFT_TIMEOUT_MS = Number(Deno.env.get("GEMINI_DRAFT_TIMEOUT_MS") ?? "180000");
const GEMINI_DRAFT_ATTEMPTS = Math.max(1, Number(Deno.env.get("GEMINI_DRAFT_ATTEMPTS") ?? "3"));
const GEMINI_RETRY_WAITS_MS = [10_000, 30_000]; // waits between attempts; last value repeats

function isRetryableGeminiError(msg: string): boolean {
  return /timed out|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|Gemini 5\d\d|Gemini 429|Gemini 400|INVALID_ARGUMENT|Claude 5\d\d|Claude 429|error sending request|network|no text/i.test(msg);
}

// ── Gemini Batch Mode (50% price incl. thinking) ────────────────────────────
// Pro drafting calls go through the Batch API first: submit a single-request
// batch job, poll until it clears, and if it hasn't finished within the
// deadline (default 15 min) cancel it and draft interactively at full price.
// JEL is a background job — a few extra minutes per section is a fine trade
// for halving the Pro bill (thinking included). Batch is skipped for BYOK
// (user's own key, interactive contract) and for flash calls (already cheap;
// QA passes are latency-sensitive within the pipeline).
const GEMINI_BATCH_DRAFT = (Deno.env.get("GEMINI_BATCH_DRAFT") ?? "1") === "1";
const GEMINI_BATCH_DEADLINE_MS = Number(Deno.env.get("GEMINI_BATCH_DEADLINE_MS") ?? "900000"); // 15 min
const GEMINI_BATCH_POLL_MS = Number(Deno.env.get("GEMINI_BATCH_POLL_MS") ?? "15000");
const GEMINI_API_ROOT = GEMINI_BASE.replace(/\/models\/?$/, "");
/** Exposed via GET /api/_version for config sanity checks (no SSH). */
export const JEL_BATCH_CONFIG = {
  enabled: GEMINI_BATCH_DRAFT,
  deadlineMs: GEMINI_BATCH_DEADLINE_MS,
  pollMs: GEMINI_BATCH_POLL_MS,
};

async function callGeminiBatch(
  system: string,
  user: string | SplitUserPrompt,
  maxTokens: number,
  expectJson: boolean,
  op: string,
  MODEL: string,
): Promise<any> {
  const key = GEMINI_KEY();
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const startedAt = Date.now();
  const ctx = jelUsageStore.getStore();
  const request = {
    contents: [{ role: "user", parts: [{ text: joinUserPrompt(user) }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: maxTokens,
      ...(expectJson ? { responseMimeType: "application/json" } : {}),
      ...(/flash/i.test(MODEL) ? { thinkingConfig: { thinkingBudget: 1 } } : {}),
    },
  };
  const createRes = await fetch(`${GEMINI_BASE}/${MODEL}:batchGenerateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: {
        displayName: op,
        inputConfig: { requests: { requests: [{ request, metadata: { key: "r1" } }] } },
      },
    }),
  });
  if (!createRes.ok) {
    const txt = await createRes.text();
    throw new Error(`batch create ${createRes.status}: ${txt.slice(0, 200)}`);
  }
  const created = await createRes.json();
  const name: string | undefined = created?.name;
  if (!name) throw new Error(`batch create returned no job name: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`[jel-batch] ${op} submitted (${name}), deadline ${Math.round(GEMINI_BATCH_DEADLINE_MS / 60000)}m`);

  const deadline = startedAt + GEMINI_BATCH_DEADLINE_MS;
  // deno-lint-ignore no-explicit-any
  let opState: any = created;
  while (Date.now() < deadline) {
    const state: string = opState?.metadata?.state ?? opState?.state ?? "";
    if (/SUCCEEDED/.test(state)) break;
    if (/(FAILED|CANCELLED|EXPIRED)/.test(state)) {
      throw new Error(`batch job ${state}: ${JSON.stringify(opState?.error ?? {}).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, GEMINI_BATCH_POLL_MS));
    const pollRes = await fetch(`${GEMINI_API_ROOT}/${name}?key=${key}`);
    if (!pollRes.ok) throw new Error(`batch poll ${pollRes.status}`);
    opState = await pollRes.json();
  }
  const finalState: string = opState?.metadata?.state ?? opState?.state ?? "";
  if (!/SUCCEEDED/.test(finalState)) {
    // Deadline hit — cancel (best-effort, avoids paying for a job we abandon)
    // and let the caller fall back to the interactive API.
    try { void fetch(`${GEMINI_API_ROOT}/${name}:cancel?key=${key}`, { method: "POST" }); } catch { /* ignore */ }
    logLlmCall({ model: `${MODEL}@batch`, operation: op, latencyMs: Date.now() - startedAt, status: "timeout", error: `deadline ${GEMINI_BATCH_DEADLINE_MS}ms, state=${finalState || "unknown"}`, tenantId: ctx?.tenantId });
    throw new Error(`batch deadline exceeded (state=${finalState || "pending"})`);
  }

  // Inline responses; shape has appeared both flat and nested — handle both.
  const inlined = opState?.response?.inlinedResponses?.inlinedResponses ?? opState?.response?.inlinedResponses ?? [];
  const first = inlined[0];
  if (first?.error) throw new Error(`batch request error: ${JSON.stringify(first.error).slice(0, 200)}`);
  const resp = first?.response;
  const um = resp?.usageMetadata;
  const tIn = typeof um?.promptTokenCount === "number" ? um.promptTokenCount : undefined;
  const tOut = typeof um?.candidatesTokenCount === "number" ? um.candidatesTokenCount : undefined;
  const cachedIn = typeof um?.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : undefined;
  const thoughts = typeof um?.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : undefined;
  logLlmCall({ model: `${MODEL}@batch`, operation: op, tokensIn: tIn, tokensOut: tOut, cacheReadTokens: cachedIn, thinkingTokens: thoughts, latencyMs: Date.now() - startedAt, status: "ok", tenantId: ctx?.tenantId });
  if (ctx) {
    ctx.geminiIn += tIn ?? 0; ctx.geminiOut += tOut ?? 0; ctx.geminiCalls += 1;
    ctx.geminiUsd += estimateGeminiCallUsd(`${MODEL}@batch`, tIn ?? 0, tOut ?? 0, thoughts ?? 0, cachedIn ?? 0);
  }
  // deno-lint-ignore no-explicit-any
  const text: string = (resp?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => !p?.thought)
    .map((p: any) => p?.text ?? "")
    .join("");
  if (!text) throw new Error(`batch returned no text (finishReason=${resp?.candidates?.[0]?.finishReason})`);
  console.log(`[jel-batch] ${op} completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (!expectJson) return text;
  try { return lenientJsonParse(text); }
  catch { throw new Error(`batch non-JSON. First 400: ${text.slice(0, 400)}`); }
}

export async function callGeminiDraft(
  system: string,
  user: string | SplitUserPrompt,
  maxTokens = 16384,
  expectJson = false,
  op = "jel_gemini",
  model?: string,
): Promise<any> {
  // Batch-first for app-key PRO drafting (the expensive calls). Any batch
  // failure — create error, job failure, or 15-min deadline — falls through
  // to the interactive retry loop below, so batch can only add latency,
  // never lose a section.
  const resolved = model ?? GEMINI_MODEL;
  if (GEMINI_BATCH_DRAFT && !currentProviderCfg() && /pro/i.test(resolved)) {
    try {
      return await callGeminiBatch(system, user, maxTokens, expectJson, op, resolved);
    } catch (err) {
      console.log(`[jel-batch] ${op} falling back to interactive: ${((err as Error).message ?? "").slice(0, 140)}`);
    }
  }
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= GEMINI_DRAFT_ATTEMPTS; attempt++) {
    try {
      return await callGemini(system, user, maxTokens, expectJson, op, model, GEMINI_DRAFT_TIMEOUT_MS);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message ?? "";
      if (!isRetryableGeminiError(msg) || attempt === GEMINI_DRAFT_ATTEMPTS) throw lastErr;
      const wait = GEMINI_RETRY_WAITS_MS[Math.min(attempt - 1, GEMINI_RETRY_WAITS_MS.length - 1)];
      console.log(`[jel] gemini draft attempt ${attempt}/${GEMINI_DRAFT_ATTEMPTS} failed (${msg.slice(0, 140)}) — retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("gemini draft failed");
}

// ---------------------------------------------------------------------------
// Qwen call helper (LiteLLM / OpenAI-compatible)
// Used for section drafting — 100% strict citation grounding vs Gemini's 58%
// ---------------------------------------------------------------------------

export async function callQwen(
  system: string,
  user: string | SplitUserPrompt,
  maxTokens = 6000,
  expectJson = true,
  op = "jel_qwen",
): Promise<any> {
  const key = LLM_API_KEY();
  if (!key) throw new Error("LLM_API_KEY not set");

  const url = `${LLM_BASE_URL}/v1/chat/completions`;
  const body: any = {
    model: QWEN_SECTION_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: joinUserPrompt(user) },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
    stream: false,
  };
  // JSON mode only for structured callers; section bodies are plain text.
  if (expectJson) body.response_format = { type: "json_object" };

  // ⚠️  TEMPORARY TIMEOUT — 60s instead of 120s (set 2026-05-22).
  // Reason: Qwen server under load from concurrent extraction worker; 120s stalls
  // caused JEL papers to take 20-30 min. Restore to 120s once extraction worker
  // backlog clears and we verify Qwen latency is stable at <45s per section.
  const QWEN_SECTION_TIMEOUT_MS = 60_000; // 60 s measured stable; 120 s was the original pre-GPU-load value

  const ctx = jelUsageStore.getStore();

  // JEL section drafting is BACKGROUND work: it waits on the shared Qwen gate at
  // low priority so it yields the GPU to interactive search/chat, and the request
  // timeout below starts only after a slot is acquired (queue wait ≠ request budget).
  const gateEnteredAt = Date.now();
  const release = await qwenGate.acquire({ background: true });
  const queuedMs = Date.now() - gateEnteredAt;
  if (queuedMs > 1500) console.log(`[qwen-gate] ${op} waited ${queuedMs}ms for a slot (bg=true)`);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QWEN_SECTION_TIMEOUT_MS);
  try {
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const isTimeout = (err as Error).name === "AbortError";
      logLlmCall({ model: QWEN_SECTION_MODEL, operation: op, latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: (err as Error).message?.slice(0, 200), tenantId: ctx?.tenantId });
      if (isTimeout) throw new Error(`Qwen call timed out after ${QWEN_SECTION_TIMEOUT_MS / 1000}s`);
      throw err;
    }

    if (!r.ok) {
      const txt = await r.text();
      logLlmCall({ model: QWEN_SECTION_MODEL, operation: op, latencyMs: Date.now() - startedAt, status: "error", error: `${r.status} ${txt.slice(0, 160)}`, tenantId: ctx?.tenantId });
      throw new Error(`Qwen ${r.status}: ${txt.slice(0, 400)}`);
    }

    const data = await r.json();
    // Per-call token telemetry + per-paper accumulation (best-effort). OpenAI shape.
    const u = data?.usage;
    const tIn = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : undefined;
    const tOut = typeof u?.completion_tokens === "number" ? u.completion_tokens : undefined;
    logLlmCall({ model: QWEN_SECTION_MODEL, operation: op, tokensIn: tIn, tokensOut: tOut, latencyMs: Date.now() - startedAt, status: "ok", tenantId: ctx?.tenantId });
    if (ctx) { ctx.qwenIn += tIn ?? 0; ctx.qwenOut += tOut ?? 0; ctx.qwenCalls += 1; }

    const text: string = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("Qwen returned no text");

    if (!expectJson) return text;
    try {
      return lenientJsonParse(text);
    } catch {
      throw new Error(`Qwen non-JSON. First 400: ${text.slice(0, 400)}`);
    }
  } finally {
    clearTimeout(timeout);
    release();
  }
}

// ---------------------------------------------------------------------------
// Lenient JSON recovery — runs ONLY after a strict JSON.parse fails, so it can
// never regress a currently-passing parse. Handles the two failure modes seen
// in prod logs: (1) markdown ```json fences / prose around the object, and
// (2) RAW newlines/tabs inside string values (invalid JSON) — the dominant
// cause of "Gemini non-JSON" → Qwen-fallback → timeout → dropped sections.
// ---------------------------------------------------------------------------
function lenientJsonParse(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { /* fall through */ }
  // Escape raw control chars that appear INSIDE string literals.
  let out = "";
  let inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === "\n") { out += "\\n"; continue; }
    if (inStr && ch === "\r") { out += "\\r"; continue; }
    if (inStr && ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return JSON.parse(out); // may throw → caller turns it into the non-JSON error
}

// ---------------------------------------------------------------------------
// Outline generation
// ---------------------------------------------------------------------------

export function buildOutlinePrompt(
  query: string,
  synthesis: {
    abstractSummary?: string;
    summaryBullets?: string[];
    methodologyNote?: string;
    strongestEvidence?: string;
    coverageCard?: any;
  } | null,
  evidence: Array<{
    title: string;
    year: number | null;
    geography: string[];
    card?: any;
    methodologyDesign?: string | null;
    abstract?: string | null;
  }>,
  framing?: {
    scope?: { include?: string[]; exclude?: string[] };
    emphasis?: { themes?: string[]; spotlightDebate?: string; audience?: string; targetWords?: number };
  } | null,
  confirmedOutline?: { title?: string; sections?: { number: any; heading: string; scope?: string }[] } | null,
  targetWords?: number,
) {
  const enrich = confirmedOutline != null &&
    Array.isArray(confirmedOutline.sections) &&
    confirmedOutline.sections.length > 0;

  let system: string;
  if (enrich) {
    const targetTotal = targetWords ?? 5000;
    const confirmedSectionLines = (confirmedOutline!.sections!).map(
      (s, i) => `${i + 1}. [${s.number}] ${s.heading} — ${s.scope ?? ""}`,
    );
    system = [
      "You are the Outline Agent for the Horizon Scanner JEL Survey pipeline.",
      "The full article will be drafted section by section from the confirmed structure below.",
      "Citations are added later from retrieved evidence.",
      "",
      "SOURCE-OF-TRUTH HIERARCHY (read top-down):",
      "1. EVIDENCE CORPUS — the papers actually retrieved. This is what the article IS about.",
      "2. EXISTING SYNTHESIS — already-grounded framing derived from that evidence.",
      "3. RESEARCH QUESTION — user intent.",
      "Retrieval filters (topics, regions, etc.) are NOT provided. They are upstream metadata,",
      "not article-framing inputs. Do not invent them.",
      "",
      "HARD RULES (any violation = wrong output):",
      "- The TITLE and ABSTRACT must describe what the EVIDENCE CORPUS collectively covers.",
      "  Do NOT introduce themes (e.g. AI, automation, climate, labor markets) unless they",
      "  are explicit in the research question OR ≥10% of evidence papers are about that theme.",
      "- If an EXISTING SYNTHESIS is provided, the article ELABORATES it into a survey.",
      "  It does NOT pivot the topic. Title and abstract must be a natural elaboration of",
      "  the synthesis's framing.",
      "- expectedDesigns must use canonical labels: RCT, DiD, IV, RDD, observational,",
      "  matching, quasi-experimental, simulation, qualitative, review, descriptive.",
      "- Each section's scope must be grounded in the actual evidence — do not invent",
      "  sections covering designs or geographies the corpus doesn't contain.",
      "",
      "The user has CONFIRMED the section structure below. You MUST output EXACTLY these sections —",
      "same count, same `number`, same `heading`, same order, and the same scope intent. Do NOT add,",
      "remove, rename, reorder, or merge sections.",
      "Your ONLY job is to enrich each section with:",
      `  - targetWords: an integer; the sum across all sections must be approximately ${targetTotal}.`,
      "  - expectedDesigns: canonical labels (RCT, DiD, IV, RDD, observational, matching, quasi-experimental,",
      "    simulation, qualitative, review, descriptive) grounded in the evidence for that section's scope.",
      "Also write a 200-250 word abstract consistent with these confirmed sections and the evidence.",
      "CONFIRMED SECTIONS (use verbatim):",
      ...confirmedSectionLines,
      "",
      "OUTPUT (JSON only, no markdown fences):",
      '{ "title": "...", "abstract": "...(200-250 words)", "sections": [',
      '  { "number": "1", "heading": "...", "scope": "...", "targetWords": N,',
      '    "expectedDesigns": ["RCT", "DiD"] }',
      "]}",
    ].join("\n");
  } else {
    const targetTotal = targetWords ?? 5000;
    // Scale section count + word range to the chosen page target.
    // 7 sections is the HARD cap (2026-06-22) regardless of length.
    const minSections = targetTotal <= 2500 ? 3 : 4;
    const maxSections = 7;
    const wordRangeLo = Math.round(targetTotal * 0.85 / 1000) * 1000;
    const wordRangeHi = Math.round(targetTotal * 1.15 / 1000) * 1000;
    system = [
      "You are the Outline Agent for the Horizon Scanner JEL Survey pipeline.",
      "Produce a structured table of contents for a Journal of Economic Literature-style",
      `survey article. The full article will be ${wordRangeLo.toLocaleString()}–${wordRangeHi.toLocaleString()} words across ${minSections}–${maxSections} sections,`,
      "drafted section by section. Citations are added later from retrieved evidence.",
      "Your outline must describe scope precisely AND faithfully reflect the evidence corpus.",
      "",
      "SOURCE-OF-TRUTH HIERARCHY (read top-down):",
      "1. EVIDENCE CORPUS — the papers actually retrieved. This is what the article IS about.",
      "2. EXISTING SYNTHESIS — already-grounded framing derived from that evidence.",
      "3. RESEARCH QUESTION — user intent.",
      "Retrieval filters (topics, regions, etc.) are NOT provided. They are upstream metadata,",
      "not article-framing inputs. Do not invent them.",
      "",
      "HARD RULES (any violation = wrong output):",
      "- The TITLE and ABSTRACT must describe what the EVIDENCE CORPUS collectively covers.",
      "  Do NOT introduce themes (e.g. AI, automation, climate, labor markets) unless they",
      "  are explicit in the research question OR ≥10% of evidence papers are about that theme.",
      "- If an EXISTING SYNTHESIS is provided, the article ELABORATES it into a survey.",
      "  It does NOT pivot the topic. Title and abstract must be a natural elaboration of",
      "  the synthesis's framing.",
      `- Produce ${minSections}–${maxSections} top-level or nested sections (numbered 1, 2, 2.1, 2.2, 3 ...).`,
      "- Standard JEL arc: (a) Introduction + prior-survey positioning, (b) Stylized facts /",
      "  institutional background, (c) Theory / identification challenges, (d) Empirical",
      "  evidence (one or more sections), (e) Mechanisms, (f) Heterogeneity + external",
      "  validity (LAC angle when ≥3 LAC papers in evidence), (g) Research agenda.",
      "- Section 1 MUST cover introduction AND prior-survey positioning.",
      "- Last section MUST be a research agenda.",
      `- targetWords across all sections must sum to ${wordRangeLo.toLocaleString()}-${wordRangeHi.toLocaleString()}.`,
      "- expectedDesigns must use canonical labels: RCT, DiD, IV, RDD, observational,",
      "  matching, quasi-experimental, simulation, qualitative, review, descriptive.",
      "- Each section's scope must be grounded in the actual evidence — do not invent",
      "  sections covering designs or geographies the corpus doesn't contain.",
      "- The RESEARCH QUESTION may be compound (multiple clauses, often separated by",
      "  a semicolon). If ANY clause or aspect of it is NOT addressed by the evidence",
      "  corpus (e.g. it asks for a comparison the retrieved papers don't support),",
      "  do NOT silently drop that clause from the outline. Instead: (1) omit it from",
      "  section scopes as you would anyway (don't fabricate a section the evidence",
      "  can't support), AND (2) name the specific unaddressed clause in the",
      "  evidenceGaps array below, in plain language a policy analyst would",
      "  understand (2026-07-22: a paper silently dropped a 'relative to regional",
      "  peers' comparative clause with no trace of the gap anywhere in the output —",
      "  this field exists so that never happens invisibly again).",
      "",
      "OUTPUT (JSON only, no markdown fences):",
      '{ "title": "...", "abstract": "...(200-250 words)", "sections": [',
      '  { "number": "1", "heading": "...", "scope": "...", "targetWords": N,',
      '    "expectedDesigns": ["RCT", "DiD"] }',
      '], "evidenceGaps": ["specific clause/aspect of the research question the',
      '  evidence corpus could not support — empty array if the question is fully addressed"] }',
    ].join("\n");
  }

  // Compact, scannable evidence row: [year] "Title" (design, geography) — finding
  const evidenceRows = evidence.map((p) => {
    const design = normalizeDesign(p.card?.design ?? p.methodologyDesign);
    const geos = (p.geography ?? []).slice(0, 2).join(", ") || "—";
    const finding = p.card?.findingShort
      || (p.abstract ? p.abstract.slice(0, 140).replace(/\s+/g, " ") : "");
    const year = p.year ?? "n.d.";
    return `[${year}] "${p.title}" (${design}, ${geos})${finding ? " — " + finding : ""}`;
  });

  const synthesisBlock: string[] = [];
  if (synthesis) {
    if (synthesis.abstractSummary) {
      synthesisBlock.push("EXISTING SYNTHESIS — ABSTRACT (inherit this framing):", synthesis.abstractSummary);
    }
    if (synthesis.strongestEvidence) {
      synthesisBlock.push("", "STRONGEST EVIDENCE:", synthesis.strongestEvidence);
    }
    if (Array.isArray(synthesis.summaryBullets) && synthesis.summaryBullets.length > 0) {
      synthesisBlock.push("", "KEY FINDINGS FROM SYNTHESIS:", ...synthesis.summaryBullets.map((b, i) => `${i + 1}. ${b}`));
    }
    if (synthesis.methodologyNote) {
      synthesisBlock.push("", "METHODOLOGY PROFILE:", synthesis.methodologyNote);
    }
    if (synthesis.coverageCard) {
      const cc = synthesis.coverageCard;
      const cov: string[] = [];
      if (cc.regionalGap) cov.push(`LAC evidence: ${cc.regionalGap}`);
      if (cc.recencyGap) cov.push(`Recency: ${cc.recencyGap}`);
      if (cov.length > 0) synthesisBlock.push("", "COVERAGE NOTES:", ...cov);
    }
  }

  const framingLines: string[] = [];
  if (framing) {
    const inc = framing.scope?.include?.filter(Boolean) ?? [];
    const exc = framing.scope?.exclude?.filter(Boolean) ?? [];
    const themes = framing.emphasis?.themes?.filter(Boolean) ?? [];
    framingLines.push("USER FRAMING (locked — this OVERRIDES the raw research question where they differ):");
    if (inc.length) framingLines.push(`- Scope INCLUDE (foreground these): ${inc.join(", ")}`);
    if (exc.length) framingLines.push(`- Scope EXCLUDE (omit these even if present in evidence): ${exc.join(", ")}`);
    if (themes.length) framingLines.push(`- Emphasis themes to weight more heavily: ${themes.join(", ")}`);
    if (framing.emphasis?.spotlightDebate) framingLines.push(`- Give a DEDICATED section to this debate: ${framing.emphasis.spotlightDebate}`);
    if (framing.emphasis?.audience) framingLines.push(`- Audience: ${framing.emphasis.audience} (calibrate depth/tone accordingly).`);
    if (framing.emphasis?.targetWords) framingLines.push(`- Target total length: ~${framing.emphasis.targetWords} words across all sections (let section targetWords sum to roughly this).`);
  }

  const user = [
    enrich && confirmedOutline?.title ? `CONFIRMED TITLE: ${confirmedOutline.title}` : "",
    `RESEARCH QUESTION: ${query}`,
    framingLines.length > 0 ? framingLines.join("\n") : "",
    synthesisBlock.length > 0 ? synthesisBlock.join("\n") : "(no prior synthesis available — ground the outline directly in the evidence below)",
    "",
    `EVIDENCE CORPUS (${evidenceRows.length} papers — this is the source of truth for article scope):`,
    evidenceRows.join("\n"),
    "",
    "Generate the JEL survey outline following the rules above. The title and abstract must describe what THIS corpus collectively covers, elaborating the synthesis if one is provided.",
  ].filter(Boolean).join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// Evidence coding — build in-memory coding sheet from works + cards
// ---------------------------------------------------------------------------

function normalizeDesign(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const s = String(raw).trim().toLowerCase();
  if (s === "rct" || s.includes("random")) return "RCT";
  if (s === "did" || s.includes("difference-in-differences") || s.includes("difference in differences")) return "DiD";
  if (s === "iv" || s.includes("instrumental")) return "IV";
  if (s === "rdd" || s.includes("regression discontinuity")) return "RDD";
  if (s.includes("matching") || s.includes("propensity")) return "matching";
  if (s.includes("quasi")) return "quasi-experimental";
  if (s.includes("observ")) return "observational";
  if (s.includes("qualitative")) return "qualitative";
  if (s.includes("review") || s.includes("meta")) return "review";
  if (s.includes("simulation") || s.includes("structural")) return "simulation";
  if (s.includes("theor")) return "theoretical";
  if (s.includes("descriptive")) return "descriptive";
  return s;
}

function buildCodingSheet(
  works: any[],
  cardsById: Record<string, any>,
  evidenceIds: string[],
) {
  const evidenceSet = new Set(evidenceIds);
  const papers = works
    .filter((w) => evidenceSet.has(w.id))
    .map((w) => {
      const card = cardsById[w.id] ?? null;
      return {
        workId: w.id,
        title: w.title ?? "",
        authors: w.authors ?? [],
        year: w.year ?? null,
        smsLevel: w.sms_level ?? null,
        methodologyDesign: w.methodology_design ?? null,
        geography: w.geography ?? [],
        abstract: w.abstract ?? null,
        citationCount: w.citation_count ?? null,
        hasCard: !!card,
        card: card
          ? {
              design: card.study_design ?? null,
              intervention: card.intervention ?? null,
              outcome: card.outcome ?? null,
              effectDirection: card.effect_direction ?? null,
              effectSizeText: card.effect_size_text ?? null,
              sampleSize: card.sample_size ?? card.sample_size_text ?? null,
              country: card.country ?? null,
              identificationStrategy: card.identification_strategy ?? null,
              limitations: card.limitations ?? null,
              mechanism: card.mechanism ?? null,
              heterogeneity: card.heterogeneity ?? null,
              externalValidityNote: card.external_validity_note ?? null,
              findingShort: card.finding_short ?? null,
            }
          : null,
      };
    });

  return { papers, total: papers.length };
}

// Merge a plan's confirmed uploads into a coding sheet as first-class, citable
// synthetic evidence papers, and register their ids in evidenceIds so the
// citation allow-list accepts them. Pure in-memory; never touches the works
// table (golden rule). Shared by generation and revision.
export function mergeUploadsIntoCoding(
  coding: { papers: any[]; total: number },
  plan: { uploads?: any[] } | null | undefined,
  evidenceIds: string[],
): void {
  const uploads = plan && Array.isArray(plan.uploads) ? plan.uploads : [];
  if (uploads.length === 0) return;
  for (const u of uploads) {
    const workId = (u.doi && String(u.doi)) || u.uploadId;
    if (!workId || coding.papers.some((p) => p.workId === workId)) continue;
    coding.papers.push({
      workId,
      title: u.title ?? "(untitled upload)",
      authors: Array.isArray(u.authors) ? u.authors : [],
      year: u.year ?? null,
      smsLevel: u.smsLevel ?? null,
      methodologyDesign: u.card?.design ?? null,   // lets pickEvidenceForSection design-match uploads
      geography: [],
      abstract: u.abstract ?? null,
      hasCard: !!u.card,
      card: u.card
        ? {
            design: u.card.design ?? null,
            intervention: u.card.intervention ?? null,
            outcome: u.card.outcome ?? null,
            effectDirection: u.card.effectDirection ?? null,
            findingShort: u.card.findingShort ?? null,
            mechanism: u.card.mechanism ?? null,
          }
        : null,
      isUpload: true,   // user-supplied — flagged "unverified" in the bibliography
    });
    evidenceIds.push(workId);
  }
  coding.total = coding.papers.length;
}

// ---------------------------------------------------------------------------
// Evidence selection per section (mirrors draft-section.mjs logic)
// ---------------------------------------------------------------------------

// Returns ALL evidence papers ranked by relevance to this section
// (design match → has evidence card → SMS level → year). No cap — the
// evidence corpus is the source of truth for the whole paper. Ranking
// matters only if a model ever truncates a long prompt: most-relevant
// papers come first.
function pickEvidenceForSection(
  sheet: { papers: any[] },
  section: { expectedDesigns?: string[] },
): any[] {
  const wanted = new Set((section.expectedDesigns ?? []).map(normalizeDesign));
  const scored = sheet.papers.map((p) => {
    const d = normalizeDesign(p.card?.design ?? p.methodologyDesign);
    const designMatch = wanted.size > 0 && wanted.has(d) ? 1 : 0;
    return {
      p,
      score:
        designMatch * 100 +
        (p.hasCard ? 30 : 0) +
        (p.smsLevel ?? 0) * 5 +
        (p.year ? Math.min(p.year - 2000, 30) : 0) / 10,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.p);
}

// ---------------------------------------------------------------------------
// Evidence fence — strips [workId] tokens not in the retrieved evidence set
// from body prose so rendered text never contains ghost citations.
// Runs after normalizeCitations(), before extractCitedIds().
// ---------------------------------------------------------------------------

export function fenceBodyToEvidence(body: string, validIds: Set<string>): string {
  if (!body) return body;
  return body
    .replace(/\[([^\]]+)\]/g, (match, id) => validIds.has(id.trim()) ? match : "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

// ---------------------------------------------------------------------------
// Citation normalizer (mirrors citationNormalizer.ts — Node duplicate)
// ---------------------------------------------------------------------------

const MANGLED_RE = /\[ss:(\d+(?:\/[^\]\s]+)?)\]/g;
const NBER_RE = /^10\.3386\/w(\d+)$/i;
const SSRN_RE = /^10\.2139\/ssrn\.(\d+)$/i;
const DOI_RE = /^10\.[^/]+\/.+/i;

function buildSuffixIndex(papers: any[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const p of papers) {
    const id: string = p?.workId;
    if (!id) continue;
    const add = (key: string) => {
      const arr = index.get(key);
      if (arr) { if (!arr.includes(id)) arr.push(id); }
      else { index.set(key, [id]); }
    };
    if (DOI_RE.test(id)) add(id.slice(3));
    const nber = id.match(NBER_RE);
    if (nber) add(nber[1]);
    const ssrn = id.match(SSRN_RE);
    if (ssrn) add(ssrn[1]);
  }
  return index;
}

export function normalizeCitations(text: string, papers: any[]): string {
  if (!text) return text;
  const index = buildSuffixIndex(papers);
  if (index.size === 0) return text;
  let dropped = false;
  const out = text.replace(MANGLED_RE, (_m, body) => {
    const matches = index.get(body);
    if (!matches || matches.length !== 1) { dropped = true; return ""; }
    return `[${matches[0]}]`;
  });
  return dropped
    ? out.replace(/\s+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ")
    : out;
}

// ---------------------------------------------------------------------------
// Section drafter
// ---------------------------------------------------------------------------

// Exported for offline verification (cache-prefix byte-identity across sections).
export function buildSectionPrompt(
  outline: any,
  section: any,
  evidence: any[],
  exemplarText: string,
  exemplarTitle: string,
  priorSections: any[],
  emphasis?: { themes?: string[]; spotlightDebate?: string; audience?: string } | null,
  revisionInstruction?: string | null,
) {
  const designs = Array.isArray(section.expectedDesigns)
    ? section.expectedDesigns.join(", ")
    : "(unspecified)";

  // Count papers in the corpus whose design matches this section's expected
  // channel (e.g. expectedDesigns = ["RCT","DiD"] → all RCT/DiD papers in the
  // evidence corpus). At least 50% of these must be cited in this section.
  const wantedDesigns = new Set((section.expectedDesigns ?? []).map(normalizeDesign));
  const designMatchedPapers = wantedDesigns.size > 0
    ? evidence.filter((p) => wantedDesigns.has(normalizeDesign(p.card?.design ?? p.methodologyDesign)))
    : [];
  const designChannelMin = designMatchedPapers.length > 0
    ? Math.ceil(designMatchedPapers.length / 2)
    : 0;
  const overallCitationMin = Math.max(Math.min(Math.floor(evidence.length * 0.6), 25), 5);

  // "Cite what matters" tiering — rank each paper's importance to THIS section
  // so the drafter cites selectively instead of force-citing 60% of everything.
  // CORE = on-design / rigorous (sms≥4) / field-central (cit≥75) AND has real
  // content; peripheral = thin or off-topic → explicitly droppable.
  const tierOf = (p: any): "CORE" | "supporting" | "peripheral" => {
    // Prefer the precomputed channel-dependent + relevance-gated CORE flag.
    if (typeof p._core === "boolean") {
      if (p._core) return "CORE";
      if (p._relevant === false && !paperHasContent(p)) return "peripheral";
      return "supporting";
    }
    // Fallback (CORE tiering unavailable): crude signal-based tiering.
    const d = normalizeDesign(p.card?.design ?? p.methodologyDesign);
    const designMatch = wantedDesigns.size > 0 && wantedDesigns.has(d);
    const rigor = (p.smsLevel ?? 0) >= 4;
    const central = (p.citationCount ?? 0) >= 75;
    const hasFinding = !!(p.card?.findingShort || (p as any).dossier?.fulltext_md || p.abstract);
    const signals = (designMatch ? 1 : 0) + (rigor ? 1 : 0) + (central ? 1 : 0);
    if (!hasFinding) return "peripheral";
    if (signals >= 2 || (designMatch && hasFinding)) return "CORE";
    if (signals === 0) return "peripheral";
    return "supporting";
  };
  const tiers = new Map<string, string>(evidence.map((p) => [p.workId, tierOf(p)]));
  const coreCount = [...tiers.values()].filter((t) => t === "CORE").length;
  // Active channels present in THIS section's CORE evidence (for the mix rule).
  const sectionChannelCore: Record<string, number> = {};
  for (const p of evidence) {
    if (tiers.get(p.workId) === "CORE") for (const ch of ((p as any)._channels ?? [])) sectionChannelCore[ch] = (sectionChannelCore[ch] ?? 0) + 1;
  }
  const activeChannels = CHANNEL_IDS.filter((ch) => (sectionChannelCore[ch] ?? 0) > 0);
  const coreCiteMin = coreCount > 0
    ? Math.min(Math.max(Math.ceil(coreCount * 0.8), 3), 25)
    : Math.min(5, evidence.length);

  // CACHE-FRIENDLY SPLIT (2026-07-06): the system prompt and the user PREFIX
  // (article title + voice anchor + evidence block) are byte-identical across
  // every section call of a paper; all per-section content (heading, scope,
  // dynamic citation minimums, prior sections) lives in the user SUFFIX. That
  // lets Gemini's implicit prefix cache and Claude's cache_control (see
  // callSynthProvider) discount the big shared evidence block on every call
  // after the first, instead of paying full price ~7+ times per paper.
  const system = [
    `You are the Section Drafter Agent for the Horizon Scanner JEL Survey pipeline.`,
    `You write ONE section of a JEL-style survey article. The SECTION BRIEF (heading, scope, target words, citation minimums) follows the shared evidence in the user message.`,
    "",
    ...JEL_CITATION_RULES,
    "",
    "CITATION SPREAD (HARD — violations produce a worthless section; per-section minimums are in the SECTION BRIEF):",
    ...JEL_SPREAD_RULES,
    "",
    ...JEL_CITATION_CONTEXT_RULES,
    ...(DOSSIER_ENRICH ? [
      "",
      JEL_FRAMING_PROSE_RULE,
    ] : []),
    "",
    JEL_SECTION_OUTPUT_RULE,
  ].join("\n");

  // Per-section citation minimums — moved out of the system prompt so the
  // system stays identical across sections (cache prefix requirement).
  const sectionRequirements = [
    "SECTION CITATION REQUIREMENTS (HARD):",
    ...(DOSSIER_ENRICH ? [
      `- CITE WHAT MATTERS — quality over coverage. The EVIDENCE block tags each paper [CORE], [supporting], or [peripheral]. This section has ${coreCount} CORE papers. You MUST cite at least ${coreCiteMin} CORE papers. Cite [supporting] papers ONLY where they add distinct evidence (a mechanism, a contrast, a context). You MAY OMIT [peripheral] papers entirely — do NOT force in off-topic, redundant, or low-information papers. Forcing a weak paper in is WORSE than omitting it; a real JEL survey cites selectively, not exhaustively.`,
      ...(activeChannels.length > 1 ? [
        `- CHANNEL MIX — represent the evidence types the user selected. This section's CORE evidence spans ${activeChannels.map((ch) => `${ch}(${sectionChannelCore[ch]})`).join(", ")}. Where the section's topic allows, cite from EACH of these channels — do not collapse the section onto one channel (e.g. all-causal or all-foundational).`,
      ] : []),
    ] : [
      `- This section has ${evidence.length} papers available. You MUST cite at least ${overallCitationMin} distinct workIds overall.`,
    ]),
    designChannelMin > 0
      ? `- DESIGN CHANNEL RULE: ${designMatchedPapers.length} papers match this section's expected designs (${[...wantedDesigns].join(", ")}). You MUST cite at least ${designChannelMin} of those design-matched papers.`
      : "- No specific design channel for this section — cite across the full evidence corpus.",
  ].join("\n");

  const evidenceSummary = evidence.map((p, idx) => {
    const card = p.card;
    const tierLabel = DOSSIER_ENRICH ? `[${tiers.get(p.workId) ?? "supporting"}] ` : "";
    // Compressed tail (2026-07-06): full multi-line detail only for the ranked
    // head + CORE papers. The criterion is deliberately SECTION-INDEPENDENT
    // (global rank + global _core flag, never this section's design match) so
    // the whole evidence block stays byte-identical across section calls
    // (cache prefix requirement — see the split comment above).
    const fullDetail = idx < SECTION_EVIDENCE_FULL_CAP || p._core === true;
    if (!fullDetail) {
      const authorsShort = (p.authors ?? []).slice(0, 3).join("; ") + ((p.authors?.length ?? 0) > 3 ? " et al." : "");
      const parts = [
        `${tierLabel}workId: ${p.workId} | "${p.title}" | authors: ${authorsShort || "n/a"}`,
        `${p.year ?? "n/a"}, ${normalizeDesign(p.card?.design ?? p.methodologyDesign)}, sms ${p.smsLevel ?? "?"}`,
        (p.geography ?? []).slice(0, 2).join(", ") || "—",
      ];
      if (card?.findingShort) parts.push(`finding: ${card.findingShort}`);
      return parts.join(" | ");
    }
    const lines = [
      `${tierLabel}workId: ${p.workId}`,
      `title: ${p.title}`,
      `authors: ${(p.authors ?? []).slice(0, 8).join("; ") || "n/a"}`,
      `year: ${p.year ?? "n/a"} | sms: ${p.smsLevel ?? "?"} | design: ${normalizeDesign(p.card?.design ?? p.methodologyDesign)}`,
      `geography: ${(p.geography ?? []).join(", ") || "not specified"}`,
    ];
    if (card?.intervention) lines.push(`intervention: ${card.intervention}`);
    if (card?.outcome) lines.push(`outcome: ${card.outcome}`);
    if (card?.effectSizeText) lines.push(`effect: ${card.effectSizeText}`);
    if (card?.findingShort) lines.push(`finding: ${card.findingShort}`);
    const dossier = (p as any).dossier;
    if (dossier?.fulltext_md) {
      // Substance lift over abstract.slice(0,300). Provenance-gated: ASSERT
      // full-text (oa_pdf) magnitudes; HEDGE verified-web ones.
      const webSourced = dossier.fulltext_source === "web";
      lines.push(webSourced
        ? `verified web summary (found on the web by name-match, NOT read from the paper's full text — HEDGE every magnitude: "the study reports approximately ..."; use for findings/caveats):\n${dossier.fulltext_md}`
        : `full-text brief (extracted from the paper's full text — magnitudes may be ASSERTED; use for methods, sample, identification, magnitudes):\n${dossier.fulltext_md}`);
    } else if (p.abstract && !card?.findingShort) {
      lines.push(`abstract: ${p.abstract.slice(0, 300)}`);
    }
    if (dossier?.context_note) {
      // Uncited, non-empirical framing only. NEVER a citable finding.
      lines.push(`context (non-empirical framing — NOT a citable finding; do not attach this paper's [workId] to a claim sourced only from here): ${dossier.context_note}`);
    }
    return lines.join("\n");
  }).join("\n\n---\n\n");

  // Prior sections: pass heading + first ~200 words + cited workIds so each
  // section builds on prior arguments and diversifies citations.
  const allPriorCited = new Set(priorSections.flatMap((s) => s.citedWorkIds ?? []));
  const priorBlock = priorSections.length > 0
    ? "PRIOR SECTIONS (read these to avoid repetition and build coherence):\n" +
      priorSections.map((s) => {
        const preview = s.bodyPreview
          ? `\n  [excerpt]: ${s.bodyPreview}`
          : "";
        return `§${s.number} ${s.heading} (${s.wordCount ?? "?"} words)${preview}`;
      }).join("\n\n")
    : "";
  // Tell each section which workIds are already well-covered so it prioritises uncited papers.
  const alreadyCitedBlock = allPriorCited.size > 0
    ? `\nWORKIDS ALREADY CITED IN PRIOR SECTIONS (${allPriorCited.size}): ${[...allPriorCited].join(", ")}\n` +
      `Prioritise papers NOT in the above list. You may still cite them for direct contradictions or key benchmarks, but avoid citing the same papers that dominate prior sections.`
    : "";

  const emphasisLines: string[] = [];
  if (emphasis) {
    const themes = emphasis.themes?.filter(Boolean) ?? [];
    if (themes.length) emphasisLines.push(`EMPHASIS: where the evidence in THIS section supports it, foreground these themes: ${themes.join(", ")}. Do not force them onto unrelated evidence.`);
    if (emphasis.spotlightDebate) emphasisLines.push(`If this section touches the debate "${emphasis.spotlightDebate}", present BOTH sides explicitly with their strongest evidence.`);
    if (emphasis.audience) emphasisLines.push(`Audience: ${emphasis.audience}. ${emphasis.audience === "policy" ? "Lead with magnitudes and policy relevance; keep methodology precise but secondary." : "Be precise about identification and methodology."}`);
  }
  const emphasisBlock = emphasisLines.length > 0 ? emphasisLines.join("\n") : "";

  const revisionBlock = revisionInstruction
    ? `REVISION INSTRUCTION (HIGHEST PRIORITY — you are rewriting this existing section per the user's request): ${revisionInstruction}\nApply this instruction while keeping all citation rules above. Preserve on-topic claims that the instruction does not ask to change.`
    : "";

  // Shared PREFIX — byte-identical for every section of this paper (the
  // evidence array must arrive in the same canonical order at every call).
  const userPrefix = [
    `ARTICLE TITLE: ${outline.title}`,
    "",
    `VOICE ANCHOR (${exemplarTitle}):`,
    exemplarText,
    "",
    `EVIDENCE (${evidence.length} papers — shared across all sections):`,
    evidenceSummary,
  ].join("\n");

  // Per-section SUFFIX — everything that varies between section calls.
  const userSuffix = "\n" + [
    `SECTION BRIEF:`,
    `SECTION: §${section.number} — ${section.heading}`,
    `SCOPE: ${section.scope}`,
    `TARGET WORDS: ${section.targetWords} — write approximately this many words.`,
    `EXPECTED STUDY DESIGNS: ${designs}`,
    sectionRequirements,
    revisionBlock,
    priorBlock,
    alreadyCitedBlock,
    emphasisBlock,
    "",
    "Draft the section now.",
  ].filter(Boolean).join("\n");

  return { system, user: { prefix: userPrefix, suffix: userSuffix } as SplitUserPrompt };
}

// ---------------------------------------------------------------------------
// Section classifier
//
// "Descriptive" sections (intro, background, stylized facts, data overview)
// are structurally independent — they cite papers but don't build on prior
// analytical arguments. These run with Qwen in parallel at the start.
//
// "Analytical" sections (theory, empirical evidence, mechanisms, heterogeneity,
// research agenda) depend on each other's conclusions and must run sequentially
// with Gemini, each receiving prior body excerpts for coherence.
// ---------------------------------------------------------------------------

function isDescriptiveSection(section: any): boolean {
  const text = `${section.heading ?? ""} ${section.scope ?? ""}`.toLowerCase();
  const descriptive = /\b(introduct|background|institutio|stylized fact|data|overview|prior survey|survey of the lit|context|empirical pattern|trend|landscape)\b/;
  const analytical = /\b(theor|mechanism|identif|causal|heterogen|external valid|policy impl|research agenda|future|open question|empirical evidence)\b/;
  return descriptive.test(text) && !analytical.test(text);
}

// ---------------------------------------------------------------------------
// Voice anchor loader
// ---------------------------------------------------------------------------

const EXEMPLAR_LABELS: Record<string, string> = {
  "list-experiments-children.txt": "List, Petrie & Samek, JEL 61(2) 2023",
  "korinek-generative-ai.txt": "Korinek, JEL 61(4) 2023",
  "shy-cash-alive.txt": "Shy, JEL 61(4) 2023",
  "acemoglu-restrepo-automation.txt": "Acemoglu & Restrepo, JEL (2019)",
  "globalization-inequality-lac.txt": "JEL survey on Globalization and Inequality in LAC",
  "chetty-mobility.txt": "Chetty et al., mobility voice",
  "duflo.txt": "Duflo, experimental development economics",
};

async function loadVoiceAnchor(): Promise<{ text: string; title: string }> {
  // Find the repo root relative to this file at runtime
  const url = import.meta.url;
  // Resolve: supabase/functions/_shared/ → repo root
  const repoRoot = new URL("../../../", url).pathname;
  const exemplarDir = `${repoRoot}evals/jel-exemplars`;

  const filenames = Object.keys(EXEMPLAR_LABELS);
  for (const filename of filenames) {
    try {
      const raw = await Deno.readTextFile(`${exemplarDir}/${filename}`);
      const words = raw.split(/\s+/);
      const slice = words.slice(200, 200 + VOICE_ANCHOR_WORDS).join(" ");
      return { text: slice, title: EXEMPLAR_LABELS[filename] };
    } catch {
      // try next
    }
  }
  return { text: "(no voice anchor available)", title: "(none)" };
}

// ---------------------------------------------------------------------------
// Word count helper
// ---------------------------------------------------------------------------

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Extract cited work IDs from body text
// ---------------------------------------------------------------------------

export function extractCitedIds(body: string, validIds: Set<string>): string[] {
  const found = new Set<string>();
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = m[1].trim();
    if (validIds.has(id)) found.add(id);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Strip leading heading-echo the drafter sometimes prepends to prose
// (the heading is supplied by the outline + rendered separately, so an echoed
// 'SECTION §4 "Title":' / '§4 — Title' / bare-title line shows the heading 2-3×).
// Pure function — exported so the Corrector can reuse it without duplication.
// ---------------------------------------------------------------------------

/**
 * Strip markdown markup a drafter model may emit despite the plain-prose
 * contract (JEL_SECTION_OUTPUT_RULE). Safety net for weaker models
 * (gemini-flash / qwen) that occasionally format a "categorize the evidence"
 * section as an annotated bibliography — '### §2. Heading', '#### Causal
 * Evidence', '- **** Author (year)…'. Removes the MARKUP (ATX headings, list
 * bullets, bold/italic markers, code fences); it does not restructure prose —
 * the prompt does that. Must run BEFORE stripLeadingHeadingEcho so an unwrapped
 * '### §2. …' becomes '§2. …' and the heading-echo strip can then catch it.
 */
export function stripSectionMarkdown(body: string): string {
  if (!body) return body;
  const lines = body.split("\n").map((raw) => {
    let ln = raw;
    if (/^\s*```/.test(ln)) return "";                       // code-fence line → drop
    ln = ln.replace(/^\s{0,3}#{1,6}\s+/, "");                // ATX heading marker
    ln = ln.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "");     // list bullet / number
    ln = ln.replace(/\*\*/g, "").replace(/__/g, "");         // bold markers (incl. empty '****')
    return ln;
  });
  return lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// "Cited Papers" observed leaking from a Qwen recovery draft 2026-07-13 —
// shipped in a real section because neither this nor checkProse matched it.
const _APPARATUS_HEAD_RE = /^\s*(references|works cited|bibliography|cited (papers|works|references)|citations)\s*:?\s*$/i;
/**
 * Strip section "apparatus" a drafter may bolt on despite the prose contract:
 * a trailing References/Works Cited/Bibliography list (the paper builds ONE real
 * bibliography table separately) and isolated bare sub-heading lines left behind
 * after markdown stripping (e.g. "Scale and Trends", "Conclusion" — a section
 * must not carry its own headings or its own conclusion). Conservative: only
 * removes a References block (heading + everything after it) and short,
 * isolated, terminal-punctuation-free, citation-free title-case lines.
 */
export function stripSectionApparatus(body: string): string {
  if (!body) return body;
  let lines = body.split("\n");
  const refIdx = lines.findIndex((l) => _APPARATUS_HEAD_RE.test(l));
  if (refIdx >= 0) lines = lines.slice(0, refIdx);                      // cut refs + trailing list
  const isBareHeading = (l: string, prev?: string, next?: string): boolean => {
    const t = (l ?? "").trim();
    if (t.length < 3 || t.length > 60) return false;
    if (/[.?!,;]$/.test(t) || /[\[\]]/.test(t)) return false;          // sentences / citations are not headings
    const words = t.split(/\s+/);
    if (words.length > 7) return false;
    if ((prev ?? "").trim() !== "" || (next ?? "").trim() !== "") return false; // must be isolated
    const content = words.filter((w) => !/^(and|or|of|the|for|to|in|on|a|an)$/i.test(w));
    const caps = content.filter((w) => /^[A-Z]/.test(w)).length;
    return content.length > 0 && caps / content.length >= 0.6;         // title-case-ish
  };
  const out = lines.filter((l, i) => !isBareHeading(l, lines[i - 1], lines[i + 1]));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Detect a section body that is not prose but leaked model working-notes — a
 * weaker drafter (gemini-flash / qwen) occasionally emits its citation-formatting
 * worksheet ("Author; Author -> Author et al. (year) [id]") or a bracketed
 * reasoning aside ("(Wait, … is correct)") INSTEAD of the section. The word-floor
 * recovery guard misses these (a legend can run 150+ words). Returns a reason
 * string or null.
 */
export function sectionContentIssue(body: string): string | null {
  const b = body ?? "";
  if (/\(\s*wait[,:\s]/i.test(b) || /\bas an? (AI|language model)\b/i.test(b)) return "model working-notes leaked";
  const arrows = (b.match(/(?:->|→)/g) ?? []).length;
  const legendLines = b.split("\n").filter((l) => /(?:->|→)/.test(l) && /\[[^\]]+\]/.test(l)).length;
  if (legendLines >= 3 || arrows >= 4) return "citation-legend / scratchpad leaked";
  return null;
}

export function stripLeadingHeadingEcho(body: string, heading: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hN = norm(heading || "");
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i].trim();
    if (ln === "") { i++; continue; }                                  // leading blanks
    const isLabel = /^section\s*§?\s*[\d.]+/i.test(ln) || /^§\s*[\d.]+/.test(ln); // 'SECTION §4 …' / '§4 — …'
    const isBareHeading = hN.length > 8 && norm(ln.replace(/^["""']|["""':]+$/g, "")) === hN; // exact heading line
    if (isLabel || isBareHeading) { i++; continue; }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Devil's Advocate — challenges the paper's thesis across 8 dimensions
//
// Adapted from the academic-research-skills DA protocol:
// concession requires score ≥4, attack intensity preserved, no frame-lock.
// Writes a "Critical Assessment" section appended to the paper.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-agent Devil's Advocate — 3 specialist reviewers run in parallel,
// each blind to the others, then a synthesis agent combines their findings.
// Replaces the single DA call. ~30s vs ~18s for single agent (+13s overhead),
// but produces significantly more specific, role-differentiated critiques.
// ---------------------------------------------------------------------------

async function callDevilsAdvocate(
  outline: any,
  draftedSections: any[],
  coding: { papers: any[] },
): Promise<{ body: string; sectionRevisions: Array<{ section: string; instruction: string }> }> {
  const contentSections = draftedSections.filter(
    (s) => !["critique", "coherence"].includes(String(s.number)),
  );
  const sectionSummaries = contentSections.map((s) =>
    `§${s.number} "${s.heading}":\n  ${s.body.split(/\s+/).slice(0, 200).join(" ")}…`
  ).join("\n\n");

  const smsCounts: Record<string, number> = {};
  const geoCounts: Record<string, number> = {};
  for (const p of coding.papers) {
    const sms = String(p.smsLevel ?? "?");
    smsCounts[sms] = (smsCounts[sms] || 0) + 1;
    for (const g of (p.geography ?? [])) geoCounts[g] = (geoCounts[g] || 0) + 1;
  }
  const topGeos = Object.entries(geoCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g, n]) => `${g}(${n})`).join(", ");
  const smsProfile = Object.entries(smsCounts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([s, n]) => `SMS${s}:${n}`).join(", ");

  const context = [
    `ARTICLE: ${outline.title}`,
    `ABSTRACT: ${(outline.abstract ?? "").slice(0, 400)}`,
    `EVIDENCE BASE: ${coding.papers.length} papers | SMS profile: ${smsProfile} | Top geographies: ${topGeos}`,
    "",
    "SECTION SUMMARIES (first 200 words each):",
    sectionSummaries,
  ].join("\n");

  // Phase A — 3 specialists run in parallel, each with a focused mandate
  const [methodResult, lacResult, policyResult] = await Promise.allSettled([

    callGemini(
      [
        "You are a quantitative methods specialist reviewing a JEL survey paper for NBER/World Bank peer review.",
        "Focus ONLY on: causal identification (are observational studies treated as causal?), threats to internal validity,",
        "publication bias and p-hacking concerns, methodology concentration (over-reliance on one design),",
        "and whether effect sizes are credibly estimated. Ignore geographic scope — that is another reviewer's job.",
        "Write 300-400 words of analytical prose. Name specific sections. Do NOT be sycophantic.",
        'OUTPUT JSON: { "critique": "<prose>", "topIssues": ["issue1","issue2","issue3"] }',
      ].join("\n"),
      context + "\n\nWrite your methodology-focused critique.",
      4096, true, "jel_devils_advocate", GEMINI_JEL_QA_MODEL,
    ),

    callGemini(
      [
        "You are a Latin America & Caribbean regional specialist reviewing a JEL survey paper for IADB economists.",
        "Focus ONLY on: external validity for LAC contexts, transferability of findings from OECD/Asia to LAC,",
        "geographic concentration of studies, missing LAC sub-regions or country types, country income heterogeneity",
        "(Haiti vs Chile), informal economy nuances, and LAC-specific structural factors the paper overlooks.",
        "Ignore econometric design details — that is another reviewer's job.",
        "Write 300-400 words of analytical prose. Name specific sections. Do NOT be sycophantic.",
        'OUTPUT JSON: { "critique": "<prose>", "topIssues": ["issue1","issue2","issue3"] }',
      ].join("\n"),
      context + "\n\nWrite your LAC-focused critique.",
      4096, true, "jel_devils_advocate", GEMINI_JEL_QA_MODEL,
    ),

    callGemini(
      [
        "You are a senior policy practitioner reviewing a JEL survey paper for IADB operational teams.",
        "Focus ONLY on: whether the evidence actually informs actionable policy decisions, evidence-to-policy gaps,",
        "implementation feasibility in LAC, missing cost-effectiveness data, time lags between research and policy relevance,",
        "and whether the research frontier addresses what governments actually need to decide right now.",
        "Ignore econometric methodology — that is another reviewer's job.",
        "Write 300-400 words of analytical prose. Name specific sections. Do NOT be sycophantic.",
        'OUTPUT JSON: { "critique": "<prose>", "topIssues": ["issue1","issue2","issue3"] }',
      ].join("\n"),
      context + "\n\nWrite your policy-focused critique.",
      4096, true, "jel_devils_advocate", GEMINI_JEL_QA_MODEL,
    ),
  ]);

  const methodAgent = methodResult.status === "fulfilled" ? methodResult.value : { critique: "(methodology review unavailable)" };
  const lacAgent    = lacResult.status === "fulfilled"    ? lacResult.value    : { critique: "(LAC review unavailable)" };
  const policyAgent = policyResult.status === "fulfilled" ? policyResult.value : { critique: "(policy review unavailable)" };

  // Phase B — synthesis agent reads all three and produces unified critique
  const synthesisResult = await callGemini(
    [
      "You are the lead editor synthesizing three independent peer reviews of a JEL survey.",
      "You receive reviews from a methodology specialist, a LAC regional specialist, and a policy practitioner.",
      "Identify where reviewers AGREE (high-priority cross-cutting issues) and where they complement each other.",
      "Produce a unified, non-redundant critique of ~700-900 words that is richer than any single reviewer.",
      "Where specialists diverge, say so explicitly — disagreement between experts is informative.",
      "End with a 'Paths Forward' paragraph identifying what evidence would resolve the key open questions.",
      "Write in JEL-style analytical prose. NOT bullet points. Do NOT be sycophantic.",
      "ALSO: identify up to THREE specific sections (by their § number from the SECTION SUMMARIES) whose prose would most improve by engaging your critique, and for each give a concrete rewrite directive (name the tension/gap, reconcile or attribute the disagreement, weigh evidence quality). Only sections that genuinely need it — fewer is fine.",
      "OUTPUT JSON (no markdown fences):",
      '{ "heading": "Critical Assessment: Evidence Gaps and Contested Interpretations",',
      '  "body": "<700-900 word unified critique>",',
      '  "specialistDivergence": "<one sentence on where specialists disagreed>",',
      '  "sectionRevisions": [ { "section": "<§ number, e.g. 3>", "instruction": "<concrete rewrite directive for that section>" } ] }',
    ].join("\n"),
    [
      `METHODOLOGY REVIEW:\n${methodAgent.critique ?? JSON.stringify(methodAgent)}`,
      `\nLAC REVIEW:\n${lacAgent.critique ?? JSON.stringify(lacAgent)}`,
      `\nPOLICY REVIEW:\n${policyAgent.critique ?? JSON.stringify(policyAgent)}`,
      "\nSynthesize into unified critique now.",
    ].join("\n"),
    8192, true, "jel_devils_advocate", GEMINI_JEL_QA_MODEL,
  );

  return {
    body: synthesisResult?.body ?? synthesisResult?.text ?? "",
    sectionRevisions: Array.isArray(synthesisResult?.sectionRevisions) ? synthesisResult.sectionRevisions : [],
  };
}

// ---------------------------------------------------------------------------
// Kris citation validator — verifies each cited DOI against OpenAlex.
// Flags title mismatches (potential abstract-recall errors) and citations
// not found in OA (IDB/CEPAL working papers — expected, not errors).
// Stores results in outline.krisReport. Runs after all sections + DA.
// Fast (~1-2s for 30-50 DOI citations) — no Gemini calls.
// ---------------------------------------------------------------------------

async function callKrisValidator(
  draftedSections: any[],
  papers: any[],
): Promise<any> {
  // Build local title lookup from evidence papers
  const localById = new Map(papers.map((p) => [p.workId, p]));

  // Collect all unique cited DOI workIds across all content sections
  const citedIds = new Set<string>();
  for (const s of draftedSections) {
    if (["critique", "coherence"].includes(String(s.number))) continue;
    for (const id of (s.citedWorkIds ?? [])) {
      if (String(id).startsWith("10.")) citedIds.add(String(id));
    }
  }

  const doiList = [...citedIds];
  if (doiList.length === 0) return { verified: 0, notInOA: 0, mismatches: [] };

  const results = { verified: 0, notInOA: 0, mismatches: [] as any[] };
  const BATCH = 25;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < doiList.length; i += BATCH) {
    const batch = doiList.slice(i, i + BATCH);
    const filter = `doi:${batch.join("|")}`;
    const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&select=doi,title&per-page=25&mailto=horizon-scanner@iadb.org`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      const oaByDoi = new Map<string, any>();
      for (const r of (data.results ?? [])) {
        const doi = (r.doi || "").toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
        if (doi) oaByDoi.set(doi, r);
      }

      for (const id of batch) {
        const local = localById.get(id);
        const oa = oaByDoi.get(id.toLowerCase());
        if (!oa) { results.notInOA++; continue; }

        // Fuzzy title match — first 30 chars, normalised
        const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
        const localTitle = norm(local?.title ?? "");
        const oaTitle    = norm(oa.title ?? "");
        const match = localTitle.length > 10 && oaTitle.length > 10 &&
          (localTitle.startsWith(oaTitle.slice(0, 20)) || oaTitle.startsWith(localTitle.slice(0, 20)));

        if (match) {
          results.verified++;
        } else {
          results.mismatches.push({ id, localTitle: local?.title?.slice(0, 80), oaTitle: oa.title?.slice(0, 80) });
        }
      }
    } catch {
      // OA unreachable — skip batch silently, don't fail the pipeline
    }
    if (i + BATCH < doiList.length) await sleep(120);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Coherence Editor — reads across all sections and flags structural problems:
//   repetition, contradictions, citation over-concentration, unfulfilled scope,
//   missed handoffs between sections.
// Stores a structured report in outline.coherenceReport (no sections modified).
// ---------------------------------------------------------------------------

async function callCoherenceEditor(
  outline: any,
  draftedSections: any[],
  coding: { papers: any[] },
): Promise<any> {
  // Citation frequency across all content sections
  const citationFreq: Record<string, number> = {};
  for (const s of draftedSections) {
    if (["critique", "coherence"].includes(String(s.number))) continue;
    for (const id of (s.citedWorkIds ?? [])) {
      citationFreq[id] = (citationFreq[id] || 0) + 1;
    }
  }
  const overused = Object.entries(citationFreq)
    .filter(([, n]) => n >= 4)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} (${n}×)`);

  const contentSections = draftedSections.filter(
    (s) => !["critique", "coherence"].includes(String(s.number)),
  );

  const sectionPreviews = contentSections.map((s) =>
    `§${s.number} "${s.heading}" (${s.wordCount}w):\n` +
    s.body.split(/\s+/).slice(0, 300).join(" ") + "…"
  ).join("\n\n---\n\n");

  const system = [
    "You are the Coherence Editor for a JEL-style survey article.",
    "You read across ALL sections and identify structural quality problems.",
    "",
    "Check for EXACTLY these 5 issue types:",
    "1. REPETITION — arguments or findings stated in nearly identical terms in 2+ sections",
    "2. CONTRADICTION — section N+1 states something that conflicts with section N's conclusion",
    "3. CITATION_CONCENTRATION — workIds cited 4+ times across the paper (over-anchoring)",
    "4. UNFULFILLED_SCOPE — section's outline scope not addressed in the actual draft",
    "5. MISSED_HANDOFF — section N does not build on or acknowledge section N-1's conclusion",
    "",
    "For EACH issue found, produce:",
    '  { "type": "repetition"|"contradiction"|"citation_concentration"|"unfulfilled_scope"|"missed_handoff",',
    '    "sections": ["§3", "§4"],',
    '    "description": "one specific sentence describing the issue",',
    '    "suggestion": "one actionable sentence on how to fix it" }',
    "",
    "Also identify 2-3 genuine strengths of the paper's structure.",
    "",
    "OUTPUT (JSON only, no markdown fences):",
    '{ "overallAssessment": "2-sentence summary", "issues": [...], "strengths": ["..."] }',
  ].join("\n");

  // Papers in the evidence set that have NOT been cited at all yet
  const citedIds = new Set(Object.keys(citationFreq));
  const uncitedPapers = coding.papers
    .filter((p) => !citedIds.has(p.workId))
    .slice(0, 20)
    .map((p) => `[${p.workId}] "${p.title}" (${p.year}, ${p.design ?? "unclassified"})`);

  const user = [
    `ARTICLE: ${outline.title}`,
    overused.length > 0
      ? `\nOVERUSED CITATIONS (cited ≥4× — need diversification): ${overused.join(", ")}`
      : "",
    uncitedPapers.length > 0
      ? `\nUNCITED PAPERS IN EVIDENCE SET (candidates for replacing overused ones):\n${uncitedPapers.join("\n")}`
      : "",
    "",
    "SECTION PREVIEWS (first 300 words each):",
    sectionPreviews,
    "",
    "Identify coherence issues now. For citation_concentration issues, name specific uncited papers from the list above that should replace the overused citation.",
  ].filter(Boolean).join("\n");

  // Largest structured output of any pass (full issues report) — needs the most
  // headroom to avoid mid-array truncation.
  return await callGemini(system, user, 16384, true, "jel_coherence", GEMINI_JEL_QA_MODEL);
}

// ---------------------------------------------------------------------------
// Claim Auditor — runs inline before status=done (diagnostic).
// Audits EVERY cited paper (one representative claim each) on Qwen
// (Gemini fallback). Returns the report; caller stores it in outline.auditReport.
// ---------------------------------------------------------------------------

function extractClaims(
  body: string,
  validIds: Set<string>,
): Array<{ sentence: string; workId: string }> {
  const claims: Array<{ sentence: string; workId: string }> = [];
  const sentences = body.split(/(?<=[.!?])\s+/);
  const idRe = /\[([^\]]+)\]/g;
  for (const sentence of sentences) {
    idRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(sentence)) !== null) {
      const id = m[1].trim();
      if (validIds.has(id)) claims.push({ sentence: sentence.slice(0, 400), workId: id });
    }
  }
  return claims;
}

async function runClaimAudit(
  draftedSections: any[],
  coding: { papers: any[] },
  validIds: Set<string>,
  log: (msg: string) => void,
): Promise<{ summary: { supported: number; partial: number; unsupported: number; unverifiable: number }; total: number; claims: any[] }> {
  log("claim auditor: starting pass…");
  const worksMap = new Map(coding.papers.map((p) => [p.workId, p]));

  // Extract one representative claim per cited workId (audit each paper once)
  const seenIds = new Set<string>();
  const allClaims: Array<{ sentence: string; workId: string; section: string }> = [];
  for (const s of draftedSections) {
    if (["critique", "coherence"].includes(String(s.number))) continue;
    for (const c of extractClaims(s.body ?? "", validIds)) {
      if (!seenIds.has(c.workId)) {
        seenIds.add(c.workId);
        allClaims.push({ ...c, section: `§${s.number}` });
      }
    }
  }

  // Audit EVERY cited paper (one representative claim each) — the Corrector needs
  // full visibility to fix unsupported claims, not a 25-sample.
  log(`claim auditor: auditing all ${allClaims.length} cited claims`);

  type AuditClaim = { sentence: string; workId: string; section: string };
  const results: any[] = [];

  // Split off claims with no source evidence — those are "unverifiable" without
  // spending an LLM call (identical to the old per-claim early return). The rest
  // are audited in BATCHES: ~8 claim/source pairs per LLM call instead of one call
  // each. Coverage is unchanged (every cited claim still gets a verdict) — this is
  // batching, NOT sampling.
  const auditable: Array<{ claim: AuditClaim; evidence: string }> = [];
  for (const claim of allClaims) {
    const paper = worksMap.get(claim.workId);
    // 2026-07-22: a quarantined/recalled abstract_source means the abstract
    // text (if any survived) isn't trustworthy enough to ground a claim in —
    // this previously fell through to "unverifiable" whenever no card/abstract
    // was present, which the Corrector (corrector.ts:47) silently ignores
    // (only "unsupported" becomes an actionable fix). Force "unsupported" so
    // these citations actually get triaged/rewritten instead of shipping.
    const abstractSource = String((paper as any)?.abstract_source ?? "");
    if (UNVERIFIED_ABSTRACT_SOURCES.has(abstractSource)) {
      results.push({
        workId: claim.workId, section: claim.section, sentence: claim.sentence.slice(0, 200),
        verdict: "unsupported", reason: `Source abstract_source=${abstractSource} (quarantined/recalled) — not real retrieved text, claim cannot be grounded`,
      });
      continue;
    }
    const evidence = [
      paper?.card?.findingShort ? `finding: ${paper.card.findingShort}` : "",
      paper?.abstract ? `abstract: ${paper.abstract.slice(0, 500)}` : "",
      paper?.card?.effectSizeText ? `effect: ${paper.card.effectSizeText}` : "",
    ].filter(Boolean).join("\n");
    if (!evidence) {
      results.push({ workId: claim.workId, section: claim.section, sentence: claim.sentence.slice(0, 200), verdict: "unverifiable", reason: "No abstract or card" });
    } else {
      auditable.push({ claim, evidence });
    }
  }

  // System rubric — the verdict CRITERIA are IDENTICAL to the former per-claim
  // prompt (do not retune here). Only the I/O shape changed: many NUMBERED items
  // in, one JSON array of verdicts (keyed by item index) out. The per-item framing
  // + "judge each item only against its own evidence" keeps the model from letting
  // one item's evidence contaminate another's verdict.
  const auditSystem = [
    "You are a citation auditor for a JEL survey article.",
    "You are given a NUMBERED LIST of items. Each item has a CLAIM and the SOURCE",
    "PAPER evidence for the paper that claim cites. For EACH item independently,",
    "return whether the source clearly supports the specific claim made.",
    "",
    "Verdicts:",
    "  supported    — source clearly supports the specific claim",
    "  partial      — source is relevant but doesn't directly support this specific claim",
    "  unsupported  — source does NOT support the claim (misattribution or hallucination)",
    "  unverifiable — evidence too thin to judge",
    "",
    "Judge each item ONLY against its own evidence; never let one item's evidence",
    "influence another item's verdict.",
    "",
    "OUTPUT (JSON only): { \"verdicts\": [ { \"index\": <the item number>, \"verdict\": \"...\", \"reason\": \"one sentence\" } ] }",
    "Return exactly ONE entry per item, using that item's number as \"index\".",
  ].join("\n");

  // Batch of ≤8 keeps each prompt small enough to stay well within the token
  // budget while cutting the call count ~8×.
  const AUDIT_BATCH_SIZE = 8;
  const batches: Array<Array<{ claim: AuditClaim; evidence: string }>> = [];
  for (let i = 0; i < auditable.length; i += AUDIT_BATCH_SIZE) {
    batches.push(auditable.slice(i, i + AUDIT_BATCH_SIZE));
  }
  log(`claim auditor: ${auditable.length} auditable claim(s) → ${batches.length} batch(es) of ≤${AUDIT_BATCH_SIZE}`);

  async function auditBatch(batch: Array<{ claim: AuditClaim; evidence: string }>): Promise<any[]> {
    const user = [
      "ITEMS TO AUDIT (one verdict per item):",
      "",
      ...batch.map((b, i) => [
        `--- ITEM ${i + 1} ---`,
        `CLAIM: "${b.claim.sentence}"`,
        `CITED PAPER: ${b.claim.workId}`,
        "SOURCE PAPER EVIDENCE:",
        b.evidence,
        "",
      ].join("\n")),
    ].join("\n");

    // Budget scales with batch size: thinking tokens count against the cap, and a
    // truncated JSON envelope loses the WHOLE batch — so keep generous headroom.
    // (The old per-claim call used 1024 for one tiny verdict + thinking.)
    const maxTokens = Math.min(8192, 1024 + batch.length * 512);
    let parsed: any;
    try {
      parsed = await callQwen(auditSystem, user, maxTokens);
    } catch {
      parsed = await callGemini(auditSystem, user, maxTokens, true, "jel_claim_audit", GEMINI_JEL_QA_MODEL); // fallback if Qwen errors/hangs
    }

    // Accept {verdicts:[…]} (asked-for), {results:[…]}/{items:[…]}, the first
    // array-valued field, or a bare array — robust to model shape drift.
    const arr: any[] = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.verdicts) ? parsed.verdicts
      : Array.isArray(parsed?.results) ? parsed.results
      : Array.isArray(parsed?.items) ? parsed.items
      : ((Object.values(parsed ?? {}).find((v) => Array.isArray(v)) as any[]) ?? []);
    // Map back by the model-provided 1-based index; fall back to positional order.
    const byIndex = new Map<number, any>();
    arr.forEach((e, i) => {
      const idx = Number.isFinite(Number(e?.index)) ? Number(e.index) : i + 1;
      if (!byIndex.has(idx)) byIndex.set(idx, e);
    });

    return batch.map((b, i) => {
      const e = byIndex.get(i + 1);
      return {
        workId: b.claim.workId,
        section: b.claim.section,
        sentence: b.claim.sentence.slice(0, 200),
        verdict: e?.verdict ?? "unverifiable",
        reason: e?.reason ?? (e ? "" : "No verdict returned for this item"),
      };
    });
  }

  // Worker pool over BATCHES: workers share a cursor and loop until every batch is
  // consumed, capping in-flight LLM calls at exactly AUDIT_CONCURRENCY (shared-GPU
  // friendly). A failed batch (both Qwen AND Gemini threw) degrades its claims to
  // "unverifiable" — matching the old per-claim try/catch — and never crashes the job.
  const AUDIT_CONCURRENCY = 3; // keep shared-GPU load low; raise only if Qwen is idle
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= batches.length) break;
      const batch = batches[idx];
      try {
        for (const r of await auditBatch(batch)) results.push(r);
      } catch (err) {
        for (const b of batch) {
          results.push({ workId: b.claim.workId, section: b.claim.section, sentence: b.claim.sentence.slice(0, 200), verdict: "unverifiable", reason: `Audit batch failed: ${(err as Error).message}` });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AUDIT_CONCURRENCY, batches.length) }, () => worker()));

  const counts = { supported: 0, partial: 0, unsupported: 0, unverifiable: 0 };
  for (const r of results) counts[r.verdict as keyof typeof counts] = (counts[r.verdict as keyof typeof counts] || 0) + 1;
  log(`claim auditor done: ${JSON.stringify(counts)}`);

  return { summary: counts, total: results.length, claims: results };
}

// ---------------------------------------------------------------------------
// Verbatim-overlap detector (no LLM)
//
// For each cited paper, look for ≥10-word verbatim phrases shared between the
// paper's abstract and the section body. >= 1 long match = copy-paste flag.
// Cheap O(N·M) string-search; runs in milliseconds per section.
// ---------------------------------------------------------------------------

function detectVerbatimOverlap(
  sectionBody: string,
  citedPapers: Array<{ workId: string; title?: string; abstract?: string | null; card?: any }>,
): Array<{ workId: string; longestMatchWords: number; sample: string }> {
  const warnings: Array<{ workId: string; longestMatchWords: number; sample: string }> = [];
  const MIN_MATCH_WORDS = 10;
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const bodyNorm = norm(sectionBody);
  if (!bodyNorm) return warnings;

  for (const p of citedPapers) {
    const source = p.abstract ?? p.card?.findingShort ?? "";
    if (!source || source.length < 60) continue;
    const sourceWords = norm(source).split(" ").filter(Boolean);
    if (sourceWords.length < MIN_MATCH_WORDS) continue;

    // Slide MIN_MATCH_WORDS-grams across the source; check each against bodyNorm.
    // Track the longest run of consecutive matching n-grams (which approximates
    // the longest verbatim phrase, in word count).
    let longestRun = 0;
    let currentRun = 0;
    let bestStart = -1;
    let currentStart = -1;
    for (let i = 0; i + MIN_MATCH_WORDS <= sourceWords.length; i++) {
      const ngram = sourceWords.slice(i, i + MIN_MATCH_WORDS).join(" ");
      if (bodyNorm.includes(ngram)) {
        if (currentRun === 0) currentStart = i;
        currentRun++;
        if (currentRun > longestRun) {
          longestRun = currentRun;
          bestStart = currentStart;
        }
      } else {
        currentRun = 0;
      }
    }
    if (longestRun > 0) {
      const phraseLen = MIN_MATCH_WORDS + longestRun - 1; // n-gram chain length in words
      warnings.push({
        workId: p.workId,
        longestMatchWords: phraseLen,
        sample: sourceWords.slice(bestStart, bestStart + Math.min(phraseLen, 30)).join(" "),
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Tier 1 — global quality metrics (no LLM)
//
// Computed once after all sections drafted. Captures cross-section concentration
// (which the per-section 2× cap can't see), corpus coverage, and single-paper
// section anchoring.
// ---------------------------------------------------------------------------

function computeQualityReport(
  draftedSections: Array<{ number: string | number; heading: string; body: string; citedWorkIds: string[] }>,
  coding: { papers: any[] },
): {
  corpusSize: number;
  distinctCited: number;
  coveragePct: number;
  coverageWarning: boolean;
  coreScoped: boolean;
  coreSize: number;
  coreCovered: number;
  coreCoveragePct: number;
  perChannelCore: Record<string, { core: number; cited: number }>;
  underrepresentedChannels: Array<{ channel: string; cited: number; target: number }>;
  globalCitationCounts: Array<{ workId: string; count: number }>;
  overusedGlobal: Array<{ workId: string; count: number; threshold: number }>;
  singlePaperSections: Array<{ section: string; dominantWorkId: string; share: number }>;
} {
  const corpusSize = coding.papers.length;
  const counts = new Map<string, number>();
  const sectionShares: Array<{ section: string; dominantWorkId: string; share: number }> = [];

  for (const s of draftedSections) {
    // Count total occurrences (not distinct) of each [workId] in the body —
    // this catches multi-cited papers within a section.
    const occ = new Map<string, number>();
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    let total = 0;
    while ((m = re.exec(s.body ?? "")) !== null) {
      const id = m[1].trim();
      occ.set(id, (occ.get(id) || 0) + 1);
      total++;
    }
    // Add occurrence counts to global tally
    for (const [id, n] of occ) counts.set(id, (counts.get(id) || 0) + n);
    // Section-level dominance
    if (total > 0) {
      const [topId, topN] = [...occ.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = topN / total;
      if (share >= 0.4) {
        sectionShares.push({ section: `§${s.number}`, dominantWorkId: topId, share: Number(share.toFixed(2)) });
      }
    }
  }

  const globalCitationCounts = [...counts.entries()]
    .map(([workId, count]) => ({ workId, count }))
    .sort((a, b) => b.count - a.count);
  // Threshold: a paper cited more than corpusSize/5 times across the whole
  // paper is dominating the narrative (with 50 corpus papers → >10 mentions).
  const threshold = Math.max(Math.ceil(corpusSize / 5), 6);
  const overusedGlobal = globalCitationCounts
    .filter((x) => x.count > threshold)
    .map((x) => ({ ...x, threshold }));

  const distinctCited = counts.size;
  const coveragePct = corpusSize > 0 ? Number(((distinctCited / corpusSize) * 100).toFixed(1)) : 0;

  // CORE-scoped coverage ("cite what matters"): coverage is measured over the
  // papers that MATTER, not the whole retrieved set. Per-channel coverage + the
  // soft ≥CORE_CHANNEL_MIN-per-active-channel mix check. Only when CORE tiers exist.
  const citedSet = new Set(counts.keys());
  const corePapers = coding.papers.filter((p: any) => p._core === true);
  const coreScoped = corePapers.length > 0;
  let coreSize = 0, coreCovered = 0, coreCoveragePct = 0;
  const perChannelCore: Record<string, { core: number; cited: number }> = {};
  const underrepresentedChannels: Array<{ channel: string; cited: number; target: number }> = [];
  if (coreScoped) {
    coreSize = corePapers.length;
    coreCovered = corePapers.filter((p: any) => citedSet.has(p.workId)).length;
    coreCoveragePct = Number(((coreCovered / coreSize) * 100).toFixed(1));
    for (const ch of CHANNEL_IDS) {
      const inCh = corePapers.filter((p: any) => (p._channels ?? []).includes(ch));
      if (inCh.length === 0) continue;
      const citedCh = inCh.filter((p: any) => citedSet.has(p.workId)).length;
      perChannelCore[ch] = { core: inCh.length, cited: citedCh };
      const target = Math.min(inCh.length, CORE_CHANNEL_MIN);
      if (citedCh < target) underrepresentedChannels.push({ channel: ch, cited: citedCh, target });
    }
  }

  return {
    corpusSize,
    distinctCited,
    coveragePct,
    // Warning is CORE-scoped when tiers exist (we WANT high coverage of what
    // matters); falls back to the old whole-corpus <40% rule otherwise.
    coverageWarning: coreScoped ? coreCoveragePct < 60 : coveragePct < 40,
    coreScoped,
    coreSize,
    coreCovered,
    coreCoveragePct,
    perChannelCore,
    underrepresentedChannels,
    globalCitationCounts: globalCitationCounts.slice(0, 30),
    overusedGlobal,
    singlePaperSections: sectionShares,
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — final review pass (one Gemini call)
//
// Last-chance reviewer that sees the full paper structure + evidence corpus,
// flags claims that look unsupported, themes that don't belong, and corpus
// papers entirely missing from the discussion.
// ---------------------------------------------------------------------------

async function runFinalReviewPass(
  outline: any,
  draftedSections: Array<{ number: string | number; heading: string; body: string; citedWorkIds: string[] }>,
  coding: { papers: any[] },
): Promise<any> {
  const sectionPreviews = draftedSections.map((s) =>
    `§${s.number} "${s.heading}" (${s.body.split(/\s+/).length} words, ${s.citedWorkIds.length} cites):\n  ${s.body.split(/\s+/).slice(0, 250).join(" ")}…`
  );
  const allCited = new Set(draftedSections.flatMap((s) => s.citedWorkIds));
  // Selectivity reconciliation: when CORE tiers exist, only an uncited CORE paper
  // is a real gap — omitting [supporting]/[peripheral] papers is intentional, so
  // the reviewer must NOT flag those as missing coverage.
  const coreScoped = coding.papers.some((p: any) => typeof p._core === "boolean");
  const uncited = coding.papers
    .filter((p) => !allCited.has(p.workId) && (!coreScoped || (p as any)._core === true))
    .slice(0, 25)
    .map((p) => `[${p.workId}] "${p.title}" (${p.year ?? "n.d."}, ${normalizeDesign(p.card?.design ?? p.methodologyDesign)})`);

  const system = [
    "You are the Final Reviewer for a JEL survey article before publication.",
    "You see the article's structure, every section preview, and the evidence corpus.",
    "Identify problems that earlier passes (coherence, citation, claim auditor) may have missed.",
    "",
    "Focus on three categories:",
    "  unsupportedClaims  — claims that read like fabrications or misattributions, given the corpus",
    "  offTopicThemes     — themes (named topics) in the article that are NOT represented by the evidence corpus",
    "  corpusGaps         — corpus papers that should have been cited but were not, given their relevance to the article",
    "",
    "OUTPUT (JSON only, no markdown fences):",
    '{ "overallVerdict": "publishable" | "needs_revision" | "major_issues",',
    '  "summary": "2-sentence overall assessment",',
    '  "unsupportedClaims": [ { "section": "§3", "claim": "verbatim sentence", "reason": "..." } ],',
    '  "offTopicThemes": [ { "theme": "...", "section": "§N", "reason": "..." } ],',
    '  "corpusGaps": [ { "workId": "...", "reason": "why this should have been cited" } ] }',
  ].join("\n");

  const user = [
    `ARTICLE TITLE: ${outline.title}`,
    `ABSTRACT: ${(outline.abstract ?? "").slice(0, 600)}`,
    "",
    `EVIDENCE CORPUS (${coding.papers.length} papers, ${allCited.size} cited, ${coding.papers.length - allCited.size} uncited):`,
    uncited.length > 0 ? `UNCITED PAPERS (top ${uncited.length}):\n${uncited.join("\n")}` : "(all evidence cited)",
    "",
    "SECTION PREVIEWS:",
    sectionPreviews.join("\n\n"),
    "",
    "Review the article now.",
  ].join("\n");

  return await callGemini(system, user, 8192, true, "jel_final_review", GEMINI_JEL_QA_MODEL);
}

// ---------------------------------------------------------------------------
// Main job runner — called fire-and-forget from the API handler
// ---------------------------------------------------------------------------

export async function runJelPaperJob(
  jobId: string,
  searchRunId: string,
  tenantId: string,
  client: any,  // supabase admin client
  plan?: {
    workingQuestion?: string;
    scope?: { include?: string[]; exclude?: string[] };
    curatedWorkIds?: string[];
    removedWorkIds?: string[];
    emphasis?: { themes?: string[]; spotlightDebate?: string; audience?: string; targetWords?: number };
    outlinePreview?: { title?: string; sections?: any[] } | null;
    clarifyAnswers?: { question: string; answer: string }[];
    generateMode?: "deep" | "standard";
    autoExpand?: boolean;
  } | null,
  briefIdOverride?: string | null,
): Promise<void> {
  const log = (msg: string) => console.log(`[jel-paper:${jobId}] ${msg}`);
  let currentStep = "init";
  const jobStartedAt = Date.now();

  // Per-paper LLM cost accumulation. enterWith binds this context to the job's
  // async execution; callGemini/callQwen read it via jelUsageStore.getStore().
  // Fire-and-forget per job → isolated from concurrent papers in the process.
  const usageCtx: JelUsageCtx = {
    paperId: jobId, tenantId,
    geminiIn: 0, geminiOut: 0, geminiCalls: 0, geminiUsd: 0,
    qwenIn: 0, qwenOut: 0, qwenCalls: 0,
  };
  jelUsageStore.enterWith(usageCtx);

  // Resolve the owner's BYOK provider (Gemini/Claude) for this job; null => app default.
  let providerCfg = null;
  try {
    providerCfg = await resolveProviderConfig(client, tenantId);
  } catch (e) {
    // NEVER rethrow: this runs as a detached fire-and-forget job, so an escaped
    // rejection is an unhandled promise rejection that can terminate the whole
    // Deno process — killing every concurrent user's stream and paper job.
    // Mark the row and stop instead.
    const msg = e instanceof ProviderCallError
      // Granted owner but their key is gone → hard error this paper, do NOT degrade.
      ? "Your team's synthesis key is unavailable — contact your admin."
      : `Generation failed before start: ${e instanceof Error ? e.message : String(e)}`;
    try {
      await client.from("jel_papers").update({
        status: "error",
        error_message: msg,
      }).eq("id", jobId);
    } catch (dbErr) {
      console.error(`[jel-paper:${jobId}] failed to mark pre-start error:`, dbErr);
    }
    return;
  }
  synthCtxStore.enterWith({ providerCfg, tenantId });

  // Telemetry: async generation emits a started → completed/failed PAIR so
  // duration + abandonment + failure reason are captured. Best-effort.
  logUsageEvent({
    tenantId, eventType: "paper.generation_started",
    targetType: "paper", targetId: jobId, status: "started",
    payload: { searchRunId, fromPlan: !!plan },
  });

  try {
    // 1. Mark running
    currentStep = "mark_running";
    await client
      .from("jel_papers")
      .update({ status: "running" })
      .eq("id", jobId);

    log("status → running");

    // 2. Fetch search run
    currentStep = "fetch_search_run";
    const { data: run, error: runErr } = await client
      .from("search_runs")
      .select("id, query, intent, filters, evidence_work_ids, candidate_work_ids, work_channels")
      .eq("id", searchRunId)
      .single();

    if (runErr || !run) throw new Error(`search_run fetch failed: ${runErr?.message}`);
    log(`query: ${run.query}`);

    // Evidence: a curated plan overrides the run's raw evidence set.
    let evidenceIds: string[];
    if (plan && Array.isArray(plan.curatedWorkIds) && plan.curatedWorkIds.length > 0) {
      const removed = new Set(plan.removedWorkIds ?? []);
      evidenceIds = plan.curatedWorkIds.filter((id) => !removed.has(id));
      log(`using curated plan evidence: ${evidenceIds.length} works (${plan.removedWorkIds?.length ?? 0} removed)`);
    } else {
      evidenceIds = run.evidence_work_ids ?? [];
    }
    if (evidenceIds.length === 0) throw new Error("No evidence works — curate at least one paper in the plan, or run a search with evidence");

    // Include previously-persisted planner additions (plan.discoveredWorkIds):
    // a retried generation skips auto-expand (alreadyExpanded guard below), so
    // without this union a retry would draft WITHOUT the discovered papers the
    // first run cited. No-op for Generate Now plans (client already merged them
    // into curatedWorkIds).
    if (plan && Array.isArray((plan as any).discoveredWorkIds)) {
      const removedD = new Set(plan.removedWorkIds ?? []);
      for (const id of (plan as any).discoveredWorkIds as string[]) {
        if (!removedD.has(id) && !evidenceIds.includes(id)) evidenceIds.push(id);
      }
    }

    const northStar = (plan?.workingQuestion && plan.workingQuestion.trim()) || run.query;
    const deepMode = plan?.generateMode === "deep";

    // Auto-expand: creative planner adds grounded papers to evidenceIds BEFORE
    // the works fetch so the added ids are included in allWorks → coding →
    // validIds → worksMap (bibliography). Soft-fail — never throws.
    // Always-on (2026-06-26): expand on EVERY generation, not just Generate Now.
    // Guard against double-expand — skip when the gate already ran it (the plan
    // already carries discovered ids). Falls back to the legacy plan.autoExpand
    // flag when ENRICH_ALWAYS_EXPAND is off.
    const alreadyExpanded = ((plan as any)?.discoveredWorkIds?.length ?? 0) > 0;
    if (plan?.autoExpand || (ENRICH_ALWAYS_EXPAND && !alreadyExpanded)) {
      currentStep = "auto_expand";
      // TIME BUDGET (2026-06-14): auto-expand (creative-planner LLM + grounding
      // probes) is an ADDITIVE nicety, not required for the paper. It must NEVER
      // block the outline indefinitely — a slow planner/grounding once stalled a
      // paper ~15 min on "Planning…" before a deploy killed it. Race the whole
      // expand against a hard budget; on timeout proceed with base evidence. The
      // expand returns the ids to ADD (it does not mutate evidenceIds directly),
      // so a late-resolving background promise can't corrupt the works fetch.
      const AUTOEXPAND_BUDGET_MS = 90_000;
      const plannerKind = deepMode ? "gemini" : "qwen";
      const expand = (async (): Promise<string[]> => {
        try {
          const { planQuery, groundPlan, selectAdds, rescoreByTrueQueryCosine, PLANNER_REL_THRESHOLD } = await import("./creativePlanner.ts");
          const baseIds = [...evidenceIds];
          const { data: titleRows } = await client
            .from("works")
            .select("id, title")
            .in("id", baseIds);
          const anchorTitles = (titleRows ?? [])
            .map((r: any) => r.title)
            .filter((t: any): t is string => !!t);
          const cp = await planQuery(northStar, plannerKind, anchorTitles, tenantId);
          const { candidates } = await groundPlan(cp);
          // Gate on TRUE query·paper cosine, not probe similarity (precision fix 2026-06-16).
          const rescored = await rescoreByTrueQueryCosine(candidates, northStar, client);
          const { added } = selectAdds(rescored, new Set(baseIds), ENRICH_NET_ADD_CAP, PLANNER_REL_THRESHOLD);
          return added.map((c) => c.id).filter((id) => !evidenceIds.includes(id));
        } catch (e) {
          log(`[auto-expand] failed, using base evidence: ${(e as Error).message}`);
          return [];
        }
      })();
      const addedIds = await Promise.race([
        expand,
        new Promise<null>((res) => setTimeout(() => res(null), AUTOEXPAND_BUDGET_MS)),
      ]);
      if (addedIds === null) {
        log(`[auto-expand] budget ${AUTOEXPAND_BUDGET_MS}ms exceeded — proceeding with base evidence`);
      } else {
        for (const id of addedIds) if (!evidenceIds.includes(id)) evidenceIds.push(id);
        log(`[auto-expand] +${addedIds.length} grounded papers (planner=${plannerKind})`);
        // Persist the adds as plan.discoveredWorkIds on the paper row. Revision
        // rebuilds its evidence set from the stored plan/run ONLY, so
        // unpersisted expansion papers vanished from validIds + the
        // bibliography on the first revise — stripping their citations from
        // revised sections and leaving dangling [workId] tokens in unrevised
        // prose. Persisting also marks the plan as already-expanded, so a
        // retried generation won't double-expand.
        if (addedIds.length > 0) {
          try {
            // deno-lint-ignore no-explicit-any
            const planForRow: any = plan ?? {};
            const prevDiscovered: string[] = Array.isArray(planForRow.discoveredWorkIds) ? planForRow.discoveredWorkIds : [];
            planForRow.discoveredWorkIds = [...new Set([...prevDiscovered, ...addedIds])];
            await client.from("jel_papers").update({ plan: planForRow }).eq("id", jobId);
          } catch (e) {
            log(`[auto-expand] persist of discoveredWorkIds skipped: ${(e as Error).message}`);
          }
        }
      }
    }

    // 3. Fetch works
    currentStep = "fetch_works";
    const BATCH = 80;
    const allWorks: any[] = [];
    const coreSelect = DOSSIER_ENRICH
      ? "id, title, authors, year, sms_level, methodology_design, geography, abstract, canonical_doi, citation_count, venue, source, abstract_source:raw_data->>abstract_source, embedding"
      : "id, title, authors, year, sms_level, methodology_design, geography, abstract, canonical_doi, citation_count, venue, source, abstract_source:raw_data->>abstract_source";
    for (let i = 0; i < evidenceIds.length; i += BATCH) {
      const { data } = await client
        .from("works")
        .select(coreSelect)
        .in("id", evidenceIds.slice(i, i + BATCH));
      if (data) allWorks.push(...data);
    }
    log(`fetched ${allWorks.length} works`);

    // 4. Fetch evidence cards
    currentStep = "fetch_evidence_cards";
    const { data: cardRows } = await client
      .from("evidence_cards")
      .select("work_id, study_design, intervention, outcome, effect_direction, effect_size_text, sample_size, sample_size_text, country, identification_strategy, limitations, mechanism, heterogeneity, external_validity_note, finding_short")
      .in("work_id", evidenceIds);

    const cardsById: Record<string, any> = {};
    for (const c of (cardRows ?? [])) cardsById[c.work_id] = c;
    log(`fetched ${Object.keys(cardsById).length} evidence cards`);

    // 5. Build coding sheet
    const coding = buildCodingSheet(allWorks, cardsById, evidenceIds);

    mergeUploadsIntoCoding(coding, plan as any, evidenceIds);
    if ((plan as any)?.uploads?.length) log(`merged ${(plan as any).uploads.length} uploaded papers into evidence`);
    log(`coding sheet: ${coding.total} papers`);

    // Evidence Dossier enrichment (flag-gated). Attach prebuilt full-text briefs
    // + uncited context notes to each coding paper. Prompt-input only.
    if (DOSSIER_ENRICH) {
      // CORE tiering FIRST ("cite what matters": relevance top-N% × channel
      // credibility) — so on-demand enrichment targets ONLY the papers that matter.
      const embById = new Map<string, number[]>();
      for (const w of allWorks) { const v = coreParseVec(w.embedding); if (v) embById.set(w.id, v); }
      try {
        await assignCoreTiers(coding, northStar, embById);
        const coreCount = coding.papers.filter((p: any) => p._core).length;
        const chN = (ch: string) => coding.papers.filter((p: any) => p._core && p._channels.includes(ch)).length;
        log(`CORE tiering: ${coreCount}/${coding.total} core (causal ${chN("causal")}, foundational ${chN("foundational")}, recent ${chN("recent")}, lac ${chN("lac")})`);
      } catch (e) {
        log(`CORE tiering failed: ${(e as Error).message} — sections fall back to design-based tiers`);
      }

      // Read the dossier cache (worker-built oa_pdf/web briefs, provenance-tagged).
      const wd = await getDossiers(client, coding.papers.map((p: any) => ({ id: p.workId, title: p.title, authors: p.authors, year: p.year, abstract: p.abstract })));

      // On-demand web enrichment (HYBRID, bounded — 2026-06-26): for CORE papers
      // with no usable cached dossier, fetch a verified-web magnitude brief now,
      // capped (CORE_ENRICH_CAP) + per-fetch timeout + overall budget, and cache it.
      // Web-only (pdf-parse is Node-only → PDF dossiers stay with the offline
      // worker). Soft-fail — never blocks the outline.
      let fetched = 0, fetchFail = 0;
      if (CORE_ENRICH_CAP > 0) {
        const needs = coding.papers
          .filter((p: any) => p._core)
          .filter((p: any) => { const d = wd.get(p.workId); return !(d && d.status === "ok" && d.fullText); })
          .slice(0, CORE_ENRICH_CAP);
        if (needs.length > 0) {
          currentStep = "dossier_enrich";
          try {
            const { buildWebDossier } = await import("./dossierBuilder.ts");
            const deadline = Date.now() + DOSSIER_ENRICH_BUDGET_MS;
            const q = [...needs];
            const worker = async () => {
              while (q.length && Date.now() < deadline) {
                const p = q.shift(); if (!p) break;
                const fresh = await buildWebDossier(
                  client,
                  { id: p.workId, title: p.title, authors: p.authors, year: p.year, abstract: p.abstract },
                  DOSSIER_FETCH_TIMEOUT_MS,
                );
                if (fresh && fresh.status === "ok" && fresh.fullText) { wd.set(p.workId, fresh); fetched++; }
                else { fetchFail++; }
              }
            };
            // Concurrency 2; overall budget is a hard backstop (the deadline above
            // stops pulling new work, this guarantees we proceed even if a call hangs).
            await Promise.race([
              Promise.all([worker(), worker()]),
              new Promise<void>((res) => setTimeout(res, DOSSIER_ENRICH_BUDGET_MS)),
            ]);
          } catch (e) {
            log(`on-demand dossier build failed: ${(e as Error).message} — proceeding with cached evidence`);
          }
          log(`on-demand dossier: ${fetched}/${needs.length} core papers enriched (web), ${fetchFail} no-result`);
        }
      }

      // Attach briefs/context notes (incl. any freshly-built web dossiers).
      const jsonCache = loadDossierCache();
      let withFt = 0, withNote = 0, oa = 0, web = 0;
      for (const p of coding.papers) {
        const d = wd.get(p.workId);
        const j = jsonCache[p.workId];
        const hasFt = !!(d && d.status === "ok" && d.fullText);
        const fulltext_md = hasFt ? d!.fullText : j?.fulltext_md;
        const fulltext_source = hasFt ? d!.source : j?.fulltext_source;
        const context_note = j?.context_note;
        if (fulltext_md || context_note) (p as any).dossier = { fulltext_md, fulltext_source, context_note };
        if (fulltext_md) { withFt++; if (fulltext_source === "web") web++; else oa++; }
        if (context_note) withNote++;
      }
      log(`dossier enrich ON: ${withFt} full-text briefs (${oa} oa, ${web} web) + ${withNote} context notes attached (of ${coding.total})`);
    }

    // Evidence provenance (ADDITIVE): record which retrieval channels surfaced
    // this paper's evidence set + the key search filters, for display in the
    // paper's "Evidence provenance" panel. Stored under outline.retrievalMetadata
    // (lowest-risk path — no new jel_papers columns; mapJelPaper returns outline).
    // The channel union is restricted to the actual evidence works of THIS paper.
    const channelCounts: Record<string, number> = {};
    const runChannels: Record<string, string[]> = (run.work_channels ?? {}) as Record<string, string[]>;
    for (const wid of evidenceIds) {
      const chans = runChannels[wid];
      if (Array.isArray(chans)) {
        for (const c of chans) channelCounts[c] = (channelCounts[c] ?? 0) + 1;
      }
    }
    let channelsUsed = Object.keys(channelCounts).sort((a, b) => channelCounts[b] - channelCounts[a]);
    if (channelsUsed.length === 0) {
      // Fallback: the curated evidence set may not overlap the run's per-paper
      // channel tags (e.g. work_channels only tagged a few papers, or a re-curated
      // plan). Show the union of channels that surfaced ANY paper in the run rather
      // than collapsing to "General corpus retrieval".
      const union = new Set<string>();
      for (const chans of Object.values(runChannels)) if (Array.isArray(chans)) chans.forEach((c) => union.add(c));
      channelsUsed = [...union];
    }
    const runFilters = (run.filters ?? {}) as Record<string, any>;
    const retrievalMetadata = {
      channels: channelsUsed,            // ["causal","lac",...] most-frequent first
      channelCounts,                     // channel id -> # evidence papers surfaced by it
      evidenceCount: evidenceIds.length,
      searchRunId,
      query: run.query ?? null,
      filters: {
        // NB: field names MUST match the real SearchFilters shape (types.ts / the
        // run.filters jsonb). The old code read sourceIds/tiers (which don't exist)
        // and omitted evidenceMatch, so the panel showed nothing.
        regions: runFilters.regions ?? null,
        timePeriod: runFilters.timePeriod ?? null,
        startDate: runFilters.startDate ?? null,
        endDate: runFilters.endDate ?? null,
        evidenceMatch: runFilters.evidenceMatch ?? null,        // 'direct' | 'both' | 'all'
        journalTiers: runFilters.journalTiers ?? null,
        workingPaperSources: runFilters.workingPaperSources ?? null,
        institutionalSources: runFilters.institutionalSources ?? null,
        publicationTypes: runFilters.publicationTypes ?? null,
        topics: runFilters.topics ?? null,
        methodology: runFilters.methodology ?? null,
      },
    };
    log(`evidence provenance: channels=[${channelsUsed.join(",") || "none"}] over ${evidenceIds.length} works`);

    // 6. Generate outline — retry Gemini once, then fall back to Qwen
    //
    // The outline anchors the whole paper, so it must be grounded in the
    // actual evidence corpus + any already-produced synthesis. We deliberately
    // do NOT pass retrieval filters (topics/regions) here — those are upstream
    // metadata that historically caused topic drift in the title (e.g. AI
    // injected into a student-learning paper when topics=["AI","Labor"]
    // lingered from a prior search).
    currentStep = "generate_outline";

    // Pull the brief synthesis if this job is linked to one. Best-effort —
    // if the row was inserted without brief_id (older jobs), or the fetch
    // fails, we proceed with evidence-only grounding.
    let briefSynthesis: any = null;
    try {
      const { data: jobRow } = await client
        .from("jel_papers")
        .select("brief_id")
        .eq("id", jobId)
        .single();
      const briefId = briefIdOverride ?? jobRow?.brief_id;
      if (briefId) {
        const { data: briefRow } = await client
          .from("briefs")
          .select("sections")
          .eq("id", briefId)
          .single();
        if (briefRow?.sections) {
          briefSynthesis = briefRow.sections;
          log(`loaded synthesis from brief ${briefId}`);
        }
      }
    } catch (err) {
      log(`brief synthesis fetch skipped: ${(err as Error).message}`);
    }

    // Build clarify answers block — appended to outline + section prompts so the
    // user's scoping answers actually shape the paper (not just scope.include chips).
    const clarifyBlock = (plan?.clarifyAnswers ?? []).length
      ? "\nUser scoping answers (honor these):\n" +
        (plan!.clarifyAnswers!).map((a) => `- ${a.question} → ${a.answer}`).join("\n")
      : "";

    const { system: oSys, user: oUserBase } = buildOutlinePrompt(
      northStar,
      briefSynthesis,
      coding.papers,
      plan ? { scope: plan.scope, emphasis: plan.emphasis } : null,
      plan?.outlinePreview && Array.isArray(plan.outlinePreview.sections) && plan.outlinePreview.sections.length > 0
        ? { title: plan.outlinePreview.title, sections: plan.outlinePreview.sections }
        : null,
      plan?.emphasis?.targetWords,
    );
    const oUser = clarifyBlock ? `${oUserBase}${clarifyBlock}` : oUserBase;

    const enrichMode = !!(plan?.outlinePreview && Array.isArray(plan.outlinePreview.sections) && plan.outlinePreview.sections.length > 0);
    // Enrich mode pins heading/order/scope/title deterministically below — the
    // LLM contributes ONLY targetWords/expectedDesigns/abstract, so paying the
    // Pro drafter (and its undisablable thinking) for an outline whose
    // structure is discarded was pure waste (~$0.05-0.08/paper). Route it to
    // the QA model (flash). Non-enrich outlines keep the drafter model: their
    // structure IS the LLM's output.
    const outlineModel = enrichMode ? GEMINI_JEL_QA_MODEL : undefined;
    log(`generating outline... (${coding.papers.length} evidence papers grounded${clarifyBlock ? ", clarify answers injected" : ""}${enrichMode ? ", enrich mode → QA model" : ""})`);

    let outline: any;
    try {
      outline = await callGeminiDraft(oSys, oUser, 8192, true, "jel_gemini", outlineModel);
    } catch (err) {
      log(`outline Gemini failed after ${GEMINI_DRAFT_ATTEMPTS} attempts (${(err as Error).message}) — falling back to Qwen`);
      outline = await callQwen(oSys, oUser, 6000);
    }

    // Enrich mode = the user CONFIRMED this structure in Paper Studio. The outline
    // LLM is asked ONLY to add targetWords/expectedDesigns/abstract and to echo the
    // confirmed sections verbatim — but it can't be trusted to comply. Observed
    // 2026-07-09: Gemini rewrote every confirmed heading (e.g. "Introduction" →
    // "Introduction — Overview of the challenge and objectives"), so the drafted
    // paper's TOC no longer matched what the user approved. Fix: deterministically
    // PIN number/heading/order/scope (and title) from the confirmed outline, keeping
    // only the LLM's enrichment fields (matched by section number). This guarantees
    // the paper's structure is byte-identical to the confirmed outline — no LLM
    // compliance assumed. Robust even if the LLM returned a short/malformed list.
    if (enrichMode) {
      const confirmed = plan!.outlinePreview!.sections as any[];
      const llmSections: any[] = Array.isArray(outline?.sections) ? outline.sections : [];
      const llmByNum = new Map(llmSections.map((s: any) => [String(s.number), s]));
      if (!outline || typeof outline !== "object") outline = {};
      outline.sections = confirmed.map((cs: any, i: number) => {
        const m = llmByNum.get(String(cs.number)) ?? llmSections[i] ?? {};
        return {
          number: cs.number,
          heading: cs.heading,
          scope: cs.scope ?? m.scope ?? "",
          targetWords: m.targetWords,
          expectedDesigns: m.expectedDesigns,
        };
      });
      if (plan!.outlinePreview!.title) outline.title = plan!.outlinePreview!.title;
      log(`enrich mode: pinned ${outline.sections.length} confirmed sections verbatim (headings/order/title locked to user's outline)`);
    }

    if (!outline?.sections || outline.sections.length < 3) {
      throw new Error(`Outline invalid (${outline?.sections?.length ?? 0} sections returned, need ≥3): ${JSON.stringify(outline).slice(0, 300)}`);
    }
    // Hard cap at 7 sections for LLM-authored (non-enrich) outlines only — bounds
    // runtime (13-15 sections → 30-45 min → risks a Deno mid-run restart). In enrich
    // mode the count is the user's confirmed count and is NEVER silently truncated.
    if (!enrichMode && outline.sections.length > 7) {
      log(`outline at ${outline.sections.length} sections — capping to 7`);
      outline.sections = outline.sections.slice(0, 7);
    }
    log(`outline: ${outline.sections.length} sections, title: "${outline.title}"`);
    const evidenceGaps: string[] = Array.isArray(outline.evidenceGaps)
      ? outline.evidenceGaps.filter((g: unknown) => typeof g === "string" && g.trim())
      : [];
    if (evidenceGaps.length > 0) {
      log(`outline flagged ${evidenceGaps.length} evidence gap(s) — part of the research question is not addressed: ${evidenceGaps.join(" | ")}`);
    }

    // Attach evidence provenance to the outline (additive — does not affect
    // section drafting; consumed only by the JelPaperView provenance panel).
    outline.retrievalMetadata = retrievalMetadata;

    // Persist outline immediately
    await client
      .from("jel_papers")
      .update({ outline, query: northStar })
      .eq("id", jobId);

    // 7. Load voice anchor
    const exemplar = await loadVoiceAnchor();
    log(`voice anchor: ${exemplar.title}`);

    // 8. Draft sections — hybrid parallel/sequential strategy:
    //
    //   Phase A (parallel, Qwen): "descriptive" sections (intro, background,
    //     stylized facts, data overview). These are structurally independent —
    //     they cite papers but don't build on each other's analytical arguments.
    //     Qwen handles citation grounding well for these; running them in parallel
    //     saves Gemini quota and cuts wall-clock time.
    //
    //   Phase B (sequential, Gemini): analytical sections (theory, empirical
    //     evidence, mechanisms, heterogeneity, research agenda). Each section
    //     receives the first 400 words of every previously drafted section so it
    //     can build on prior arguments, avoid repeating citations, and maintain a
    //     coherent narrative arc.
    //
    //   Bibliography: programmatic (no LLM call).

    const validIds = new Set(evidenceIds);
    let draftedSections: any[] = [];
    let totalWords = 0;
    const allCited = new Set<string>();

    // Helper: finalize a raw draft into a section record.
    // Attaches overlap warnings (verbatim copy detection — no LLM) so we can
    // flag plagiarism at finalize time.
    // stripLeadingHeadingEcho is at module scope (exported) — used here + by Corrector.
    function finalizeSection(section: any, draft: any): any {
      const rawBody: string = typeof draft === "string"
        ? draft
        : (draft?.body ?? draft?.text ?? draft?.content ?? draft?.prose ?? "");
      const headingForStrip: string = draft?.heading ?? section.heading ?? "";
      const fencedBody = fenceBodyToEvidence(
        normalizeCitations(
          stripSectionApparatus(stripLeadingHeadingEcho(stripSectionMarkdown(rawBody), headingForStrip)),
          coding.papers,
        ),
        validIds,
      );
      // Citation-name integrity (2026-07-15): rewrite hallucinated author names
      // from works.authors and repair/strip bracketless phantom citations.
      const integrity = enforceCitationIntegrity(fencedBody, coding.papers);
      const normalizedBody = integrity.body;
      if (integrity.stats.renamed || integrity.stats.linked || integrity.stats.removed || integrity.stats.unresolved) {
        log(`§${section.number} citation integrity: ${JSON.stringify(integrity.stats)}`);
      }
      const wc = wordCount(normalizedBody);
      const cited = extractCitedIds(normalizedBody, validIds);
      cited.forEach((id) => allCited.add(id));
      // Strip any §N / §N — / Section N prefix the model may have included
      const rawHeading: string = draft?.heading ?? section.heading ?? "";
      const cleanHeading = rawHeading
        .replace(/^§[\d.]+\s*[—–-]?\s*/u, "")
        .replace(/^Section\s+[\d.]+\s*[—–-]?\s*/i, "")
        .trim() || section.heading;
      // Verbatim-overlap check against each cited paper's abstract.
      const citedPapers = cited
        .map((id) => coding.papers.find((p) => p.workId === id))
        .filter(Boolean) as any[];
      const overlapWarnings = detectVerbatimOverlap(normalizedBody, citedPapers);
      return {
        number: section.number,
        heading: cleanHeading,
        body: normalizedBody,
        citedWorkIds: cited,
        wordCount: wc,
        overlapWarnings,
      };
    }

    // Helper: build prior-section context for sequential analytical sections.
    // Passes heading + first 200 words of body so each section can learn from
    // what was already argued without ballooning the context window. 200 (was
    // 400, trimmed 2026-07-13): the previews live in the UNCACHEABLE per-call
    // suffix and grow with each section (§7 carried ~3.3k tokens); the
    // anti-repetition signal is mostly carried by the separate
    // already-cited-workIds block, so half the preview keeps the function at
    // half the cost + less for Pro to think about.
    function buildPrior(): any[] {
      return draftedSections.map((s) => ({
        number: s.number,
        heading: s.heading,
        wordCount: s.wordCount,
        bodyPreview: s.body.split(/\s+/).slice(0, 200).join(" "),
      }));
    }

    // ONE canonical evidence ranking shared by every section (2026-07-06).
    // Previously each section re-ranked the corpus by its own expectedDesigns,
    // so the (large) evidence block differed byte-for-byte between section
    // calls and no prompt-cache prefix could ever hit. The ranking only ever
    // mattered as truncation insurance; per-section design targeting is
    // enforced by the DESIGN CHANNEL RULE in the section brief, not by order.
    const corpusEvidence = pickEvidenceForSection(coding, {});

    const descriptiveSections = outline.sections.filter(isDescriptiveSection);
    const analyticalSections  = outline.sections.filter((s: any) => !isDescriptiveSection(s));

    log(`section split: ${descriptiveSections.length} descriptive (${deepMode ? "Gemini" : "Qwen"} parallel) + ${analyticalSections.length} analytical (Gemini sequential)`);

    // Sections that SHOULD have been Gemini-drafted but fell to Qwen after all
    // retries (outage). The recovery pass re-attempts Gemini for these — by
    // then minutes have passed and the service has usually recovered.
    const qwenFallbackNums = new Set<string>();

    // ── Phase A: parallel Qwen for descriptive sections ──────────────────────
    if (descriptiveSections.length > 0) {
      currentStep = "draft_descriptive_sections";
      const descriptiveResults = await Promise.allSettled(
        descriptiveSections.map(async (section: any) => {
          const { system: sSys, user: sUserBase } = buildSectionPrompt(
            outline, section, corpusEvidence, exemplar.text, exemplar.title, [], plan?.emphasis ?? null,
          );
          const sUser = clarifyBlock ? { ...sUserBase, suffix: `${sUserBase.suffix}${clarifyBlock}` } : sUserBase;
          log(`§${section.number} (${deepMode ? "Gemini" : "Qwen"} parallel) "${section.heading}" — ${corpusEvidence.length} evidence papers`);
          let draft: any;
          if (deepMode) {
            try {
              // Deep mode's Pro premium belongs on ANALYTICAL sections only —
              // descriptive sections (intro/background/stylized facts) are the
              // ones Qwen already handles in standard mode, so the QA model
              // (flash) is plenty here and skips Pro's ~6k thinking tokens per
              // call (~$0.06-0.08/section). The recovery pass + apparatus
              // strippers below catch any flash prose leaks.
              draft = await callGeminiDraft(sSys, sUser, 16384, false, "jel_gemini", GEMINI_JEL_QA_MODEL);
            } catch (err) {
              log(`§${section.number} Gemini failed after ${GEMINI_DRAFT_ATTEMPTS} attempts (${(err as Error).message}) — falling back to Qwen`);
              draft = await callQwen(sSys, sUser, 6000, false);
              qwenFallbackNums.add(String(section.number));
            }
          } else {
            try {
              draft = await callQwen(sSys, sUser, 6000, false);
            } catch (err) {
              log(`§${section.number} Qwen failed (${(err as Error).message}) — falling back to Gemini`);
              draft = await callGeminiDraft(sSys, sUser, 16384, false);
            }
          }
          return { section, draft };
        })
      );

      // Finalize each drafted section. (The per-section "eager audit" that ran
      // here was removed 2026-07-06: its report was written to rec.eagerAudit
      // and read by NOTHING — the Corrector consumes the full-paper
      // runClaimAudit report instead — while costing ~3 LLM calls per section
      // and blocking Phase A completion.)
      for (const result of descriptiveResults) {
        if (result.status === "fulfilled") {
          const rec = finalizeSection(result.value.section, result.value.draft);
          draftedSections.push(rec);
          totalWords += rec.wordCount;
          if (rec.overlapWarnings && rec.overlapWarnings.length > 0) {
            log(`§${rec.number} overlap flagged: ${rec.overlapWarnings.length} paper(s) — longest ${Math.max(...rec.overlapWarnings.map((w: any) => w.longestMatchWords))} verbatim words`);
          }
          log(`§${rec.number} done: ${rec.wordCount} words, ${rec.citedWorkIds.length} citations`);
        } else {
          log(`§descriptive section failed: ${result.reason}`);
        }
      }

      // Sort by section number so analytical sections see them in order
      draftedSections.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

      // Persist Phase A results
      await client.from("jel_papers").update({ sections: draftedSections }).eq("id", jobId);
    }

    // ── Phase B: sequential Gemini for analytical sections ───────────────────
    for (const section of analyticalSections) {
      currentStep = `draft_section_${section.number}`;
      log(`§${section.number} (Gemini sequential) "${section.heading}"...`);

      log(`§${section.number} grounded in ${corpusEvidence.length} evidence papers`);
      const prior = buildPrior();

      const { system: sSys, user: sUserBase } = buildSectionPrompt(
        outline, section, corpusEvidence, exemplar.text, exemplar.title, prior, plan?.emphasis ?? null,
      );
      const sUser = clarifyBlock ? { ...sUserBase, suffix: `${sUserBase.suffix}${clarifyBlock}` } : sUserBase;

      let draft: any;
      try {
        draft = await callGeminiDraft(sSys, sUser, 16384, false);
      } catch (err) {
        log(`§${section.number} Gemini failed after ${GEMINI_DRAFT_ATTEMPTS} attempts (${(err as Error).message}) — falling back to Qwen`);
        try {
          draft = await callQwen(sSys, sUser, 6000, false);
          qwenFallbackNums.add(String(section.number));
        } catch (err2) {
          log(`§${section.number} Qwen fallback also failed: ${(err2 as Error).message} — skipping`);
          continue;
        }
      }

      const rec = finalizeSection(section, draft);
      draftedSections.push(rec);
      draftedSections.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
      totalWords += rec.wordCount;

      if (rec.overlapWarnings && rec.overlapWarnings.length > 0) {
        log(`§${rec.number} overlap flagged: ${rec.overlapWarnings.length} paper(s) — longest ${Math.max(...rec.overlapWarnings.map((w: any) => w.longestMatchWords))} verbatim words`);
      }

      await client.from("jel_papers").update({ sections: draftedSections }).eq("id", jobId);
      log(`§${rec.number} done: ${rec.wordCount} words, ${rec.citedWorkIds.length} citations`);
    }

    // ── Recovery pass: re-draft any outline section that got dropped OR came
    //    back empty/near-empty ──
    // A section failing BOTH models in Phase A/B was previously left as a silent
    // gap in a "done" paper (e.g. §2 missing). An EMPTY section (e.g. a Qwen
    // section timeout returning a blank/near-blank body) was even worse: it sat
    // in `draftedSections`, so it was neither "missing" (recovery skipped it) nor
    // caught by the Corrector's truncation guard (a falsy body fails `if (s.body…)`)
    // → a blank §N shipped in a "done" paper. Treat empty == missing: pull empties
    // out so they re-draft (Gemini-first), and if STILL empty after retries, drop
    // them entirely rather than persist a blank section.
    const EMPTY_SECTION_WORD_FLOOR = 50; // a real section is hundreds of words
    {
      // Content-broken = leaked scratchpad/citation-legend/meta-notes (see
      // sectionContentIssue). These pass the word floor (a legend can be 150+
      // words) but are not prose — pull them for a corrective re-draft too.
      const brokenNums = new Set(
        draftedSections
          .filter((s) => String(s.number) !== "critique" && sectionContentIssue(s.body))
          .map((s) => String(s.number)),
      );
      const emptyNums = new Set(
        draftedSections
          .filter((s) => String(s.number) !== "critique" && (wordCount(s.body) < EMPTY_SECTION_WORD_FLOOR || brokenNums.has(String(s.number))))
          .map((s) => String(s.number)),
      );
      if (emptyNums.size > 0) {
        log(`recovery: ${emptyNums.size} empty/near-empty/broken section(s) [${[...emptyNums].join(", ")}]${brokenNums.size ? ` (broken: ${[...brokenNums].join(", ")})` : ""} — will re-draft`);
        draftedSections = draftedSections.filter((s) => !emptyNums.has(String(s.number)));
        totalWords = draftedSections.reduce((n, s) => n + (s.wordCount ?? 0), 0);
      }
      const draftedNums = new Set(draftedSections.map((s) => String(s.number)));
      const missing = outline.sections.filter((s: any) => !draftedNums.has(String(s.number)));
      if (missing.length > 0) {
        log(`recovery: ${missing.length} dropped section(s) [${missing.map((s: any) => s.number).join(", ")}] — retrying`);
        for (const section of missing) {
          currentStep = `recover_section_${section.number}`;
          // A section pulled for a CONTENT issue (not just missing/empty) gets an
          // explicit corrective instruction so the re-draft doesn't repeat the leak.
          const corrective = brokenNums.has(String(section.number))
            ? "A prior draft of THIS section failed: it emitted citation-formatting notes, an 'Author -> citation' legend, or bracketed working-notes/meta-commentary instead of prose. Write ONLY the section as flowing narrative paragraphs that synthesize the evidence with inline 'Author (year) [workId]' citations. Never output lists, legends, arrows ('->'), working notes, or a per-section references/conclusion block."
            : null;
          const { system: sSys, user: sUserBase } = buildSectionPrompt(
            outline, section, corpusEvidence, exemplar.text, exemplar.title, buildPrior(), plan?.emphasis ?? null, corrective,
          );
          const sUser = clarifyBlock ? { ...sUserBase, suffix: `${sUserBase.suffix}${clarifyBlock}` } : sUserBase;
          let draft: any = null;
          for (let attempt = 1; attempt <= 2 && !draft; attempt++) {
            try { draft = await callGeminiDraft(sSys, sUser, 16384, false); }
            catch {
              try {
                draft = await callQwen(sSys, sUser, 6000, false);
                qwenFallbackNums.add(String(section.number));
              } catch (e2) {
                log(`§${section.number} recovery attempt ${attempt} failed: ${(e2 as Error).message}`);
                if (attempt < 2) await new Promise((r) => setTimeout(r, 6000));
              }
            }
          }
          if (draft) {
            const rec = finalizeSection(section, draft);
            const stillBroken = sectionContentIssue(rec.body);
            if (rec.wordCount < EMPTY_SECTION_WORD_FLOOR || stillBroken) {
              // Still blank/broken after re-draft — DROP it (don't persist a bad
              // section). A clean numbered gap beats an empty or scratchpad section.
              log(`§${section.number} STILL ${stillBroken ? `broken (${stillBroken})` : `empty (${rec.wordCount} words)`} after recovery — dropped, not persisted`);
            } else {
              draftedSections.push(rec);
              totalWords += rec.wordCount;
              log(`§${rec.number} recovered: ${rec.wordCount} words`);
            }
          } else {
            log(`§${section.number} STILL missing after recovery — left as a gap`);
          }
        }
        draftedSections.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
        await client.from("jel_papers").update({ sections: draftedSections }).eq("id", jobId);
      }

      // ── Qwen-fallback upgrade pass: sections that SHOULD have been Gemini but
      //    fell to Qwen during an outage get ONE more Gemini attempt now —
      //    minutes later, the 503/timeout window has usually passed. Keep the
      //    Qwen version if Gemini still fails or the re-draft is worse-shaped
      //    (Qwen is the sole-option last resort, never silently preferred).
      const upgradable = draftedSections.filter((s) => qwenFallbackNums.has(String(s.number)));
      if (upgradable.length > 0) {
        log(`recovery: ${upgradable.length} Qwen-fallback section(s) [${upgradable.map((s) => s.number).join(", ")}] — re-attempting Gemini`);
        for (const old of upgradable) {
          const outlineSec = outline.sections.find((s: any) => String(s.number) === String(old.number));
          if (!outlineSec) continue;
          currentStep = `upgrade_section_${old.number}`;
          const { system: sSys, user: sUserBase } = buildSectionPrompt(
            outline, outlineSec, corpusEvidence, exemplar.text, exemplar.title, buildPrior(), plan?.emphasis ?? null,
          );
          const sUser = clarifyBlock ? { ...sUserBase, suffix: `${sUserBase.suffix}${clarifyBlock}` } : sUserBase;
          try {
            const draft = await callGeminiDraft(sSys, sUser, 16384, false);
            const rec = finalizeSection(outlineSec, draft);
            if (rec.wordCount >= EMPTY_SECTION_WORD_FLOOR && !sectionContentIssue(rec.body)) {
              const idx = draftedSections.findIndex((s) => String(s.number) === String(old.number));
              if (idx >= 0) {
                totalWords += rec.wordCount - (draftedSections[idx].wordCount ?? 0);
                draftedSections[idx] = rec;
                log(`§${rec.number} upgraded Qwen→Gemini: ${rec.wordCount} words, ${rec.citedWorkIds.length} citations`);
              }
            } else {
              log(`§${old.number} Gemini re-draft rejected (${sectionContentIssue(rec.body) ?? `${rec.wordCount} words`}) — keeping Qwen version`);
            }
          } catch (err) {
            log(`§${old.number} Gemini still failing (${(err as Error).message}) — keeping Qwen version`);
          }
        }
        await client.from("jel_papers").update({ sections: draftedSections }).eq("id", jobId);
      }
    }

    log(`all sections drafted: ${totalWords} words, ${allCited.size} unique citations`);

    if (draftedSections.length === 0) {
      throw new Error(
        `All ${outline.sections.length} sections failed to draft — both Qwen and Gemini failed for every section. Check LiteLLM and Gemini API availability.`,
      );
    }

    // 9. Devil's Advocate — challenges thesis across 8 dimensions, appended as
    //    a "Critical Assessment" section so it becomes part of the paper.
    currentStep = "devil_advocate";
    log("running devil's advocate…");
    try {
      const da = await callDevilsAdvocate(outline, draftedSections, coding);
      const daBody = da.body;
      if (daBody) {
        const daFenced = fenceBodyToEvidence(normalizeCitations(stripSectionMarkdown(daBody), coding.papers), validIds);
        const daIntegrity = enforceCitationIntegrity(daFenced, coding.papers);
        const daNorm = daIntegrity.body;
        if (daIntegrity.stats.renamed || daIntegrity.stats.linked || daIntegrity.stats.removed) {
          log(`critique citation integrity: ${JSON.stringify(daIntegrity.stats)}`);
        }
        const daRec = {
          number: "critique",
          heading: "Critical Assessment: Evidence Gaps and Contested Interpretations",
          body: daNorm,
          citedWorkIds: extractCitedIds(daNorm, validIds),
          wordCount: wordCount(daNorm),
        };
        draftedSections.push(daRec);
        daRec.citedWorkIds.forEach((id: string) => allCited.add(id));
        totalWords += daRec.wordCount;
        await client.from("jel_papers").update({ sections: draftedSections }).eq("id", jobId);
        log(`devil's advocate done: ${daRec.wordCount} words`);
      }

      // Keep DA section revisions as FINDINGS for the Corrector (no longer applied here).
      const { data: cda } = await client.from("jel_papers").select("outline").eq("id", jobId).single();
      await client.from("jel_papers").update({
        outline: { ...(cda?.outline ?? {}), daRevisions: da.sectionRevisions ?? [] },
      }).eq("id", jobId);
    } catch (err) {
      log(`devil's advocate failed: ${(err as Error).message} — skipping`);
    }

    // 10. Coherence Editor — reads all sections, flags repetition / contradictions /
    //     citation over-concentration / unfulfilled scope / missed handoffs.
    //     Stores structured report in outline.coherenceReport.
    currentStep = "coherence_editor";
    log("running coherence editor…");
    try {
      const coherenceReport = await callCoherenceEditor(outline, draftedSections, coding);
      if (coherenceReport) {
        const { data: currentOutline } = await client
          .from("jel_papers").select("outline").eq("id", jobId).single();
        await client.from("jel_papers").update({
          outline: { ...(currentOutline?.outline ?? {}), coherenceReport },
        }).eq("id", jobId);
        log(`coherence editor done: ${coherenceReport.issues?.length ?? 0} issues flagged (diagnostic — applied by the Corrector)`);
      }
    } catch (err) {
      log(`coherence editor failed: ${(err as Error).message} — skipping`);
    }

    // 11. Kris citation validator — verify cited DOIs against OpenAlex.
    //     Flags title mismatches (potential abstract-recall errors).
    //     Non-blocking: pipeline continues even if OA is unreachable.
    currentStep = "kris_validator";
    log("running Kris citation validator…");
    try {
      const krisReport = await callKrisValidator(draftedSections, coding.papers);
      log(`Kris: ${krisReport.verified} verified, ${krisReport.notInOA} not in OA, ${krisReport.mismatches.length} mismatch(es)`);
      if (krisReport.mismatches.length > 0) {
        log(`Kris mismatches: ${krisReport.mismatches.map((m: any) => m.id).join(", ")}`);
      }
      const { data: currentOutline } = await client
        .from("jel_papers").select("outline").eq("id", jobId).single();
      await client.from("jel_papers").update({
        outline: { ...(currentOutline?.outline ?? {}), krisReport },
      }).eq("id", jobId);
    } catch (err) {
      log(`Kris validator failed: ${(err as Error).message} — skipping`);
    }

    // Claim audit (diagnostic) — runs before done; consumed by the Corrector (wired in a later phase).
    currentStep = "claim_audit";
    try {
      const auditReport = await runClaimAudit(draftedSections, coding, validIds, log);
      const { data: co } = await client.from("jel_papers").select("outline").eq("id", jobId).single();
      await client.from("jel_papers").update({ outline: { ...(co?.outline ?? {}), auditReport } }).eq("id", jobId);
    } catch (err) {
      log(`claim audit failed: ${(err as Error).message} — skipping`);
    }

    // 11b. Quality report — pure-compute global metrics (cross-section
    //      concentration, corpus coverage, single-paper section anchoring).
    //      Cheap, runs in milliseconds. Stored in outline.qualityReport.
    currentStep = "quality_report";
    try {
      const qualityReport = computeQualityReport(draftedSections, coding);
      if (qualityReport.coreScoped) {
        const ch = Object.entries(qualityReport.perChannelCore).map(([k, v]) => `${k} ${v.cited}/${v.core}`).join(", ");
        const short = qualityReport.underrepresentedChannels.map((u) => `${u.channel}(${u.cited}<${u.target})`).join(", ") || "none";
        log(`quality report (CORE-scoped): ${qualityReport.coreCoveragePct}% CORE coverage (${qualityReport.coreCovered}/${qualityReport.coreSize}) | per-channel ${ch} | under-represented: ${short} | ${qualityReport.overusedGlobal.length} overused, ${qualityReport.singlePaperSections.length} single-paper section(s)`);
      } else {
        log(`quality report: ${qualityReport.coveragePct}% corpus coverage (${qualityReport.distinctCited}/${qualityReport.corpusSize}), ${qualityReport.overusedGlobal.length} globally overused paper(s), ${qualityReport.singlePaperSections.length} single-paper section(s)`);
      }
      const { data: currentOutline } = await client
        .from("jel_papers").select("outline").eq("id", jobId).single();
      await client.from("jel_papers").update({
        outline: { ...(currentOutline?.outline ?? {}), qualityReport },
      }).eq("id", jobId);
    } catch (err) {
      log(`quality report failed: ${(err as Error).message} — skipping`);
    }

    // 11c. Final review pass — single Gemini call that sees the whole article
    //      and the full evidence corpus. Catches unsupported claims, off-topic
    //      themes, and corpus papers that should have been cited. Stored in
    //      outline.reviewReport. Non-blocking. (Diagnostic — applied by the Corrector.)
    currentStep = "final_review";
    log("running final review pass…");
    try {
      const reviewReport = await runFinalReviewPass(outline, draftedSections, coding);
      if (reviewReport) {
        log(`final review: verdict=${reviewReport.overallVerdict}, unsupported=${reviewReport.unsupportedClaims?.length ?? 0}, off-topic=${reviewReport.offTopicThemes?.length ?? 0}, gaps=${reviewReport.corpusGaps?.length ?? 0}`);
        const { data: currentOutline } = await client
          .from("jel_papers").select("outline").eq("id", jobId).single();
        await client.from("jel_papers").update({
          outline: { ...(currentOutline?.outline ?? {}), reviewReport },
        }).eq("id", jobId);
      }
    } catch (err) {
      log(`final review failed: ${(err as Error).message} — skipping`);
    }

    // ── Corrector: ONE coordinated correction pass that consolidates the DA,
    //    coherence, Kris, claim-audit, and final-review findings into per-section
    //    rewrites (re-ground/soften/re-attribute unsupported claims, drop+reground
    //    Kris mismatches, de-dup/reconcile coherence, weave in grounded corpusGaps,
    //    complete truncated bodies). Reads the findings from the persisted outline
    //    (every diagnostic wrote its report there). Soft-fail: on any error the
    //    paper ships uncorrected. Validated non-destructively via scripts/corrector-dryrun.mjs.
    currentStep = "corrector";
    log("running corrector pass…");
    try {
      const { runCorrectorPass } = await import("./corrector.ts");
      const { data: fo } = await client
        .from("jel_papers").select("outline").eq("id", jobId).single();
      const fOutline = fo?.outline ?? {};
      const findings = {
        auditReport: fOutline.auditReport,
        reviewReport: fOutline.reviewReport,
        krisReport: fOutline.krisReport,
        coherenceReport: fOutline.coherenceReport,
        daRevisions: fOutline.daRevisions ?? [],
      };
      const res = await runCorrectorPass(draftedSections, coding, validIds, findings, { log, dryRun: false });
      draftedSections = res.sections;
      totalWords = draftedSections.reduce((n: number, s: any) => n + (s.wordCount ?? 0), 0);
      allCited.clear();
      for (const s of draftedSections) for (const w of (s.citedWorkIds ?? [])) allCited.add(w);
      const { data: cc } = await client
        .from("jel_papers").select("outline").eq("id", jobId).single();
      await client.from("jel_papers").update({
        sections: draftedSections,
        outline: { ...(cc?.outline ?? {}), correctorReport: res.correctorReport },
      }).eq("id", jobId);
      const cr = res.correctorReport;
      log(`corrector done: ${cr.sectionsRewritten.length} section(s) rewritten, ${cr.remainingIssues.length} issue(s) remaining`);
    } catch (err) {
      log(`corrector failed: ${(err as Error).message} — shipping uncorrected`);
    }

    // 12. Build the Evidence Table — ALL evidence papers in the brief's
    //     evidence-table order (the curated / composite-rerank order of
    //     evidenceIds), not just the cited ones. This mirrors the brief's
    //     evidence table 1:1 so the paper is transparent about the full corpus
    //     it was built from. `cited` flags which papers the prose actually used.
    const worksMap = new Map<string, any>(allWorks.map((w: any) => [w.id, w]));
    // Uploaded papers live only in coding.papers (not allWorks). Fall back to
    // their coding-sheet metadata so uploads appear in the evidence table with
    // real title/authors, not "Unknown" / the bare DOI (spec §9 guarantee).
    const codingMap = new Map<string, any>(coding.papers.map((p: any) => [p.workId, p]));
    const seenInOrder = new Set<string>();
    const bibliography = evidenceIds
      .filter((workId) => {
        if (seenInOrder.has(workId)) return false;
        seenInOrder.add(workId);
        return true;
      })
      .map((workId, idx) => {
        const w = worksMap.get(workId) ?? codingMap.get(workId);
        const authors: string[] = toAuthorArr(w?.authors);
        const authorStr = authors.length === 0 ? "Unknown"
          : authors.length <= 3 ? authors.join(", ")
          : `${authors.slice(0, 3).join(", ")} et al.`;
        return {
          number: idx + 1,
          workId,
          authors: authorStr,
          year: w?.year ?? null,
          title: w?.title ?? workId,
          venue: w?.venue ?? w?.institution ?? w?.source ?? null,
          doi: w?.canonical_doi ?? (workId.startsWith("10.") ? workId : null),
          // Unverified = user-supplied upload OR the abstract text is not
          // retrieved-from-source (LLM-recalled / quarantined — 2026-07-15).
          unverified: !!(w && ((w as any).isUpload ||
            UNVERIFIED_ABSTRACT_SOURCES.has(String((w as any).abstract_source ?? "")))),
          cited: allCited.has(workId),                 // did the prose actually cite it?
        };
      });
    log(`evidence table: ${bibliography.length} papers (${allCited.size} cited)`);

    // 12. Mark done + write feed entry
    const now = new Date().toISOString();
    await client
      .from("jel_papers")
      .update({
        status: "done",
        word_count: totalWords,
        citation_count: allCited.size,
        bibliography,
        completed_at: now,
      })
      .eq("id", jobId);

    await client
      .from("feed")
      .insert({
        user_id: tenantId,
        kind: "jel-paper",
        title: `JEL paper ready: "${outline.title}"`,
        reason: `${totalWords.toLocaleString()} words · ${allCited.size} citations · ${draftedSections.length} sections`,
        linked_entity_id: jobId,
      });

    log("done ✓");

    logUsageEvent({
      tenantId, eventType: "paper.generation_completed",
      targetType: "paper", targetId: jobId, status: "completed",
      latencyMs: Date.now() - jobStartedAt,
      payload: {
        wordCount: totalWords, sections: draftedSections.length, citationCount: allCited.size,
        // Per-paper LLM cost. gemini* = the BILLED synthesis provider (app
        // Gemini OR BYOK Claude/Gemini — see provider); Qwen is self-hosted (~$0).
        // BYOK calls now roll up here too (2026-07-06 — they used to report 0).
        provider: providerCfg?.provider ?? "gemini",
        providerModel: providerCfg?.model ?? GEMINI_MODEL,
        byok: !!providerCfg,
        geminiTokensIn: usageCtx.geminiIn, geminiTokensOut: usageCtx.geminiOut, geminiCalls: usageCtx.geminiCalls,
        qwenTokensIn: usageCtx.qwenIn, qwenTokensOut: usageCtx.qwenOut, qwenCalls: usageCtx.qwenCalls,
        // Priced at Gemini-Flash list only — null for BYOK (wrong price sheet).
        estGeminiUsd: providerCfg ? null : Number(usageCtx.geminiUsd.toFixed(4)),
      },
    });
    log(`cost: ${providerCfg?.provider ?? "gemini"} ${usageCtx.geminiCalls} calls ${usageCtx.geminiIn}→${usageCtx.geminiOut} tok${providerCfg ? "" : ` (~$${usageCtx.geminiUsd.toFixed(3)})`} · qwen ${usageCtx.qwenCalls} calls ${usageCtx.qwenIn}→${usageCtx.qwenOut} tok`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorMessage = `[step:${currentStep}] ${msg}`;
    console.error(`[jel-paper:${jobId}] error at step "${currentStep}":`, msg);
    // A BYOK key rejected/exhausted mid-generation → tell the granted user clearly.
    const persistedMessage = (err instanceof ProviderCallError && err.isKeyFailure)
      ? "Your team's synthesis key was rejected — contact your admin."
      : errorMessage;
    logUsageEvent({
      tenantId, eventType: "paper.generation_failed",
      targetType: "paper", targetId: jobId, status: "failed",
      latencyMs: Date.now() - jobStartedAt,
      error: errorMessage,
      payload: {
        step: currentStep,
        provider: providerCfg?.provider ?? "gemini",
        providerModel: providerCfg?.model ?? GEMINI_MODEL,
        byok: !!providerCfg,
        geminiTokensIn: usageCtx.geminiIn, geminiTokensOut: usageCtx.geminiOut, geminiCalls: usageCtx.geminiCalls,
        qwenTokensIn: usageCtx.qwenIn, qwenTokensOut: usageCtx.qwenOut, qwenCalls: usageCtx.qwenCalls,
        estGeminiUsd: providerCfg ? null : Number(usageCtx.geminiUsd.toFixed(4)),
      },
    });
    await client
      .from("jel_papers")
      .update({ status: "error", error_message: persistedMessage })
      .eq("id", jobId)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Talk-to-the-draft revision — re-draft the section(s) an instruction targets.
// Background job (mirrors runJelPaperJob lifecycle). Increments
// regenerations_used ONLY on success (a failed route/draft doesn't burn budget).
// ---------------------------------------------------------------------------

// Maps a revision instruction → the section number(s) it targets + a normalized
// directive, WITHOUT re-drafting or burning a revision. Used by both the preview
// endpoint and runJelPaperRevision so routing behavior is identical.
export async function routeRevisionInstruction(
  instruction: string,
  sections: Array<{ number: string; heading: string }>,
  sectionHint?: string,
): Promise<{ targetSections: string[]; headings: string[]; directive: string }> {
  const hinted = sectionHint
    ? `In section ${sectionHint}: ${instruction}`
    : instruction;
  const routeSys = [
    "You map a user's revision request to the section(s) of a JEL survey it targets.",
    "Given the instruction and the list of sections (number + heading), return JSON only:",
    '{ "targetSections": ["3"], "directive": "a clear rewrite instruction for those sections" }',
    "Pick the FEWEST sections that satisfy the request (usually 1). Use the exact section",
    "numbers from the list. If the request is global (e.g. 'make it more cautious'), you may",
    "return multiple. directive restates the user's ask in imperative form for the drafter.",
  ].join("\n");
  const routeUser = [
    `INSTRUCTION: ${hinted}`,
    "SECTIONS:",
    ...sections.map((s) => `${s.number} — ${s.heading}`),
  ].join("\n");
  let route: any;
  try { route = await callQwen(routeSys, routeUser, 1024); }
  catch { route = await callGemini(routeSys, routeUser, 1024, true, "jel_revise_route", GEMINI_JEL_QA_MODEL); }
  const targetSections: string[] = Array.isArray(route?.targetSections)
    ? route.targetSections.map((n: any) => String(n)) : [];
  const directive: string = typeof route?.directive === "string" && route.directive.trim()
    ? route.directive.trim() : hinted;
  const headings = targetSections.map((num) =>
    sections.find((s) => String(s.number) === num)?.heading ?? `Section ${num}`);
  return { targetSections, headings, directive };
}

export async function runJelPaperRevision(
  jobId: string,
  tenantId: string,
  client: any,
  instruction: string,
  sectionHint?: string,
): Promise<void> {
  const log = (m: string) => console.log(`[jel-revise:${jobId}] ${m}`);
  const reviseStartedAt = Date.now();
  const usageCtx: JelUsageCtx = {
    paperId: jobId, tenantId,
    geminiIn: 0, geminiOut: 0, geminiCalls: 0, geminiUsd: 0,
    qwenIn: 0, qwenOut: 0, qwenCalls: 0,
  };
  jelUsageStore.enterWith(usageCtx);

  // Resolve the owner's BYOK provider (Gemini/Claude) for this revision; null => app default.
  let providerCfg = null;
  try {
    providerCfg = await resolveProviderConfig(client, tenantId);
  } catch (e) {
    // NEVER rethrow (detached fire-and-forget — see runJelPaperJob): an escaped
    // rejection here is an unhandled rejection that can kill the Deno process.
    try {
      if (e instanceof ProviderCallError) {
        // Granted owner but their key is gone → hard error this paper, do NOT degrade.
        await client.from("jel_papers").update({
          status: "error",
          error_message: "Your team's synthesis key is unavailable — contact your admin.",
        }).eq("id", jobId);
      } else {
        // Pre-start failure: the paper content is untouched — revert to done,
        // budget unconsumed (matches the main revision failure path below).
        await client.from("jel_papers").update({ status: "done" }).eq("id", jobId);
      }
    } catch (dbErr) {
      console.error(`[jel-revise:${jobId}] failed to reset status after pre-start error:`, dbErr);
    }
    return;
  }
  synthCtxStore.enterWith({ providerCfg, tenantId });

  try {
    const { data: paper, error } = await client
      .from("jel_papers")
      .select("id, search_run_id, brief_id, plan, outline, sections, regenerations_used")
      .eq("id", jobId)
      .single();
    if (error || !paper) throw new Error(`paper fetch failed: ${error?.message}`);

    const sections: any[] = Array.isArray(paper.sections) ? paper.sections : [];
    const outline: any = paper.outline ?? {};
    const outlineSections: any[] = Array.isArray(outline.sections) ? outline.sections : [];
    if (sections.length === 0 || outlineSections.length === 0) {
      throw new Error("nothing to revise (no sections/outline on this paper)");
    }
    const plan: any = paper.plan ?? null;

    // 1. Rebuild evidence (same as generation).
    let evidenceIds: string[];
    if (plan && Array.isArray(plan.curatedWorkIds) && plan.curatedWorkIds.length > 0) {
      const removed = new Set(plan.removedWorkIds ?? []);
      evidenceIds = plan.curatedWorkIds.filter((id: string) => !removed.has(id));
    } else {
      const { data: run } = await client
        .from("search_runs").select("evidence_work_ids").eq("id", paper.search_run_id).single();
      evidenceIds = run?.evidence_work_ids ?? [];
    }
    // Include generation-time planner additions (persisted as
    // plan.discoveredWorkIds): the original draft cited them, so the revision's
    // citation fence + rebuilt bibliography must keep covering them — otherwise
    // revised sections lose those citations and unrevised prose keeps [workId]
    // tokens that no longer resolve to a bibliography entry.
    if (Array.isArray(plan?.discoveredWorkIds)) {
      const removedD = new Set((plan?.removedWorkIds ?? []) as string[]);
      for (const id of plan.discoveredWorkIds as string[]) {
        if (!removedD.has(id) && !evidenceIds.includes(id)) evidenceIds.push(id);
      }
    }
    const allWorks: any[] = [];
    for (let i = 0; i < evidenceIds.length; i += 80) {
      const { data } = await client
        .from("works")
        .select("id, title, authors, year, sms_level, methodology_design, geography, abstract, canonical_doi, citation_count, venue, source, abstract_source:raw_data->>abstract_source")
        .in("id", evidenceIds.slice(i, i + 80));
      if (data) allWorks.push(...data);
    }
    const { data: cardRows } = await client
      .from("evidence_cards")
      .select("work_id, study_design, intervention, outcome, effect_direction, effect_size_text, sample_size, sample_size_text, country, identification_strategy, limitations, mechanism, heterogeneity, external_validity_note, finding_short")
      .in("work_id", evidenceIds);
    const cardsById: Record<string, any> = {};
    for (const c of (cardRows ?? [])) cardsById[c.work_id] = c;
    const coding = buildCodingSheet(allWorks, cardsById, evidenceIds);
    mergeUploadsIntoCoding(coding, plan, evidenceIds);
    const validIds = new Set(evidenceIds);

    // 2. Route the instruction → target section number(s) + a normalized directive.
    const { targetSections: targetNums, directive } = await routeRevisionInstruction(
      instruction,
      sections.map((s) => ({ number: String(s.number), heading: s.heading })),
      sectionHint,
    );
    if (targetNums.length === 0) throw new Error("could not map the instruction to any section");
    log(`revising sections ${targetNums.join(", ")} — "${directive.slice(0, 80)}"`);

    // 3. Re-draft each targeted section.
    const exemplar = await loadVoiceAnchor();
    // Canonical corpus order — same rationale as generation (shared cache prefix).
    const corpusEvidence = pickEvidenceForSection(coding, {});
    let revisedCount = 0;
    for (const num of targetNums) {
      const secIdx = sections.findIndex((s) => String(s.number) === num);
      const outlineSec = outlineSections.find((s: any) => String(s.number) === num);
      if (secIdx < 0 || !outlineSec) { log(`§${num} not found / no outline entry — skipping`); continue; }
      const prior = sections
        .filter((_, i) => i !== secIdx)
        .map((s) => ({ number: s.number, heading: s.heading, wordCount: s.wordCount,
          // 200 words (was 400) — same trim rationale as buildPrior() in generation.
          bodyPreview: String(s.body ?? "").split(/\s+/).slice(0, 200).join(" ") }));
      const { system, user } = buildSectionPrompt(
        outline, outlineSec, corpusEvidence, exemplar.text, exemplar.title, prior,
        plan?.emphasis ?? null, directive,
      );
      let draft: any;
      try { draft = await callGeminiDraft(system, user, 16384, false); }
      catch { try { draft = await callQwen(system, user, 6000, false); } catch { log(`§${num} draft failed — skipping`); continue; } }
      const rawBody: string = typeof draft === "string"
        ? draft
        : (draft?.body ?? draft?.text ?? draft?.content ?? draft?.prose ?? "");
      const body = enforceCitationIntegrity(
        fenceBodyToEvidence(normalizeCitations(rawBody, coding.papers), validIds),
        coding.papers,
      ).body;
      const cited = extractCitedIds(body, validIds);
      sections[secIdx] = {
        ...sections[secIdx],
        previousBody: sections[secIdx].body,
        body,
        citedWorkIds: cited,
        wordCount: wordCount(body),
      };
      revisedCount++;
      log(`§${num} revised: ${wordCount(body)} words, ${cited.length} citations`);
    }
    if (revisedCount === 0) throw new Error("no sections were successfully revised");

    // 4. Rebuild the Evidence Table — ALL evidence papers in evidence-table
    //    order (same as generation), with `cited` flagging prose usage.
    const cited = new Set<string>();
    for (const s of sections) for (const id of (s.citedWorkIds ?? [])) cited.add(id);
    const worksMap = new Map<string, any>(allWorks.map((w: any) => [w.id, w]));
    const codingMap = new Map<string, any>(coding.papers.map((p: any) => [p.workId, p]));
    const seenInOrder = new Set<string>();
    const bibliography = evidenceIds
      .filter((workId: string) => {
        if (seenInOrder.has(workId)) return false;
        seenInOrder.add(workId);
        return true;
      })
      .map((workId: string, idx: number) => {
        const w = worksMap.get(workId) ?? codingMap.get(workId);
        const authors: string[] = toAuthorArr(w?.authors);
        const authorStr = authors.length === 0 ? "Unknown"
          : authors.length <= 3 ? authors.join(", ") : `${authors.slice(0, 3).join(", ")} et al.`;
        return { number: idx + 1, workId, authors: authorStr, year: w?.year ?? null,
          title: w?.title ?? workId, venue: w?.venue ?? w?.institution ?? w?.source ?? null,
          doi: w?.canonical_doi ?? (workId.startsWith("10.") ? workId : null),
          unverified: !!(w && ((w as any).isUpload ||
            UNVERIFIED_ABSTRACT_SOURCES.has(String((w as any).abstract_source ?? "")))),
          cited: cited.has(workId) };
      });

    // 5. Persist — success: increment the regen counter, back to done.
    const totalWords = sections.reduce((a: number, s: any) => a + (s.wordCount ?? 0), 0);
    await client.from("jel_papers").update({
      sections,
      bibliography,
      word_count: totalWords,
      citation_count: cited.size,
      regenerations_used: (paper.regenerations_used ?? 0) + 1,
      status: "done",
      completed_at: new Date().toISOString(),
    }).eq("id", jobId);
    // Append to the revision thread (fail-safe: a missing column / lagged
    // migration must never fail a completed revision — mirrors telemetry ethos).
    try {
      const { data: cur } = await client
        .from("jel_papers").select("revision_log").eq("id", jobId).single();
      const prevLog: any[] = Array.isArray(cur?.revision_log) ? cur.revision_log : [];
      const entry = {
        n: (paper.regenerations_used ?? 0) + 1,
        instruction,
        directive,
        targetSections: targetNums,
        sectionsRevised: revisedCount,
        at: new Date().toISOString(),
      };
      await client.from("jel_papers")
        .update({ revision_log: [...prevLog, entry] }).eq("id", jobId);
    } catch (logErr) {
      log(`revision_log append skipped: ${(logErr as Error).message}`);
    }
    log(`revision done: ${revisedCount} section(s), regen ${(paper.regenerations_used ?? 0) + 1}/2`);
    logUsageEvent({
      tenantId, eventType: "paper.revised", targetType: "paper", targetId: jobId,
      status: "completed", latencyMs: Date.now() - reviseStartedAt,
      payload: {
        sectionsRevised: revisedCount, targetSections: targetNums, regenerationsUsed: (paper.regenerations_used ?? 0) + 1,
        provider: providerCfg?.provider ?? "gemini",
        providerModel: providerCfg?.model ?? GEMINI_MODEL,
        byok: !!providerCfg,
        geminiTokensIn: usageCtx.geminiIn, geminiTokensOut: usageCtx.geminiOut, geminiCalls: usageCtx.geminiCalls,
        qwenTokensIn: usageCtx.qwenIn, qwenTokensOut: usageCtx.qwenOut, qwenCalls: usageCtx.qwenCalls,
        estGeminiUsd: providerCfg ? null : Number(usageCtx.geminiUsd.toFixed(4)),
      },
    });
  } catch (err) {
    log(`revision failed: ${(err as Error).message}`);
    logUsageEvent({
      tenantId, eventType: "paper.revised", targetType: "paper", targetId: jobId,
      status: "failed", latencyMs: Date.now() - reviseStartedAt,
      error: (err as Error).message,
      payload: { instruction },
    });
    // Guarded: a rejection escaping this catch would be an unhandled rejection
    // in a detached job (process-crash risk).
    await client.from("jel_papers").update({ status: "done" }).eq("id", jobId).catch(() => {});
  }
}
