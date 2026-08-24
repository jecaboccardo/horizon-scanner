// deno-lint-ignore-file no-explicit-any
/**
 * supabase/functions/_shared/deepScan.ts
 *
 * Deep scan — opt-in second retrieval round for an existing search run.
 *
 * An LLM (Gemini-primary, Qwen-fallback — the established interactive-call
 * policy, see paperPlanEngine.callLlm) looks at the user's query plus the
 * run's top-50 evidence titles, names which relevant literatures are MISSING,
 * emits 2-4 follow-up sub-queries, and each sub-query runs through the
 * READ-ONLY corpus search (searchLocalCorpus). New papers are returned to the
 * route so the user can opt in to expanding the evidence set.
 *
 * 🔒 GOLDEN RULE: this module NEVER calls retrieveWorks and NEVER upserts into
 * `works` — searchLocalCorpus (select-only RPC) is the only corpus access.
 *
 * Soft-fail everywhere: if both LLMs fail or every sub-search fails, returns
 * the empty result — it never throws to the route.
 */

import { searchLocalCorpus } from "./vectorSearch.ts";
import { qwenGenerate } from "./qwenClient.ts";
import { logLlmCall } from "./telemetry.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "./llmConfig.ts";
import { callSynthProvider, currentProviderCfg } from "./synthesisProvider.ts";

type Paper = Record<string, any>;

function readEnv(key: string): string | undefined {
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(key) ?? undefined;
  }
  return (globalThis as any).process?.env?.[key];
}

