/**
 * supabase/functions/_shared/telemetry.ts
 *
 * Phase 3 "Visibility" — fail-safe first-party telemetry.
 *
 * Two append-only tables in our OWN VPS Postgres:
 *   - llm_calls    one row per outbound LLM/embedding call
 *   - usage_events product-level events
 *
 * HARD CONSTRAINTS (do not weaken):
 *  1. FAIL-SAFE & ADDITIVE. Every logger is best-effort. If the insert fails
 *     (table missing, DB slow/down), we swallow the error and log to console
 *     only — a telemetry failure must NEVER break or slow the user request.
 *     Inserts are fire-and-forget: callers do NOT await the DB round-trip.
 *  2. PRIVACY BOUNDARY. Raw search query text MAY live in usage_events.payload
 *     (our own DB) but MUST be scrubbed from anything we send to external sinks
 *     (Sentry / PostHog). Use scrubForExternal() before any external emit.
 *
 * If the migration (20260603000001_telemetry.sql) has not been applied yet,
 * the tables don't exist; inserts fail and are swallowed — the app is unaffected.
 */

import { adminClient } from "./supabase.ts";
import { captureServerEvent, captureServerException } from "./sinks.ts";

// ---------------------------------------------------------------------------
// Cross-runtime env read (Deno prod + Node tooling)
// ---------------------------------------------------------------------------

function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(key) ?? undefined;
  }
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[key];
}

