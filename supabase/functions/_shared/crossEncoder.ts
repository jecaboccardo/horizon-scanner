/**
 * supabase/functions/_shared/crossEncoder.ts
 *
 * Qwen-as-judge cross-encoder reranker.
 *
 * After the composite-score rerank produces an evidence list, we ask Qwen
 * 2.5 (already running on the LiteLLM proxy) to score the top-N candidates
 * against the query on a 0-100 relevance scale. Papers are batched (default
 * 10/call) and batches run with bounded concurrency (default 5).
 *
 * Failure mode is graceful: on any error or timeout, we log a warning and
 * return papers unchanged. Callers assume this never throws.
 *
 * Flag-gated. Default off until eval validates. Do not enable in prod
 * without first running scripts/eval-cross-encoder.mjs.
 */

import { qwenGenerate } from "./qwenClient.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "./llmConfig.ts";
import { logLlmCall } from "./telemetry.ts";

type Paper = Record<string, any>;

export interface CrossEncoderOptions {
  topN?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Papers per Qwen call. Default 10. */
  batchSize?: number;
  /** Judge backend. "gemini" runs OFF the local GPU (no embed/chat contention → no
   *  15s timeouts under load). "qwen" = local (legacy). Default reads RB_JUDGE_BACKEND. */
  backend?: "qwen" | "gemini";
}

const DEFAULT_TOP_N = 50;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;
const ABSTRACT_CHAR_LIMIT = 600;

const SYSTEM_PROMPT =
  "You are a relevance scorer for a research-evidence retrieval system. Given a " +
  "research query and N candidate papers, score each on TWO dimensions:\n\n" +
  "1) score (0-100): how relevant is this paper as evidence on the query topic, " +
  "regardless of causal direction. 100 = strongly relevant evidence. 70 = on-topic. " +
  "40 = tangentially related. 10 = off-topic. Score reverse-direction studies " +
  "highly when they're rigorous evidence on the same relationship.\n\n" +
  "2) direction:\n" +
  "   - \"match\" = paper studies the causal direction the query asks about " +
  "(e.g., query: 'impact of X on Y'; paper studies X→Y).\n" +
  "   - \"reverse\" = paper studies the reverse direction (paper studies Y→X). " +
  "Still relevant evidence — score it on relevance, just tag direction as reverse.\n" +
  "   - \"tangential\" = paper is topically related but not on this specific " +
  "relationship (e.g., describes only one variable, or studies a different " +
  "outcome / different mechanism).\n\n" +
  "Return JSON only.";

interface ScoreResponse {
  scores?: Array<{
    idx?: number;
    score?: number;
    direction?: "match" | "reverse" | "tangential";
  }>;
}

interface ScoreEntry {
  score: number;
  direction: "match" | "reverse" | "tangential" | null;
}

function buildBatchPrompt(query: string, batch: Paper[]): string {
  const lines: string[] = [`QUERY: ${query}`, "", "PAPERS:"];
  batch.forEach((p, i) => {
    const title = (p.title ?? "").toString().slice(0, 300);
    const abstract = (p.abstract ?? "").toString().slice(0, ABSTRACT_CHAR_LIMIT);
    lines.push(`${i}. Title: ${title}`);
    lines.push(`   Abstract: ${abstract}`);
    lines.push("");
  });
  lines.push(
    `Return JSON: {"scores": [{"idx": 0, "score": <0-100>, "direction": "match"|"reverse"|"tangential"}, ...]}`,
  );
  return lines.join("\n");
}

/** Shared JSON→ScoreEntry[] parse (backend-agnostic). */
function parseScores(text: string, batchLen: number): ScoreEntry[] {
  let parsed: ScoreResponse;
  try {
    parsed = JSON.parse(text) as ScoreResponse;
  } catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(stripped) as ScoreResponse;
  }
  const out: ScoreEntry[] = new Array(batchLen).fill(null).map(() => ({ score: NaN, direction: null }));
  if (Array.isArray(parsed?.scores)) {
    for (const entry of parsed.scores) {
      const idx = typeof entry?.idx === "number" ? entry.idx : -1;
      const score = typeof entry?.score === "number" ? entry.score : NaN;
      const direction = entry?.direction === "match" || entry?.direction === "reverse" || entry?.direction === "tangential"
        ? entry.direction
        : null;
      if (idx >= 0 && idx < batchLen && Number.isFinite(score)) {
        out[idx] = { score: Math.max(0, Math.min(100, score)), direction };
      }
    }
  }
  return out;
}

/** Qwen (local GPU) scorer. */
async function scoreBatchQwen(query: string, batch: Paper[], timeoutMs: number): Promise<ScoreEntry[]> {
  const text = await qwenGenerate(buildBatchPrompt(query, batch), { system: SYSTEM_PROMPT, format: "json", temperature: 0.0, timeoutMs, operation: "band_judge" });
  return parseScores(text, batch.length);
}

/**
 * Gemini-Flash scorer — runs OFF the local GPU (no contention with embed/chat, which is
 * what times out the Qwen path under load). One generateContent call per batch, JSON,
 * thinkingBudget 0. Model: RB_JUDGE_GEMINI_MODEL or gemini-2.5-flash.
 */
