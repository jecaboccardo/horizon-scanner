/**
 * supabase/functions/_shared/ollamaClient.ts
 *
 * LiteLLM (OpenAI-compatible) client for embeddings and generation.
 * Despite the historical filename, this no longer talks to Ollama directly —
 * it goes through the LiteLLM proxy at LLM_BASE_URL using /v1/embeddings and
 * /v1/chat/completions. The proxy fronts Qwen + Nomic models served via Ollama
 * upstream, so model names are unchanged.
 *
 * Embeddings are qwen3-embedding:8b @ dimensions=768 (qwen-768 cutover 2026-06-12),
 * matching the `works.embedding vector(768)` column (now qwen vectors). `dimensions:768`
 * is sent only for qwen/MRL models (EMBED_DIMENSIONS_BY_MODEL); nomic was natively 768.
 *
 * Env overrides:
 *   LLM_BASE_URL            (default: https://llm.iotaimpact.com)
 *   LLM_API_KEY             (required — Bearer token)
 *   OLLAMA_EMBEDDING_MODEL  (default: qwen3-embedding:8b — see llmConfig.ts)
 *   OLLAMA_GENERATION_MODEL (default: qwen2.5:14b-synthesis)
 */

import { logLlmCall } from "./telemetry.ts";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_QWEN_MODEL,
  DEFAULT_EMBEDDING_MODEL as SHARED_EMBEDDING_MODEL,
} from "./llmConfig.ts";

const DEFAULT_BASE_URL = DEFAULT_LLM_BASE_URL;
// vLLM returns un-normalised vectors (L2≈20 not 1) but match_works uses pgvector's
// cosine `<=>` operator which normalises internally, so retrieval is unaffected.
// (Model name single-sourced in llmConfig.ts — see scripts/verify-embedding-compat.mjs.)
const DEFAULT_EMBEDDING_MODEL = SHARED_EMBEDDING_MODEL;
const DEFAULT_GENERATION_MODEL = DEFAULT_QWEN_MODEL;

function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(key) ?? undefined;
  }
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  return proc?.env?.[key];
}

export type EmbeddingTaskType = "query" | "document";

export interface OllamaClient {
  /**
   * Embed text. taskType controls Nomic-style prefixes ("search_query: " /
   * "search_document: ") so query and corpus vectors live in the same space.
   * Default is "document" — callers embedding queries MUST pass "query".
   */
  embedText: (text: string, taskType?: EmbeddingTaskType) => Promise<number[] | null>;
  embedBatch: (texts: string[], taskType?: EmbeddingTaskType) => Promise<(number[] | null)[]>;
  generate: (prompt: string, options?: GenerateOptions) => Promise<string | null>;
}

export interface GenerateOptions {
  temperature?: number;
  num_ctx?: number; // ignored — proxy uses model's configured context window
  timeout?: number;
}

/**
 * Nomic models are trained to require explicit task prefixes; without them,
 * query and document embeddings drift into different sub-spaces and cosine
 * similarity is degraded to near-random. Other model families (qwen3, etc.)
 * do not need this — they encode task implicitly.
 */
function applyTaskPrefix(
  model: string,
  texts: string[],
  taskType: EmbeddingTaskType,
): string[] {
  if (!model.toLowerCase().includes("nomic")) return texts;
  const prefix = taskType === "query" ? "search_query: " : "search_document: ";
  return texts.map((t) => prefix + t);
}

/**
 * Create a LiteLLM-backed client. Returns null if LLM_API_KEY is not set.
 */
