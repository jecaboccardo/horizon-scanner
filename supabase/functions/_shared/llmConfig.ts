/**
 * Canonical LLM endpoint + model defaults.
 *
 * Single source of truth for the default base URL and model names, so a model
 * rename (e.g. the 2026-05-27 nomic-embed-text -> nomic-embed-text-vllm) is a
 * one-line change instead of a grep-the-codebase-and-miss-one. Each client still
 * reads its OWN env var (QWEN_MODEL, QWEN_SECTION_MODEL, GEMINI_JEL_MODEL,
 * OLLAMA_GENERATION_MODEL, ...); only the fallback default lives here.
 */
export const DEFAULT_LLM_BASE_URL = "https://llm.iotaimpact.com";
export const DEFAULT_QWEN_MODEL = "qwen2.5:14b-synthesis";
// 2026-07-09: the bare `gemini-2.5-flash` alias now 404s ("no longer available")
// on the Generative Language API — synthesis would silently fall back to the
// deterministic brief / Qwen. `gemini-flash-latest` is the callable, forward-
// compatible alias (currently a 2.5-Flash generation). Trade-off: "latest" can
// shift under us; if that becomes a problem, pin a dated version. Overridable via
// the GEMINI_MODEL env. Keep the pricing tables (index.ts MODEL_RATES +
// scripts/llm-cost-report.mjs) in sync with this string, else cost estimates → $0.
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
// qwen-768 cutover 2026-06-12: the corpus `embedding` column holds qwen3-embedding:8b
// vectors (@ dimensions=768), so the embedding model MUST be qwen — a nomic default
// here would embed queries/docs in nomic space and compare them against the qwen
// column (silent garbage). ollamaClient sends dimensions=768 for qwen models.
// (Rollback path keeps nomic vectors in works.embedding_nomic_old + revert this +
// OLLAMA_EMBEDDING_MODEL to `nomic-embed-text-vllm`.)
// 2026-06-17: moved to a DEDICATED GPU exposed as `qwen3-embedding:8b-app` (same
// proxy, same weights/768-dim space — just a separate instance from the 14b chat
// model so embeds and chat no longer evict each other on one GPU). The bare
// `qwen3-embedding:8b` still exists on the shared GPU; this app uses the -app alias.
export const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:8b-app";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Claude models offered for BYOK synthesis. Sonnet is the cheaper default.
export const CLAUDE_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = "claude-sonnet-4-6";
export const CLAUDE_API_BASE = "https://api.anthropic.com/v1/messages";
export const CLAUDE_API_VERSION = "2023-06-01";