// Master kill switch — set TELEMETRY_DISABLED=true to no-op all logging.
function telemetryEnabled(): boolean {
  return readEnv("TELEMETRY_DISABLED") !== "true";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmCallStatus = "ok" | "error" | "timeout" | "fallback";

export interface LlmCallLog {
  model: string;
  operation: string; // brief_synthesis | query_expansion | embedding | chat | ...
  tokensIn?: number;
  tokensOut?: number;
  /** Cached-input tokens (subset of tokensIn). Claude cache_read_input_tokens
   *  (billed ~0.1x) OR Gemini cachedContentTokenCount (implicit cache, ~0.25x).
   *  llm-cost-report prices by model prefix. */
  cacheReadTokens?: number;
  /** Claude cache_creation_input_tokens — billed ~1.25x input. Part of tokensIn total.
   *  Claude only; Gemini implicit caching has no write charge. */
  cacheWriteTokens?: number;
  /** Gemini thinking-model reasoning tokens (usageMetadata.thoughtsTokenCount).
   *  Billed at the OUTPUT rate but NOT included in tokensOut (candidatesTokenCount).
   *  Priced by the cost report so Pro cost isn't understated. Null for non-thinking
   *  calls (flash budget 0, Qwen, embeddings, Claude). */
  thinkingTokens?: number;
  latencyMs: number;
  status: LlmCallStatus;
  error?: string;
  tenantId?: string;
  /** Internal-only attribution (BYOK): who made the call + which key. NEVER sent to external sinks. */
  userId?: string;
  keyId?: string;
}

export type UsageEventType =
  | "search_run"
  | "brief_generated"
  | "jel_paper"
  | "chat"
  | "export"
  | string;

/**
 * status conventions:
 *   - async actions emit a started -> completed/failed PAIR
 *   - sync actions emit a single 'completed' or 'failed'
 *   - 'ok' is accepted for backwards-compat with the original two events
 */
export type UsageEventStatus = "started" | "completed" | "failed" | "ok" | string;

export interface UsageEventLog {
  tenantId: string;
  userId?: string;
  eventType: UsageEventType;
  // deno-lint-ignore no-explicit-any
  payload?: Record<string, any>;
  latencyMs?: number;
  status?: UsageEventStatus;
  /** Failure reason when status==='failed'. Stored locally; scrubbed externally. */
  error?: string;
  /** Entity class the event acts on: brief | plan | paper | work | search_run | ... */
  targetType?: string;
  /** Id of the targeted entity. */
  targetId?: string;
}

// ---------------------------------------------------------------------------
// Privacy scrubbing for external sinks
// ---------------------------------------------------------------------------

/**
 * Keys whose values are raw user text and must never leave our infrastructure.
 * Anything matching (case-insensitive, substring) is dropped from the external
 * payload. Counts / channels / persona / latency / ids all pass through.
 */
const SENSITIVE_KEY_PATTERNS = [
  "query",
  "question",
  "prompt",
  "text",
  "instruction",
  "abstract",
  "title",
  "body",
  "content",
  "email",
  "answer",
  "message",
  "doi",
  "url",
  "paste",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Strip free-text / identifying fields from a payload before it is sent to an
 * external sink (Sentry, PostHog). Keeps only non-identifying, low-cardinality
 * props (event names, channels, persona, counts, latency). Recurses one level
 * into nested plain objects; arrays of primitives are kept as counts only.
 *
 * The ORIGINAL payload (with query text) is what we store in our own
 * usage_events table — scrubForExternal is applied ONLY on the external path.
 */
// deno-lint-ignore no-explicit-any
export function scrubForExternal(payload: Record<string, any> | null | undefined): Record<string, any> {
  if (!payload || typeof payload !== "object") return {};
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isSensitiveKey(key)) {
      // Drop the value, but keep a non-identifying length signal where useful.
      if (typeof value === "string") out[`${key}_len`] = value.length;
      continue;
    }
    if (value == null) {
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      // Non-sensitive strings are low-cardinality enums (persona, channel,
      // status). Cap length defensively so no free-text slips through.
      out[key] = value.length > 64 ? value.slice(0, 64) : value;
    } else if (Array.isArray(value)) {
      // Keep arrays of primitives (e.g. channel list); otherwise just the count.
      const allPrimitive = value.every(
        (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      );
      out[key] = allPrimitive ? value.slice(0, 20) : { count: value.length };
    } else if (typeof value === "object") {
      // Shallow recurse one level for nested non-sensitive objects (e.g. counts).
      // deno-lint-ignore no-explicit-any
      const nested: Record<string, any> = {};
      for (const [k2, v2] of Object.entries(value)) {
        if (isSensitiveKey(k2)) continue;
        if (v2 == null || typeof v2 === "number" || typeof v2 === "boolean") nested[k2] = v2;
        else if (typeof v2 === "string" && v2.length <= 64 && !isSensitiveKey(k2)) nested[k2] = v2;
      }
      out[key] = nested;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fail-safe insert helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget Postgres insert. NEVER throws, NEVER blocks the caller's
 * response: the promise is started and its rejection is caught internally. We
 * deliberately do not return the promise to discourage awaiting on the hot path.
 */
function safeInsert(table: string, row: Record<string, unknown>): void {
  if (!telemetryEnabled()) return;
  try {
    // adminClient.insert() returns a PostgrestBuilder (a thenable, not a real
    // Promise). Wrap in Promise.resolve() so .catch() is available, and do NOT
    // await — this is fire-and-forget so telemetry never blocks the response.
    void Promise.resolve(adminClient.from(table).insert(row))
      .then((res: { error: unknown } | undefined) => {
        if (res && res.error) {
          // Most common benign case: table doesn't exist yet (migration unrun).
          console.warn(`[telemetry] insert into ${table} failed (swallowed):`, String((res.error as { message?: string })?.message ?? res.error));
        }
      })
      .catch((err: unknown) => {
        console.warn(`[telemetry] insert into ${table} threw (swallowed):`, err instanceof Error ? err.message : String(err));
      });
  } catch (err) {
    // Synchronous failure (e.g. adminClient misconfigured) — swallow.
    console.warn(`[telemetry] safeInsert ${table} sync error (swallowed):`, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Public loggers
// ---------------------------------------------------------------------------

/**
 * Log one LLM / embedding call. Best-effort, non-blocking. Also mirrors a
 * scrubbed event to the external sink (PostHog) when keys are present.
 */
export function logLlmCall(log: LlmCallLog): void {
  safeInsert("llm_calls", {
    model: log.model,
    operation: log.operation,
    tokens_in: log.tokensIn ?? null,
    tokens_out: log.tokensOut ?? null,
    cache_read_tokens: log.cacheReadTokens ?? null,
    cache_write_tokens: log.cacheWriteTokens ?? null,
    thinking_tokens: log.thinkingTokens ?? null,
    latency_ms: Math.round(log.latencyMs),
    status: log.status,
    error: log.error ? String(log.error).slice(0, 1000) : null,
    tenant_id: log.tenantId ?? null,
    user_id: log.userId ?? null,
    key_id: log.keyId ?? null,
  });

  // External mirror (scrubbed — no prompt/response text ever leaves here).
  try {
    captureServerEvent("llm_call", scrubForExternal({
      model: log.model,
      operation: log.operation,
      status: log.status,
      latency_ms: Math.round(log.latencyMs),
      tokens_in: log.tokensIn,
      tokens_out: log.tokensOut,
    }), log.tenantId);
    // Surface error/timeout statuses to Sentry as captured messages.
    if (log.status === "error" || log.status === "timeout") {
      captureServerException(new Error(`llm ${log.operation} ${log.status}: ${log.error ?? "(no detail)"}`.slice(0, 300)), {
        operation: log.operation,
        model: log.model,
        status: log.status,
      });
    }
  } catch {
    // External sink failures are never fatal.
  }
}

/**
 * Log one product usage event. Best-effort, non-blocking. The raw payload
 * (which MAY include query text) is stored in our own DB; only the scrubbed
 * payload is sent to external sinks.
 */
export function logUsageEvent(log: UsageEventLog): void {
  safeInsert("usage_events", {
    tenant_id: log.tenantId,
    user_id: log.userId ?? null,
    event_type: log.eventType,
    payload: log.payload ?? {},
    latency_ms: log.latencyMs != null ? Math.round(log.latencyMs) : null,
    status: log.status ?? null,
    error: log.error ? String(log.error).slice(0, 1000) : null,
    target_type: log.targetType ?? null,
    target_id: log.targetId ?? null,
  });

  // External mirror — SCRUBBED. Privacy boundary: no query text to PostHog.
  // target_type/target_id/status/error pass through (ids + enums, non-PII).
  try {
    const scrubbed = scrubForExternal(log.payload);
    captureServerEvent(log.eventType, {
      ...scrubbed,
      latency_ms: log.latencyMs != null ? Math.round(log.latencyMs) : undefined,
      status: log.status,
      error: log.error ? String(log.error).slice(0, 300) : undefined,
      target_type: log.targetType,
      target_id: log.targetId,
    }, log.tenantId);
  } catch {
    // External sink failures are never fatal.
  }
}
