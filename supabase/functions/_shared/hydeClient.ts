/**
 * supabase/functions/_shared/hydeClient.ts
 *
 * HyDE (Hypothetical Document Embeddings) — given a user query, ask Qwen to
 * write a hypothetical paper abstract that would directly answer it. The
 * abstract uses natural academic terminology, so its embedding lands in the
 * same space as real paper abstracts in the corpus — closing the gap that
 * bag-of-tokens facet vectors leave open for sparse-intersection queries.
 *
 * Used as a parallel retrieval channel (not a facet) — see vectorSearch.ts
 * for how HyDE results union into the candidate pool while preserving real
 * per-facet similarity scores for the classifier.
 *
 * Behind ENABLE_HYDE flag. On any failure the caller falls back to no-HyDE
 * retrieval so search never breaks.
 */

import { qwenGenerate } from "./qwenClient.ts";

const HYDE_PROMPT_TEMPLATE = `Write a 120-180 word hypothetical abstract for an economics or social science paper that would directly answer this research query:

{QUERY}

Use natural academic terminology, likely variables, outcomes, mechanisms, and empirical framing. Do not invent author names, citations, journal names, or specific findings.`;

export interface HydeResult {
  /** Synthetic abstract text suitable for embedding. */
  text: string;
  /** Wall-clock generation time in ms (LLM call + parse). */
  generationMs: number;
}

export interface HydeOverride {
  /** When true, force-enable HyDE regardless of ENABLE_HYDE env var. */
  force?: boolean;
  /** When true, force-disable HyDE regardless of ENABLE_HYDE env var. */
  disable?: boolean;
}

/**
 * Generate a hypothetical abstract for the given query.
 *
 * Default is DISABLED (flipped 2026-05-11 after perf eval showed HyDE costs
 * 18–25s per query while producing the same candidate set on q01/q03 and
 * zero recall improvement on q02 — see evals/perf-log.md). Set
 * ENABLE_HYDE=true in env to re-enable globally; or set body.hyde=true
 * per-request to force-enable for an individual search.
 *
 * Returns null when:
 *   - override.disable === true
 *   - override.force !== true AND ENABLE_HYDE !== "true"
 *   - LLM_API_KEY missing (qwenGenerate throws)
 *   - Qwen returns empty content
 *   - Qwen call times out
 *
 * Caller should treat null as "fall back to no-HyDE retrieval."
 */
export async function generateHydeAbstract(
  query: string,
  override?: HydeOverride,
): Promise<HydeResult | null> {
  if (override?.disable === true) return null;
  // HyDE enabled by default (2026-05-21 eval: top-20 stable 20/20 on all queries,
  // -217ms avg latency gain, +7pp direct-LAC on broad geo queries, 0 regressions).
  // Override with ENABLE_HYDE=false to disable, or body.hyde=false per-request.
  if (override?.force !== true && readEnv("ENABLE_HYDE") === "false") return null;

  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const prompt = HYDE_PROMPT_TEMPLATE.replace("{QUERY}", trimmed);
  const start = Date.now();
  try {
    const text = await qwenGenerate(prompt, {
      temperature: 0.3,
      timeoutMs: 30_000,
    });
    const cleaned = text.trim();
    if (cleaned.length < 50) {
      console.warn(`[hyde] suspiciously short output (${cleaned.length} chars), skipping`);
      return null;
    }
    const generationMs = Date.now() - start;
    console.log(`[hyde] generated ${cleaned.length}-char abstract in ${generationMs}ms`);
    return { text: cleaned, generationMs };
  } catch (err) {
    console.error("[hyde] generation failed:", (err as Error).message);
    return null;
  }
}

function readEnv(name: string): string | undefined {
  if (typeof Deno !== "undefined") return Deno.env.get(name);
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