async function scoreBatchGemini(query: string, batch: Paper[], timeoutMs: number): Promise<ScoreEntry[]> {
  // deno-lint-ignore no-explicit-any
  const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k]);
  const key = env("GEMINI_API_KEY");
  if (!key) throw new Error("scoreBatchGemini: no GEMINI_API_KEY");
  const model = env("RB_JUDGE_GEMINI_MODEL") || DEFAULT_GEMINI_MODEL;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const r = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${key}`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: buildBatchPrompt(query, batch) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 1 } },
      }),
    });
    if (!r.ok) throw new Error(`scoreBatchGemini: ${r.status}`);
    const j = await r.json();
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    logLlmCall({
      model,
      operation: "band_judge",
      tokensIn: j?.usageMetadata?.promptTokenCount,
      tokensOut: j?.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - startedAt,
      status: "ok",
    });
    return parseScores(text, batch.length);
  } catch (err) {
    const e = err as Error;
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    logLlmCall({
      model,
      operation: "band_judge",
      latencyMs: Date.now() - startedAt,
      status: isTimeout ? "timeout" : "error",
      error: e?.message?.slice(0, 200),
    });
    throw err;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Run bounded-concurrency batches, returning each batch's score array in order.
 */
async function runWithConcurrency<T>(
  jobs: Array<() => Promise<T>>,
  concurrency: number,
): Promise<Array<T | Error>> {
  const results = new Array<T | Error>(jobs.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      try {
        results[i] = await jobs[i]();
      } catch (err) {
        results[i] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Rerank `papers[0..topN]` by Qwen-judged relevance to the query.
 *
 * Returns a NEW array. The first topN entries are sorted by
 * crossEncoderScore desc (NaN treated as -Infinity, ties keep original
 * order). The remaining entries are unchanged.
 *
 * On any failure, returns the original array unchanged.
 */
export async function crossEncoderRerank(
  query: string,
  papers: Paper[],
  options: CrossEncoderOptions = {},
): Promise<Paper[]> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  // deno-lint-ignore no-explicit-any
  const envBackend = (typeof Deno !== "undefined" ? Deno.env.get("RB_JUDGE_BACKEND") : (globalThis as any).process?.env?.RB_JUDGE_BACKEND);
  const backend = options.backend ?? (envBackend === "gemini" ? "gemini" : "qwen");
  const scoreBatch = backend === "gemini" ? scoreBatchGemini : scoreBatchQwen;

  if (!Array.isArray(papers) || papers.length === 0) return papers;
  const sliceN = Math.min(topN, papers.length);
  const head = papers.slice(0, sliceN);
  const tail = papers.slice(sliceN);

  const startedAt = Date.now();
  try {
    const batches: Paper[][] = [];
    for (let i = 0; i < head.length; i += batchSize) {
      batches.push(head.slice(i, i + batchSize));
    }

    const jobs = batches.map((batch) => () => scoreBatch(query, batch, timeoutMs));
    const settled = await runWithConcurrency(jobs, concurrency);

    // Map scores back onto head papers (immutable copies).
    const scored: Array<Paper & { __cePos: number }> = head.map((p, idx) => ({
      ...p,
      __cePos: idx,
    }));

    let scoredCount = 0;
    let reverseCount = 0;
    let failedBatches = 0;
    for (let b = 0; b < batches.length; b++) {
      const result = settled[b];
      const offset = b * batchSize;
      if (result instanceof Error) {
        failedBatches++;
        console.warn(
          `[crossEncoder] batch ${b} failed: ${result.message.slice(0, 200)}`,
        );
        continue;
      }
      const entries = result;
      for (let j = 0; j < entries.length; j++) {
        const target = scored[offset + j];
        if (!target) continue;
        const entry = entries[j];
        if (Number.isFinite(entry.score)) {
          target.crossEncoderScore = entry.score;
          target.crossEncoderDirection = entry.direction;
          scoredCount++;

          // Direction → classification override: reverse-direction studies
          // (e.g., paper studies labor → DV when query asks DV → labor) get
          // demoted from direct-X to indirect, surfacing them in the Indirect
          // tier instead of either ranking-them-equal-with-direct (regression)
          // or hiding-them. Tangential papers stay as-classified by the gate.
          if (entry.direction === "reverse") {
            const orig = target.classification;
            if (orig === "direct-lac" || orig === "direct-global") {
              target.classification = "indirect";
              target.evidenceMatch = "indirect";
              target.crossEncoderDirectionOverride = orig;
              reverseCount++;
            }
          }
        }
      }
    }

    if (failedBatches === batches.length) {
      console.warn(
        `[crossEncoder] all ${batches.length} batches failed; returning papers unchanged`,
      );
      return papers;
    }

    // Sort: cluster by classification first (direct-lac → direct-global →
    // indirect), then by cross-encoder score within cluster. Reverse-direction
    // papers were demoted to indirect above so they rank below match-direction
    // direct papers but above tangential indirect papers.
    const CLASS_RANK: Record<string, number> = {
      "direct-lac": 0,
      "direct-global": 1,
      "indirect": 2,
      "excluded": 3,
    };
    scored.sort((a, b) => {
      const ca = CLASS_RANK[a.classification ?? "indirect"] ?? 99;
      const cb = CLASS_RANK[b.classification ?? "indirect"] ?? 99;
      if (ca !== cb) return ca - cb;
      const sa = typeof a.crossEncoderScore === "number" ? a.crossEncoderScore : -Infinity;
      const sb = typeof b.crossEncoderScore === "number" ? b.crossEncoderScore : -Infinity;
      if (sa !== sb) return sb - sa;
      return a.__cePos - b.__cePos;
    });

    // Strip the temp position field.
    const reordered = scored.map((p) => {
      const { __cePos: _drop, ...rest } = p;
      return rest as Paper;
    });

    const elapsed = Date.now() - startedAt;
    console.log(
      `[crossEncoder] reranked ${scoredCount}/${head.length} papers in ${elapsed}ms ` +
        `(${batches.length} batches, ${failedBatches} failed, ` +
        `${reverseCount} demoted direct→indirect by direction tag)`,
    );

    return [...reordered, ...tail];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[crossEncoder] unexpected failure, returning papers unchanged: ${msg}`);
    return papers;
  }
}
