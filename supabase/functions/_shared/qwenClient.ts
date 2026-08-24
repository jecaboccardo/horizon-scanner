/**
 * supabase/functions/_shared/qwenClient.ts
 *
 * LiteLLM (OpenAI-compatible /v1/chat/completions) client for Qwen 2.5 7B.
 *
 * Env (Deno Deploy / Node both supported):
 *   LLM_BASE_URL   (default: https://llm.iotaimpact.com)
 *   LLM_API_KEY    (required — Bearer token for the proxy)
 *   QWEN_MODEL     (default: qwen2.5:14b-synthesis)
 *
 * Note: `numCtx` from the legacy Ollama path is not configurable per-request
 * in OpenAI shape; the proxy uses the model's configured context window.
 * The option is kept in QwenOptions for back-compat with callers but ignored.
 */

import { logLlmCall } from "./telemetry.ts";
import { DEFAULT_LLM_BASE_URL, DEFAULT_QWEN_MODEL } from "./llmConfig.ts";
import { qwenGate } from "./qwenGate.ts";

function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(key) ?? undefined;
  }
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[key];
}

const LLM_BASE_URL = readEnv("LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL;
const LLM_API_KEY = readEnv("LLM_API_KEY") ?? readEnv("OPENAI_API_KEY") ?? "";
const QWEN_MODEL = readEnv("QWEN_MODEL") ?? DEFAULT_QWEN_MODEL;
const CHAT_ENDPOINT = `${LLM_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;

export interface QwenOptions {
  system?: string;
  numCtx?: number; // ignored — kept for back-compat
  temperature?: number;
  format?: "json";
  keepAlive?: number; // ignored — proxy manages model lifecycle
  timeoutMs?: number;
  /** Telemetry label for this call, e.g. "query_expansion", "extraction". */
  operation?: string;
  /** Telemetry tenant attribution (optional). */
  tenantId?: string;
  /** Gate priority: true = background (JEL/topicality — yields to interactive
   *  work), false/undefined = interactive (search/chat — jumps the queue). */
  background?: boolean;
  /** Override the gate's acquire-wait ceiling (ms). Defaults per priority. */
  gateWaitMs?: number;
}

export async function qwenGenerate(prompt: string, opts: QwenOptions = {}): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error("LLM_API_KEY not configured (LiteLLM proxy requires Bearer auth)");
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model: QWEN_MODEL,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.1,
  };
  if (opts.format === "json") body.response_format = { type: "json_object" };

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const operation = opts.operation ?? "qwen_generate";

  // Acquire a GPU slot BEFORE starting the request clock, so queue wait never
  // eats the per-request timeout. Under normal load this returns immediately;
  // it only blocks when >MAX_CONCURRENCY calls are in flight (then we wait our
  // turn — no degradation). Rejects only if the wedged-GPU ceiling is hit.
  const gateEnteredAt = Date.now();
  let release: () => void;
  try {
    release = await qwenGate.acquire({ background: opts.background, waitMs: opts.gateWaitMs });
  } catch (gateErr) {
    logLlmCall({ model: QWEN_MODEL, operation, latencyMs: Date.now() - gateEnteredAt, status: "timeout", error: (gateErr as Error).message?.slice(0, 200), tenantId: opts.tenantId });
    throw gateErr;
  }
  const queuedMs = Date.now() - gateEnteredAt;
  if (queuedMs > 1500) console.log(`[qwen-gate] ${operation} waited ${queuedMs}ms for a slot (bg=${opts.background === true})`);

  const startedAt = Date.now();
  try {
    const res = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text();
      logLlmCall({ model: QWEN_MODEL, operation, latencyMs: Date.now() - startedAt, status: "error", error: `${res.status} ${errText.slice(0, 200)}`, tenantId: opts.tenantId });
      throw new Error(`LLM request failed: ${res.status} ${errText}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const usage = data?.usage ?? {};
    if (typeof content !== "string" || !content) {
      logLlmCall({ model: QWEN_MODEL, operation, latencyMs: Date.now() - startedAt, status: "error", error: "no content", tenantId: opts.tenantId });
      throw new Error(`LLM returned no content: ${JSON.stringify(data).slice(0, 200)}`);
    }
    logLlmCall({
      model: QWEN_MODEL,
      operation,
      tokensIn: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      tokensOut: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
      latencyMs: Date.now() - startedAt,
      status: "ok",
      tenantId: opts.tenantId,
    });
    return content;
  } catch (err) {
    const e = err as Error;
    // AbortSignal.timeout rejects with a TimeoutError / AbortError.
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out|aborted/i.test(e?.message ?? "");
    // Avoid double-logging the HTTP-error / no-content cases already logged above.
    if (!/^LLM (request failed|returned no content)/.test(e?.message ?? "")) {
      logLlmCall({ model: QWEN_MODEL, operation, latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: e?.message?.slice(0, 200), tenantId: opts.tenantId });
    }
    throw err;
  } finally {
    release();
  }
}

export async function qwenGenerateJSON<T>(
  prompt: string,
  opts: QwenOptions = {},
): Promise<T> {
  const text = await qwenGenerate(prompt, { ...opts, format: "json" });
  try {
    return JSON.parse(text) as T;
  } catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(stripped) as T;
  }
}
