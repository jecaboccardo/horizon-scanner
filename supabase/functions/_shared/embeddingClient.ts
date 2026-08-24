/**
 * supabase/functions/_shared/embeddingClient.ts
 *
 * Embedding client wrapper — delegates to LiteLLM proxy at LLM_BASE_URL
 * (default https://llm.iotaimpact.com) via /v1/embeddings.
 *
 * Model: qwen3-embedding:8b @ dimensions=768 (qwen-768 cutover 2026-06-12) — matches
 * the corpus column `works.embedding vector(768)` (now qwen vectors) and the
 * match_works RPC. Set via OLLAMA_EMBEDDING_MODEL; default in llmConfig.ts.
 * (Pre-cutover this was nomic-embed-text-vllm; nomic vectors are preserved in
 * works.embedding_nomic_old for rollback.)
 */

import { createOllamaClient, type EmbeddingTaskType } from "./ollamaClient.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingClient {
  /**
   * Embed a single text (768 dims — qwen3-embedding:8b @ dimensions=768).
   * Pass taskType="query" for search queries and "document" (default) when storing vectors.
   * (Task prefixes are applied only for nomic models — see ollamaClient.applyTaskPrefix;
   * qwen needs none. Kept for the nomic rollback path.)
   */
  embedText: (text: string, taskType?: EmbeddingTaskType) => Promise<number[] | null>;
  /** Embed multiple texts in one API call. Returns array of vectors (null for failures). */
  embedBatch: (texts: string[], taskType?: EmbeddingTaskType) => Promise<(number[] | null)[]>;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create an embedding client using the LiteLLM proxy.
 * Connects to LLM_BASE_URL (default https://llm.iotaimpact.com).
 * Model is OLLAMA_EMBEDDING_MODEL (default qwen3-embedding:8b — see llmConfig.ts).
 */
export function createEmbeddingClient(): EmbeddingClient | null {
  const client = createOllamaClient();
  if (!client) {
    console.warn("[embedding] LLM client unavailable");
    return null;
  }

  return {
    async embedText(text: string, taskType: EmbeddingTaskType = "document"): Promise<number[] | null> {
      return client.embedText(text, taskType);
    },

    async embedBatch(texts: string[], taskType: EmbeddingTaskType = "document"): Promise<(number[] | null)[]> {
      return client.embedBatch(texts, taskType);
    },
  };
}

/**
 * Build the text to embed for a paper.
 * Concatenates title + abstract, truncated to 2,000 chars.
 */
export function buildEmbeddingText(title: string, abstract: string | null): string {
  const parts = [title];
  if (abstract) parts.push(abstract);
  return parts.join(" ").slice(0, 2_000);
}