const GEMINI_MODEL = readEnv("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;
const GEMINI_KEY = () => readEnv("GEMINI_API_KEY") ?? "";

const MAX_SUB_QUERIES = 4;
const TOP_PER_SUB_QUERY = 20;
const SUB_QUERY_LIMIT = 100;
const SUB_QUERY_THRESHOLD = 0.50;
// Qwen p50 on this prompt is ~49s under GPU load — give it a generous 60s.
const QWEN_TIMEOUT_MS = 60_000;
const GEMINI_TIMEOUT_MS = 60_000;

// Validated prompt (offline probes, 2026-06-10). Do not soften the strict-JSON
// instruction — lenient parsing below is the backstop, not the plan.
const SYSTEM_PROMPT =
  `You are an evidence-scanning assistant for policy research. Given a user query and the top-50 paper titles our retrieval returned, name which relevant literatures or intervention-types are MISSING from these results given the query's intent, then write 2-4 follow-up search sub-queries (literature vocabulary, under 25 words each) to surface the missing work. Output strict JSON: {"missing": ["..."], "subQueries": ["..."]}`;

export interface DeepScanInput {
  query: string;
  /** Top-50 evidence titles, in table order. */
  evidenceTitles: string[];
  /** Accepted for signature parity with other shared modules; corpus access
   *  goes through searchLocalCorpus (module-level adminClient, select-only). */
  supabaseClient?: unknown;
  /** Telemetry attribution (optional). */
  tenantId?: string;
}

export interface DeepScanOutput {
  missing: string[];
  subQueries: string[];
  newPapers: Paper[];
  model: "gemini" | "qwen" | null;
}

const EMPTY_RESULT: DeepScanOutput = { missing: [], subQueries: [], newPapers: [], model: null };

// ---------------------------------------------------------------------------
// LLM plumbing
// ---------------------------------------------------------------------------

/**
 * Gemini non-streaming generateContent (NEVER streamGenerateContent — project
 * rule). CRITICAL: maxOutputTokens 8192 + thinkingBudget 0 are required — with
 * defaults, Gemini 2.5 Flash thinking tokens eat the budget and the JSON comes
 * back truncated (hit twice during the offline probes).
 */
async function callGeminiDeepScan(user: string, tenantId?: string): Promise<string> {
  const byokCfg = currentProviderCfg();
  if (byokCfg) {
    const out = await callSynthProvider(SYSTEM_PROMPT, user, { expectJson: false, maxTokens: 8192, op: "deepscan_gemini", temperature: 0.2, tenantId }, byokCfg);
    return typeof out === "string" ? out : JSON.stringify(out);
  }

  const key = GEMINI_KEY();
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 1 },
    },
  };

  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Gemini ${r.status}: ${txt.slice(0, 300)}`);
    }
    const data = await r.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      throw new Error(`Gemini returned no text. finishReason=${data?.candidates?.[0]?.finishReason}`);
    }
    // Fire-and-forget telemetry (logLlmCall never blocks, never throws).
    logLlmCall({
      model: GEMINI_MODEL,
      operation: "deep_scan",
      tokensIn: data?.usageMetadata?.promptTokenCount,
      tokensOut: data?.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - startedAt,
      status: "ok",
      tenantId,
    });
    return text;
  } catch (err) {
    const e = err as Error;
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    logLlmCall({
      model: GEMINI_MODEL,
      operation: "deep_scan",
      latencyMs: Date.now() - startedAt,
      status: isTimeout ? "timeout" : "error",
      error: e?.message?.slice(0, 200),
      tenantId,
    });
    throw err;
  }
}

/**
 * Lenient JSON recovery: strip code fences, slice to the outermost {...},
 * then parse. Returns null (never throws) when no usable object is found.
 */
function parseLlmJson(text: string): { missing: string[]; subQueries: string[] } | null {
  let s = String(text ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const toStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
  const missing = toStrings(parsed.missing);
  const subQueries = toStrings(parsed.subQueries).slice(0, MAX_SUB_QUERIES);
  if (subQueries.length === 0) return null;
  return { missing, subQueries };
}

function buildUserPrompt(query: string, evidenceTitles: string[]): string {
  const titles = evidenceTitles
    .slice(0, 50)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  return `User query: ${query}\n\nTop retrieved paper titles:\n${titles}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDeepScan(input: DeepScanInput): Promise<DeepScanOutput> {
  const { query, evidenceTitles, tenantId } = input;
  if (!query || !Array.isArray(evidenceTitles)) return { ...EMPTY_RESULT };

  const userPrompt = buildUserPrompt(query, evidenceTitles);

  // --- LLM: Gemini-primary, Qwen-fallback ---------------------------------
  let raw: string | null = null;
  let model: "gemini" | "qwen" | null = null;
  try {
    raw = await callGeminiDeepScan(userPrompt, tenantId);
    model = "gemini";
  } catch (geminiErr) {
    console.warn("[deep-scan] Gemini failed, trying Qwen:", (geminiErr as Error).message);
    try {
      // qwenGenerate logs its own llm_calls row (operation below).
      raw = await qwenGenerate(userPrompt, {
        system: SYSTEM_PROMPT,
        format: "json",
        temperature: 0.2,
        timeoutMs: QWEN_TIMEOUT_MS,
        operation: "deep_scan",
        tenantId,
      });
      model = "qwen";
    } catch (qwenErr) {
      console.warn("[deep-scan] Qwen also failed:", (qwenErr as Error).message);
      return { ...EMPTY_RESULT };
    }
  }

  const parsed = parseLlmJson(raw ?? "");
  if (!parsed) {
    console.warn(`[deep-scan] ${model} returned unparseable JSON. First 200: ${String(raw).slice(0, 200)}`);
    return { ...EMPTY_RESULT, model };
  }

  // --- Sub-searches: read-only corpus access only --------------------------
  // searchLocalCorpus never throws (returns empty result on failure), but the
  // belt-and-braces catch keeps a future regression from erroring the route.
  let perQueryPapers: Paper[][] = [];
  try {
    perQueryPapers = await Promise.all(
      parsed.subQueries.map(async (sq) => {
        try {
          const result = await searchLocalCorpus(sq, {
            limit: SUB_QUERY_LIMIT,
            threshold: SUB_QUERY_THRESHOLD,
          });
          return [...(result.papers ?? [])]
            .sort((a, b) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0))
            .slice(0, TOP_PER_SUB_QUERY);
        } catch (err) {
          console.warn(`[deep-scan] sub-search failed for "${sq.slice(0, 60)}":`, (err as Error).message);
          return [];
        }
      }),
    );
  } catch (err) {
    console.warn("[deep-scan] sub-search fan-out failed:", (err as Error).message);
    perQueryPapers = [];
  }

  // Dedup by paper id across sub-queries; keep the highest-similarity copy
  // (papers arrive sorted per sub-query, so first-seen is the best one).
  const seen = new Set<string>();
  const newPapers: Paper[] = [];
  for (const papers of perQueryPapers) {
    for (const p of papers) {
      const id = p?.id ? String(p.id) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newPapers.push(p);
    }
  }

  return { missing: parsed.missing, subQueries: parsed.subQueries, newPapers, model };
}
