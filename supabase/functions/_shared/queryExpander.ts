/**
 * supabase/functions/_shared/queryExpander.ts
 *
 * Gemini-powered query expansion for comprehensive retrieval.
 * Takes a natural-language policy question and generates 3-4 keyword-optimized
 * search variants + identifies meta-analysis terms.
 *
 * Falls back to a simple deterministic expansion if Gemini is unavailable.
 */

import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "./llmConfig.ts";

const GEMINI_BASE = GEMINI_API_BASE;
const EXPANSION_MODEL = DEFAULT_GEMINI_MODEL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpandedQuery {
  /** Original user query (unchanged) */
  original: string;
  /** 3-4 keyword-optimized search variants for APIs */
  variants: string[];
  /** Whether to boost meta-analyses/systematic reviews in results */
  boostMetaAnalyses: boolean;
  /** Expansion method used */
  method: "gemini" | "deterministic";
}

// ---------------------------------------------------------------------------
// Gemini expansion
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a search query optimizer for an academic evidence retrieval system used by economists at the Inter-American Development Bank.

Given a policy question, output a JSON object with:
- "variants": array of 3-4 SHORT keyword search strings (5-10 words each) optimized for academic paper databases (Semantic Scholar, OpenAlex, CrossRef). Each variant should approach the topic from a different angle:
  - Variant 1: Core concept with precise terminology (e.g., "conditional cash transfers school enrollment")
  - Variant 2: Broader framing or related mechanism (e.g., "social protection education outcomes developing countries")
  - Variant 3: Methodology-focused or specific intervention (e.g., "RCT cash transfer program attendance dropout")
  - Variant 4 (optional): Adjacent evidence or landmark framing (e.g., "Progresa Oportunidades Bolsa Familia education impact")
- "boostMetaAnalyses": true if the question would benefit from systematic reviews or meta-analyses

RULES:
- Each variant must be SHORT — academic search APIs work best with 5-10 keywords, not sentences
- Remove filler words (the, of, in, on, what, does, etc.)
- Include specific program names, country names, or author names when the query implies them
- Always include at least one variant without geographic restriction (global evidence is relevant)
- Do NOT repeat the same keywords across variants — maximize coverage
- Do NOT include methodology terms unless the user asked for a specific design

LAC LANGUAGE COVERAGE:
- If the query is about Latin America / the Caribbean / a specific LAC country, INCLUDE one variant in Spanish using local terminology (e.g. "transferencias monetarias condicionadas matrícula escolar" instead of "conditional cash transfers school enrollment"). Much LAC policy research is published in Spanish.
- If the query specifically mentions Brazil, also include one Portuguese variant.
- These language variants count toward the 3-4 variant total — don't go over 5.`;

const EXPANSION_SCHEMA = {
  type: "OBJECT" as const,
  properties: {
    variants: {
      type: "ARRAY" as const,
      items: { type: "STRING" as const },
      description: "3-4 keyword search variants, each 5-10 words",
    },
    boostMetaAnalyses: {
      type: "BOOLEAN" as const,
      description: "Whether to boost systematic reviews and meta-analyses",
    },
  },
  required: ["variants", "boostMetaAnalyses"],
};

export async function expandQuery(query: string): Promise<ExpandedQuery> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[query-expand] No GEMINI_API_KEY — using deterministic expansion");
    return deterministicExpand(query);
  }

  const url = `${GEMINI_BASE}/${EXPANSION_MODEL}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: query }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: EXPANSION_SCHEMA,
          temperature: 0.3,
          maxOutputTokens: 512,
          // Disable extended thinking on 2.5-flash. Thinking parts can split the
          // response across multiple "parts" (thought + text), which made our
          // parts[0].text reader return undefined and silently fall through to
          // deterministic expansion. Disabling keeps responses single-part and
          // faster (1-2s instead of 5-8s).
          thinkingConfig: { thinkingBudget: 1 },
        },
      }),
      signal: AbortSignal.timeout(15_000), // 15s — generous in case thinking enables
    });

    if (!response.ok) {
      console.error(`[query-expand] HTTP ${response.status}`);
      return deterministicExpand(query);
    }

    const payload = await response.json();
    // Iterate ALL parts and concatenate any text content. Defensive against
    // multi-part responses (e.g. thought parts mixed with text parts) where
    // parts[0]?.text alone returns undefined.
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((p: { text?: string }) => p?.text ?? "").join("").trim();
    if (!content) {
      const finishReason = payload.candidates?.[0]?.finishReason;
      console.error(`[query-expand] No text content in Gemini response. finishReason=${finishReason} parts=${parts.length}`);
      return deterministicExpand(query);
    }

    const parsed = JSON.parse(content);
    // Allow up to 5 variants (was 4) so LAC queries can include a Spanish
    // and/or Portuguese variant alongside the English angles.
    const variants = Array.isArray(parsed.variants) ? parsed.variants.slice(0, 5) : [];

    if (variants.length === 0) {
      return deterministicExpand(query);
    }

    console.log(`[query-expand] Gemini generated ${variants.length} variants: ${variants.map((v: string) => `"${v}"`).join(", ")}`);

    return {
      original: query,
      variants,
      boostMetaAnalyses: parsed.boostMetaAnalyses ?? false,
      method: "gemini",
    };
  } catch (err) {
    console.error("[query-expand] Error:", (err as Error).message);
    return deterministicExpand(query);
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no Gemini)
// ---------------------------------------------------------------------------

export function deterministicExpand(query: string): ExpandedQuery {
  // Aggressive stopword strip — keep only content-bearing tokens.
  const cleaned = query
    .toLowerCase()
    .replace(/[?!.,;:"']+/g, " ")
    .replace(
      /\b(what|does|do|is|are|the|of|in|on|for|to|a|an|how|can|could|would|should|say|says|about|with|from|by|as|that|this|these|those|will|may|might|high-quality|high|quality|evidence|study|studies|research|recent|new|paper|papers)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter((t) => t.length > 2);

  // Variant 1 — focused topic tokens only (no question framing)
  const variants: string[] = [];
  if (tokens.length > 0) variants.push(tokens.join(" "));

  // Variant 2 — same topic + "developing countries" framing for global hits.
  // Critical: keep the topic tokens; do NOT drop them.
  if (tokens.length >= 2) {
    variants.push(tokens.join(" ") + " developing countries");
  }

  // Variant 3 — topic + systematic-review framing. ALWAYS includes the topic
  // tokens. The previous version dropped the topic and just searched for
  // "systematic review meta-analysis", which polluted retrieval with cancer /
  // biomedical reviews regardless of subject.
  if (tokens.length >= 2) {
    variants.push(tokens.join(" ") + " systematic review");
  }

  // Decide whether to actually flag the meta-boost. Only enable when the
  // original query explicitly asks for review/synthesis-style output. Otherwise
  // the downstream re-ranker over-promotes systematic reviews.
  const asksForReview = /\b(systematic|meta[- ]?analysis|review|literature|synthesis)\b/i.test(query);

  console.log(`[query-expand] Deterministic: ${variants.length} variants, boostMeta=${asksForReview}`);

  return {
    original: query,
    variants: variants.length > 0 ? variants : [query],
    boostMetaAnalyses: asksForReview,
    method: "deterministic",
  };
}