export function createOllamaClient(): OllamaClient | null {
  const baseUrl = (readEnv("LLM_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = readEnv("LLM_API_KEY") || readEnv("OPENAI_API_KEY") || "";
  const embeddingModel = readEnv("OLLAMA_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL;
  const generationModel = readEnv("OLLAMA_GENERATION_MODEL") || DEFAULT_GENERATION_MODEL;

  if (!apiKey) {
    console.error("[llm-client] LLM_API_KEY not set — client disabled");
    return null;
  }

  const embeddingsUrl = `${baseUrl}/v1/embeddings`;
  const chatUrl = `${baseUrl}/v1/chat/completions`;

  return {
    async embedText(text: string, taskType: EmbeddingTaskType = "document"): Promise<number[] | null> {
      const prepared = applyTaskPrefix(embeddingModel, [text.slice(0, 4_000)], taskType);
      const r = await embedLiteLLM(embeddingsUrl, apiKey, embeddingModel, prepared);
      return r[0] ?? null;
    },

    async embedBatch(texts: string[], taskType: EmbeddingTaskType = "document"): Promise<(number[] | null)[]> {
      if (texts.length === 0) return [];
      const BATCH_LIMIT = 100;
      const results: (number[] | null)[] = [];
      for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
        const chunk = texts.slice(i, i + BATCH_LIMIT).map((t) => t.slice(0, 4_000));
        const prepared = applyTaskPrefix(embeddingModel, chunk, taskType);
        const batch = await embedLiteLLM(embeddingsUrl, apiKey, embeddingModel, prepared);
        results.push(...batch);
      }
      return results;
    },

    async generate(prompt: string, options?: GenerateOptions): Promise<string | null> {
      return generateLiteLLM(chatUrl, apiKey, generationModel, prompt, options ?? {});
    },
  };
}

// Matryoshka (MRL) embedding models — qwen3-embedding outputs 4096 dims natively
// but supports truncation to a requested `dimensions`. The corpus `embedding_qwen`
// column is vector(768) (pgvector HNSW caps at 2000 dims), and the re-embed wrote
// 768-dim vectors (scripts/reembed-qwen768.mjs `dimensions:768`), so the QUERY path
// MUST request the SAME 768 or the vector won't compare against the column. nomic is
// natively 768 and does NOT accept `dimensions` → only send it for MRL models, so
// the nomic path (and rollback = revert OLLAMA_EMBEDDING_MODEL) is byte-identical.
const EMBED_DIMENSIONS_BY_MODEL = (model: string): number | undefined =>
  /qwen3?-?embedding|qwen3:.*embedding|qwen.*embed/i.test(model) ? 768 : undefined;

// Embedding cold-start mitigation (2026-06-15). qwen3-embedding:8b is served by
// Ollama, which EVICTS idle models from VRAM (worsened by the co-resident 27B/14B
// chat models). A cold reload measured ~116s, far past the old 30s timeout → the
// query embed timed out → FTS-only fallback → 0 papers (intermittent prod-search
// outage since the nomic→qwen cutover; nomic was on vLLM = always resident).
// Two mitigations, applied ONLY to the MRL/qwen Ollama path so the nomic-on-vLLM
// rollback stays byte-identical:
//   - keep_alive: ask Ollama to keep the model resident between bursty searches.
//   - a longer timeout so a cold reload degrades to "slow" instead of "0 papers".
// Durable fix still belongs on the GPU host (OLLAMA_KEEP_ALIVE / VRAM headroom, or
// move the embedder to vLLM like nomic). Env-overridable.
const _embEnv = (k: string): string | undefined =>
  // deno-lint-ignore no-explicit-any
  (typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k]) ?? undefined;
const EMBED_TIMEOUT_MS = Number(_embEnv("EMBED_TIMEOUT_MS") ?? "120000");
const EMBED_KEEP_ALIVE = _embEnv("EMBED_KEEP_ALIVE") ?? "60m";

async function embedLiteLLM(
  url: string,
  apiKey: string,
  model: string,
  texts: string[],
): Promise<(number[] | null)[]> {
  const startedAt = Date.now();
  const dims = EMBED_DIMENSIONS_BY_MODEL(model);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // keep_alive only on the qwen/MRL Ollama path (dims set); nomic-on-vLLM is
      // always resident and the rollback path must stay byte-identical.
      body: JSON.stringify(dims ? { model, input: texts, dimensions: dims, keep_alive: EMBED_KEEP_ALIVE } : { model, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      console.error(`[llm-embed] HTTP ${response.status}: ${err.slice(0, 200)}`);
      logLlmCall({ model, operation: "embedding", latencyMs: Date.now() - startedAt, status: "error", error: `${response.status} ${err.slice(0, 200)}` });
      return texts.map(() => null);
    }

    const data = await response.json();
    if (!Array.isArray(data.data)) {
      console.error("[llm-embed] No data array in response");
      logLlmCall({ model, operation: "embedding", latencyMs: Date.now() - startedAt, status: "error", error: "no data array" });
      return texts.map(() => null);
    }
    logLlmCall({ model, operation: "embedding", latencyMs: Date.now() - startedAt, status: "ok" });

    // OpenAI shape: { data: [{ index, embedding: number[] }, ...] }
    // Order is by index, but defensively sort.
    const sorted = [...data.data].sort(
      (a: { index: number }, b: { index: number }) => a.index - b.index,
    );
    return sorted.map((item: { embedding: number[] }) =>
      Array.isArray(item.embedding) && item.embedding.length > 0 ? item.embedding : null,
    );
  } catch (err) {
    const e = err as Error;
    console.error("[llm-embed] Error:", e.message);
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    logLlmCall({ model, operation: "embedding", latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: e?.message?.slice(0, 200) });
    return texts.map(() => null);
  }
}

async function generateLiteLLM(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  options: GenerateOptions,
): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: options.temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(options.timeout ?? 60_000),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      console.error(`[llm-gen] HTTP ${response.status}: ${err.slice(0, 200)}`);
      logLlmCall({ model, operation: "ollama_generate", latencyMs: Date.now() - startedAt, status: "error", error: `${response.status} ${err.slice(0, 200)}` });
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    const usage = data?.usage ?? {};
    if (typeof text !== "string") {
      console.error("[llm-gen] No content in output");
      logLlmCall({ model, operation: "ollama_generate", latencyMs: Date.now() - startedAt, status: "error", error: "no content" });
      return null;
    }
    logLlmCall({
      model,
      operation: "ollama_generate",
      tokensIn: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      tokensOut: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
      latencyMs: Date.now() - startedAt,
      status: "ok",
    });
    return text;
  } catch (err) {
    const e = err as Error;
    console.error("[llm-gen] Error:", e.message);
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    logLlmCall({ model, operation: "ollama_generate", latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: e?.message?.slice(0, 200) });
    return null;
  }
}
