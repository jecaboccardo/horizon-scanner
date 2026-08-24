import { AsyncLocalStorage } from "node:async_hooks";
import { lenientJsonParse } from "./jsonParse.ts";
import { logLlmCall } from "./telemetry.ts";
import {
  GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
  CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, CLAUDE_API_BASE, CLAUDE_API_VERSION,
} from "./llmConfig.ts";
import { decryptSecret } from "./secretBox.ts";
import { qwenGenerateJSON } from "./qwenClient.ts";
import {
  createGeminiClient,
  buildSystemInstruction, buildUserPrompt,
  CHAT_SYSTEM_INSTRUCTION, buildChatUserPrompt,
  buildSuggestionsUserPrompt,
  normalizeBriefSections,
} from "./geminiClient.ts";

export type SynthProvider = "gemini" | "claude";

/** Per-request/per-job synthesis context. providerCfg null => use app-default Gemini. */
export interface SynthRequestCtx { providerCfg: ProviderConfig | null; tenantId?: string; }
export const synthCtxStore = new AsyncLocalStorage<SynthRequestCtx>();
/** The BYOK provider config bound to the current async branch, or null (app default). */
export function currentProviderCfg(): ProviderConfig | null {
  return synthCtxStore.getStore()?.providerCfg ?? null;
}

/** A fully-resolved, ready-to-call provider config (key already decrypted). */
export interface ProviderConfig {
  provider: SynthProvider;
  apiKey: string;
  model: string;
  /** True when this came from a BYOK grant (drives hard-error behavior upstream). */
  byok?: boolean;
  /** For telemetry attribution. */
  ownerId?: string | null;
  /** For telemetry attribution: the key this cfg resolved to. */
  keyId?: string | null;
  /** For telemetry attribution: the user whose request resolved this cfg. */
  userId?: string | null;
}

export interface CallOpts {
  maxTokens?: number;
  expectJson?: boolean;
  temperature?: number;
  op?: string;
  tenantId?: string;
  /** Per-call abort bound. Defaults to TIMEOUT_MS (120s). */
  timeoutMs?: number;
  /**
   * Per-call token usage callback (fires only on a successful call). tokensIn is
   * the TOTAL prompt tokens processed — for Claude that includes cache-creation
   * and cache-read tokens, matching Gemini's promptTokenCount semantics — so
   * per-paper rollups (JEL usageCtx) see the same number regardless of provider.
   */
  onUsage?: (u: { tokensIn: number; tokensOut: number }) => void;
}

/**
 * A user prompt split into a shared, per-job-stable PREFIX and a per-call
 * SUFFIX. Claude gets a cache_control breakpoint after the prefix block (90%
 * discount on cache reads across a JEL paper's ~7+ section calls); Gemini gets
 * the two joined — its implicit prefix caching picks up the byte-identical
 * prefix automatically. Callers that don't split keep passing a plain string.
 */
export interface SplitUserPrompt { prefix: string; suffix: string }
export function joinUserPrompt(user: string | SplitUserPrompt): string {
  return typeof user === "string" ? user : `${user.prefix}${user.suffix}`;
}

/** Validate + default raw admin input before storing. Throws on invalid input. */
export function normalizeProviderInput(input: { provider: string; apiKey: string; model?: string | null }):
  { provider: SynthProvider; apiKey: string; model: string } {
  const provider = input.provider as SynthProvider;
  if (provider !== "gemini" && provider !== "claude") {
    throw new Error("provider must be 'gemini' or 'claude'");
  }
  if (!input.apiKey || input.apiKey.trim().length < 8) {
    throw new Error("apiKey is required");
  }
  let model = (input.model || "").trim();
  if (provider === "claude") {
    if (!model) model = DEFAULT_CLAUDE_MODEL;
    if (!(CLAUDE_MODELS as readonly string[]).includes(model)) {
      throw new Error(`Claude model must be one of ${CLAUDE_MODELS.join(", ")}`);
    }
  } else {
    if (!model) model = DEFAULT_GEMINI_MODEL;
  }
  return { provider, apiKey: input.apiKey.trim(), model };
}

const TIMEOUT_MS = 120_000;

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/** Error carrying the upstream HTTP status, so callers can detect auth/quota (401/403/429). */
export class ProviderCallError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProviderCallError";
  }
  /** True for the "your key is bad/exhausted" class that must hard-error. */
  get isKeyFailure(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 429;
  }
}

/** Low-level dispatch to Gemini OR Claude. Returns parsed JSON (expectJson) or text. */
// deno-lint-ignore no-explicit-any
export async function callSynthProvider(system: string, user: string | SplitUserPrompt, opts: CallOpts, cfg: ProviderConfig): Promise<any> {
  const expectJson = opts.expectJson !== false;
  const maxTokens = opts.maxTokens ?? 8192;
  const temperature = opts.temperature ?? 0.4;
  const op = opts.op ?? `synth_${cfg.provider}`;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (cfg.provider === "claude") {
      // Split prompts get a cache_control breakpoint after the shared prefix:
      // everything up to and including that block (system + prefix) is cached
      // for ~5 min, so a JEL paper's sequential section calls pay ~10% for the
      // big shared evidence block instead of full price on every call. Prompts
      // under Anthropic's cache minimum are silently not cached — harmless.
      const userContent = typeof user === "string"
        ? user
        : [
            { type: "text", text: user.prefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: user.suffix },
          ];
      const r = await fetch(CLAUDE_API_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": CLAUDE_API_VERSION,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          temperature,
          system: expectJson ? `${system}\n\nReturn ONLY valid JSON, no prose, no code fences.` : system,
          messages: [{ role: "user", content: userContent }],
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        logLlmCall({ model: cfg.model, operation: op, latencyMs: Date.now() - startedAt, status: "error", error: `${r.status} ${txt.slice(0, 160)}`, tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
        throw new ProviderCallError(r.status, `Claude ${r.status}: ${txt.slice(0, 300)}`);
      }
      const data = await r.json();
      // Total prompt tokens processed = fresh input + cache writes + cache reads
      // (mirrors Gemini's promptTokenCount, which also includes cached tokens).
      const cu = data?.usage;
      const claudeCacheRead = cu?.cache_read_input_tokens ?? 0;
      const claudeCacheWrite = cu?.cache_creation_input_tokens ?? 0;
      const claudeTokensIn = (cu?.input_tokens ?? 0) + claudeCacheWrite + claudeCacheRead;
      const claudeTokensOut = cu?.output_tokens ?? 0;
      // deno-lint-ignore no-explicit-any
      const text: string = (data?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
      // Log AFTER text extraction — an HTTP 200 with no usable text must show
      // as an error in llm_calls, not "ok" (a misleading ok row hid a real
      // synthesis failure during the 2026-07-06 BYOK debugging).
      if (!text) {
        logLlmCall({ model: cfg.model, operation: op, tokensIn: claudeTokensIn, tokensOut: claudeTokensOut, cacheReadTokens: claudeCacheRead, cacheWriteTokens: claudeCacheWrite, latencyMs: Date.now() - startedAt, status: "error", error: `no text (stop_reason=${data?.stop_reason})`, tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
        throw new ProviderCallError(502, `Claude returned no text (stop_reason=${data?.stop_reason})`);
      }
      logLlmCall({ model: cfg.model, operation: op, tokensIn: claudeTokensIn, tokensOut: claudeTokensOut, cacheReadTokens: claudeCacheRead, cacheWriteTokens: claudeCacheWrite, latencyMs: Date.now() - startedAt, status: "ok", tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
      opts.onUsage?.({ tokensIn: claudeTokensIn, tokensOut: claudeTokensOut });
      return expectJson ? lenientJsonParse(stripFences(text)) : text;
    }

    // Gemini — split prompts are joined prefix-first; Gemini's implicit prefix
    // caching discounts the shared prefix automatically when calls repeat it.
    const url = `${GEMINI_API_BASE}/${cfg.model}:generateContent?key=${cfg.apiKey}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: joinUserPrompt(user) }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(expectJson ? { responseMimeType: "application/json" } : {}),
          // Same hardening as the native client (geminiClient.ts): flash
          // models think by default; thought parts split the response (so
          // parts[0] may be a thought, not the JSON) and thinking eats the
          // maxOutputTokens budget, truncating the JSON mid-object. Both
          // caused intermittent lenientJsonParse throws on BYOK Gemini.
          // Pro REJECTS thinkingBudget 0 ("only works in thinking mode" →
          // 400), so gate on flash — an unconditional 0 made every BYOK call
          // on a gemini-pro-* key hard-fail. Thought parts are filtered out
          // of the text below either way.
          ...(/flash/i.test(cfg.model) ? { thinkingConfig: { thinkingBudget: 1 } } : {}),
        },
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      logLlmCall({ model: cfg.model, operation: op, latencyMs: Date.now() - startedAt, status: "error", error: `${r.status} ${txt.slice(0, 160)}`, tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
      throw new ProviderCallError(r.status, `Gemini ${r.status}: ${txt.slice(0, 300)}`);
    }
    const data = await r.json();
    const um = data?.usageMetadata;
    // Join ALL non-thought parts — parts[0] alone drops text when the model
    // splits the answer, and skipping thought parts guards against any
    // thinking that slips through despite the near-zero thinkingBudget.
    // deno-lint-ignore no-explicit-any
    const text: string = (data?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => !p?.thought)
      .map((p: any) => p?.text ?? "")
      .join("");
    // Log AFTER text extraction — an HTTP 200 with no usable text must show
    // as an error in llm_calls, not "ok".
    if (!text) {
      logLlmCall({ model: cfg.model, operation: op, tokensIn: um?.promptTokenCount, tokensOut: um?.candidatesTokenCount, thinkingTokens: um?.thoughtsTokenCount, latencyMs: Date.now() - startedAt, status: "error", error: `no text (finishReason=${data?.candidates?.[0]?.finishReason})`, tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
      throw new ProviderCallError(502, `Gemini returned no text (finishReason=${data?.candidates?.[0]?.finishReason})`);
    }
    // Gemini implicit context-cache hit (part of promptTokenCount) → cache_read_tokens.
    // Thinking tokens (BYOK Pro thinks — can't be disabled) bill at the output
    // rate; log them or the cost report understates Pro papers ~3-4x.
    logLlmCall({ model: cfg.model, operation: op, tokensIn: um?.promptTokenCount, tokensOut: um?.candidatesTokenCount, cacheReadTokens: um?.cachedContentTokenCount, thinkingTokens: um?.thoughtsTokenCount, latencyMs: Date.now() - startedAt, status: "ok", tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
    opts.onUsage?.({ tokensIn: um?.promptTokenCount ?? 0, tokensOut: um?.candidatesTokenCount ?? 0 });
    return expectJson ? lenientJsonParse(text) : text;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logLlmCall({ model: cfg.model, operation: op, latencyMs: Date.now() - startedAt, status: "timeout", tenantId: opts.tenantId, userId: cfg.userId ?? undefined, keyId: cfg.keyId ?? undefined });
      throw new ProviderCallError(504, `${cfg.provider} call timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// deno-lint-ignore no-explicit-any
type Db = any; // supabase-js client (adminClient)

interface KeyRow { id: string; provider: SynthProvider; model: string | null; owner_user_id: string; enc_key: string; enc_iv: string; owner_self_use?: boolean; owner_self_model?: string | null; }
interface GrantRow { id: string; key_id: string; }

/** Pure: given a key row + grant row + decrypted key, produce a ProviderConfig or null. */
export function decideConfigFromRows(key: KeyRow | null, grant: GrantRow | null, decryptedKey: string, actingUserId: string | null = null): ProviderConfig | null {
  if (!key || !grant) return null;
  return {
    provider: key.provider,
    apiKey: decryptedKey,
    model: key.model || (key.provider === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL),
    byok: true,
    ownerId: key.owner_user_id,
    keyId: key.id,
    userId: actingUserId,
  };
}

/**
 * Resolve the provider config for a user: BYOK config if they hold an active
 * grant to an active key, else null (caller uses the app-default Gemini).
 * Throws ProviderCallError(503) if a grant exists but the key is gone/revoked.
 */
export async function resolveProviderConfig(db: Db, userId: string | null): Promise<ProviderConfig | null> {
  if (!userId) return null;
  // Owner auto-use: a user who OWNS an active key uses it without needing a grant —
  // UNLESS they've opted their OWN generations out (owner_self_use=false), in which
  // case they fall through to the app default while the team keeps using the key.
  // owner_self_model (same provider) lets the owner run a different model than the team.
  const { data: ownKeys } = await db
    .from("synthesis_keys").select("id, provider, model, owner_user_id, enc_key, enc_iv, owner_self_use, owner_self_model")
    .eq("owner_user_id", userId).is("revoked_at", null).eq("active", true)
    .order("created_at", { ascending: false }).limit(1);
  const ownKey = ownKeys?.[0];
  if (ownKey && ownKey.owner_self_use !== false) {
    const decrypted = await decryptSecret(ownKey.enc_key, ownKey.enc_iv);
    try { void db.from("synthesis_keys").update({ last_used_at: new Date().toISOString() }).eq("id", ownKey.id); } catch { /* ignore */ }
    const effectiveKey = ownKey.owner_self_model ? { ...ownKey, model: ownKey.owner_self_model } : ownKey;
    return decideConfigFromRows(effectiveKey as KeyRow, { id: "self", key_id: ownKey.id } as GrantRow, decrypted, userId);
  }
  // (owner with owner_self_use=false falls through → grant lookup → app default for self)
  const { data: grant } = await db
    .from("synthesis_grants").select("id, key_id")
    .eq("grantee_user_id", userId).is("revoked_at", null).maybeSingle();
  if (!grant) return null;
  const { data: key } = await db
    .from("synthesis_keys").select("id, provider, model, owner_user_id, enc_key, enc_iv, active, revoked_at")
    .eq("id", grant.key_id).is("revoked_at", null).eq("active", true).maybeSingle();
  if (!key) throw new ProviderCallError(503, "Synthesis key unavailable");
  const decrypted = await decryptSecret(key.enc_key, key.enc_iv);
  try { void db.from("synthesis_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id); } catch { /* ignore */ }
  return decideConfigFromRows(key as KeyRow, grant as GrantRow, decrypted, userId);
}

/** The GeminiClient-shaped surface used by briefs + chat. */
// deno-lint-ignore no-explicit-any
export interface SynthClient { model: string; byok: boolean; provider: SynthProvider;
  generateStructuredBrief: (p: any) => Promise<any>;
  streamChatResponse: (p: any) => Promise<string | null>;
  generateChatSuggestions: (p: any) => Promise<string[] | null>;
  /** Generic JSON call on the user's own provider. Only present on
   *  provider-backed (BYOK) clients — the app-default native Gemini client
   *  doesn't implement it, so callers (e.g. the chat verifier) fall back to
   *  Qwen when absent. Throws ProviderCallError on failure/timeout. */
  // deno-lint-ignore no-explicit-any
  generateJSON?: (prompt: string, opts?: { maxTokens?: number; temperature?: number; op?: string; timeoutMs?: number; tenantId?: string }) => Promise<any>;
}

/** Provider-backed SynthClient (Gemini OR Claude). Reuses the SAME prompt builders
 *  as the native Gemini client, and routes through callSynthProvider so a BYOK key
 *  failure THROWS ProviderCallError — never a silent app-Gemini/Ollama/deterministic
 *  fallback (which the NATIVE Gemini client would do, breaking the hard-error
 *  contract and leaking generation onto app infra). */
export function makeProviderClient(cfg: ProviderConfig): SynthClient {
  return {
    model: cfg.model, byok: cfg.byok === true, provider: cfg.provider,
    // deno-lint-ignore no-explicit-any
    async generateStructuredBrief(p: any) {
      const system = buildSystemInstruction(p.persona);
      const user = buildUserPrompt(p.query, p.evidenceRows, p.coverage, p.promptInputs);
      const raw = await callSynthProvider(system, user, { expectJson: true, maxTokens: 8192, op: "gemini_synthesis", tenantId: p?.tenantId }, cfg);
      return normalizeBriefSections(raw);
    },
    // deno-lint-ignore no-explicit-any
    async streamChatResponse(p: any) {
      // Split prompt → Claude caches the stable evidence prefix across turns of the
      // same brief (Gemini joins it and uses implicit prefix caching).
      const split = buildChatUserPrompt(p.evidenceRows, p.question, p.briefContext, true);
      // callSynthProvider is single-message, so prior turns are compacted into
      // the per-turn SUFFIX (after the cacheable evidence prefix — keeps the
      // cache breakpoint valid). Without this, BYOK chat dropped p.history
      // entirely and every follow-up ("what about the second one?") lost its
      // referent; the native Gemini client sends history as real turns.
      // deno-lint-ignore no-explicit-any
      const hist = (Array.isArray(p?.history) ? p.history : [])
        .map((m: any) => `${m?.role === "user" ? "User" : "Assistant"}: ${String(m?.content ?? "").slice(0, 2000)}`)
        .join("\n\n");
      const user = hist
        ? { prefix: split.prefix, suffix: `\n\nCONVERSATION SO FAR (for context — answer only the latest question):\n${hist}${split.suffix}` }
        : split;
      const text = await callSynthProvider(CHAT_SYSTEM_INSTRUCTION, user, { expectJson: false, maxTokens: 2048, op: "gemini_chat", tenantId: p?.tenantId }, cfg);
      if (typeof text === "string" && p?.onChunk) p.onChunk(text);
      return typeof text === "string" ? text : null;
    },
    // deno-lint-ignore no-explicit-any
    async generateChatSuggestions(p: any) {
      // Tiered off the (possibly Sonnet) BYOK key 2026-07-09: follow-up chips are
      // a throwaway sub-task, so run them on self-hosted Qwen (free, background
      // priority on the gate) instead of billing the user's provider. Soft-fails
      // to null on any error — suggestions are non-essential UX.
      try {
        const out = await qwenGenerateJSON<{ suggestions?: string[] } | string[]>(
          buildSuggestionsUserPrompt(p.briefQuery, p.history, p.avoid),
          { temperature: 0.4, timeoutMs: 20_000, operation: "chat_suggestions", tenantId: p?.tenantId, background: true },
        );
        return Array.isArray(out) ? out : Array.isArray((out as any)?.suggestions) ? (out as any).suggestions : null;
      } catch {
        return null;
      }
    },
    async generateJSON(prompt, opts = {}) {
      return await callSynthProvider("", prompt, {
        expectJson: true,
        maxTokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.1,
        op: opts.op ?? "provider_json",
        timeoutMs: opts.timeoutMs,
        tenantId: opts.tenantId,
      }, cfg);
    },
  };
}

/** Back-compat alias (kept for tests/imports that reference the Claude-specific name). */
export const makeClaudeClient = makeProviderClient;

/**
 * Resolve the SynthClient for a user. BYOK (Claude OR Gemini) → a provider client
 * that routes through callSynthProvider (so a bad/exhausted key HARD-ERRORS, never a
 * silent fallback); no grant → app-default native Gemini (may be null if no app key).
 * Throws ProviderCallError(503) if a grant exists but its key is gone.
 */
export async function resolveSynthClientForUser(db: Db, userId: string | null): Promise<SynthClient | null> {
  const cfg = await resolveProviderConfig(db, userId);
  if (!cfg) {
    const g = createGeminiClient();
    return g ? (Object.assign(g, { byok: false, provider: "gemini" as const }) as unknown as SynthClient) : null;
  }
  // BYOK — Claude and Gemini BOTH go through callSynthProvider so a key failure throws.
  return makeProviderClient(cfg);
}
