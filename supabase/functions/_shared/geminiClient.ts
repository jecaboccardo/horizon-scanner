/**
 * supabase/functions/_shared/geminiClient.ts
 *
 * Brief synthesis client — Gemini primary (schema enforcement), Ollama fallback.
 * SYNTH-01: Gemini 2.5 Flash with generateContent REST API + JSON schema
 * SYNTH-02: Ollama (qwen2.5:14b-instruct) fallback when Gemini fails
 *
 * Gemini free tier limits: 15 RPM, 1,500 requests/day, 1M tokens/min.
 */

import { personaInstructions, DEFAULT_PERSONA, type PersonaId } from "./prompts.ts";
import { createOllamaClient } from "./ollamaClient.ts";
import { logLlmCall } from "./telemetry.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "./llmConfig.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvidenceRow {
  workId: string;
  title: string;
  sourceName: string;
  year: number | null;
  smsLevel: number | null;
  finding: string;
  authors?: string[];
  methodologyBadge?: string;
  causalStrength?: string;
  geography?: string[];
  /** Retrieval classification — rendered as the [DIRECT-LAC]/[DIRECT-GLOBAL]/[INDIRECT] tag. */
  evidenceMatch?: string;
}

interface CoverageStats {
  universeCount: number;
  retrievedCount: number;
  admissibleCount: number;
  evidenceCount: number;
  signalCount: number;
}

interface PromptInputs {
  queryPlanning?: string;
  synthesis?: string;
}

interface GenerateBriefParams {
  query: string;
  evidenceRows: EvidenceRow[];
  coverage: CoverageStats;
  promptInputs: PromptInputs;
  persona?: PersonaId;
}

interface ThreadTweet {
  text: string;
  role: "hook" | "context" | "finding" | "method" | "mechanism" | "caveat" | "so-what";
}

// deno-lint-ignore no-explicit-any
type BriefSections = Record<string, any>;

interface ChatParams {
  evidenceRows: EvidenceRow[];
  history: Array<{ role: 'user' | 'model'; content: string }>;
  question: string;
  onChunk: (text: string) => void;
  /**
   * Brief context injected to keep chat consistent with the brief shown to the
   * user. `strongestEvidence` is the deterministic "strongest paper" line from
   * the brief; chat must agree with it when asked about ranking/strongest.
   */
  briefContext?: {
    strongestEvidence?: string | null;
    methodologyNote?: string | null;
  };
}

interface GeminiClient {
  model: string;
  generateStructuredBrief: (params: GenerateBriefParams) => Promise<BriefSections | null>;
  streamChatResponse: (params: ChatParams) => Promise<string | null>;
  generateTwitterThread: (params: GenerateBriefParams) => Promise<ThreadTweet[] | null>;
  /**
   * After a chat turn completes, generate 2-3 short conversational follow-up
   * suggestions tailored to the conversation so far. Distinct from the brief's
   * research-agenda items — these are quick chat prompts (≤12 words each).
   */
  generateChatSuggestions: (params: {
    briefQuery: string;
    history: Array<{ role: 'user' | 'model'; content: string }>;
    avoid?: string[];
  }) => Promise<string[] | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_BASE = GEMINI_API_BASE;
const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

/**
 * Core synthesis rules shared across all personas (SYNTH-02).
 * Persona-specific voice/tone is appended per request. These rules are invariant.
 */
const CORE_RULES = `You are the Synthesis Agent for Horizon Scanner, an evidence-scanning tool for the Inter-American Development Bank (IADB).

RULES (apply to every persona):
1. Every factual claim MUST cite a specific paper by its workId in brackets, e.g. [ss:abc123]. Uncited claims are forbidden.
2. CITATION FORMAT IS STRICT: only the exact [workId] tokens that appear in the evidence list are valid. NEVER cite raw DOIs, URLs, journal names, or author-year tags as bracketed citations. The string [10.1093/qje/qjag003] is FORBIDDEN. The string [doi:10.xxx/yyy] is FORBIDDEN. The string [Smith 2024] is FORBIDDEN. If you do not have a valid workId for a claim, drop the bracketed tag entirely or omit the claim.
3. Never invent, fabricate, or hallucinate evidence. If no evidence supports a claim, say so explicitly.
4. Explain how trustworthy the evidence is using the language appropriate for the selected persona.
5. When evidence is conflicting, present both sides and explain why results may differ in the selected persona's register.
6. Be honest about gaps: if the evidence base is thin, say so. Do not overstate confidence.
7. The coverage card must reflect actual retrieval funnel numbers — do not round or estimate.
8. Follow-up questions should guide the reader toward specific knowledge gaps worth investigating.
9. Warnings should flag anything a reader would want to know before citing this brief.`;

export function buildSystemInstruction(persona?: PersonaId): string {
  const resolved: PersonaId =
    persona && personaInstructions[persona] ? persona : DEFAULT_PERSONA;
  return `${CORE_RULES}\n\n${personaInstructions[resolved]}`;
}

function buildTwitterSystemInstruction(): string {
  return `${CORE_RULES}\n\n${personaInstructions.twitter}\n\nOutput a 5-7 tweet thread as a JSON object {threadTweets: [{text, role}]}. Roles must be one of: hook, context, finding, method, mechanism, caveat, so-what. Each text stays under 200 characters. Every claim traces to a cited [workId] in the evidence list.`;
}

/**
 * Chat-specific system instruction for follow-up questions (Phase 5).
 */
export const CHAT_SYSTEM_INSTRUCTION = `You are the Follow-Up Agent for Horizon Scanner — a conversational research assistant for an IADB Knowledge Coordinator (senior economist) who has just generated an evidence brief and wants to dig deeper.

You have access to the FULL evidence table for this brief: title, authors, year, source, methodology design, SMS level (1 correlational → 5 RCT), causal strength, geography, and abstract. The full set is provided in the user message below, along with the brief's "strongest evidence" line and methodology note.

TWO-LANE RULE — read carefully, this is the core of how you answer:

LANE 1 — Paper-specific claims (findings, authors, results, rankings, comparisons, "what does paper X say", "which is strongest", "what evidence do we have for Y"):
  → ONLY use papers in the evidence table below. Do not introduce other studies, famous papers, or "the literature also shows…". If the table doesn't contain something, say so plainly: "Not in this brief's evidence — want a follow-up search?"
  → Cite every paper-specific claim as [workId] (e.g. [ss:abc123]). Only use workIds that appear in the evidence list.
  → Do not invent titles, authors, findings, sample sizes, or workIds.

LANE 2 — Concepts, definitions, methodology explanations, framing help (what is RDD, why SMS 5 > SMS 4, how to read causal strength, what "transferability" means, why this matters for IADB operations):
  → General knowledge is fine. No citations needed. Answer plainly and accurately.

If a question mixes lanes (e.g. "explain RDD and tell me which papers in the brief use it"), answer the concept from general knowledge, then switch to the table for the paper part.

CONSISTENCY WITH THE BRIEF (mandatory):
The brief shown to the user already contains a "strongest evidence" line and a methodology note — both are provided in the user message under "BRIEF CONTEXT". When the user asks "which paper is strongest", "rank by rigor", "best methodology", or any equivalent, your answer MUST be consistent with the brief's strongest-evidence line. Do not pick a different paper. If you would rank differently, defer to the brief — the user is reading both side by side.

RANKING METHOD (use this when the brief context is silent or absent):
  Tier 1 (strongest): SMS 5 — RCTs
  Tier 2: SMS 4 — DiD, IV, RDD
  Tier 3: SMS 3 — matching, panel FE
  Tier 4: SMS 2 — multivariate regression
  Tier 5 (weakest): SMS 1 — descriptive / correlational
Tie-break by relevance to the user's question, then year (newer first), then sample size. Name the top 1-3 with [workId], SMS level, methodology, and a one-sentence reason. If most evidence is SMS 1-2, say so honestly.

THIN-ABSTRACT HANDLING:
When the abstract is sparse but methodology / SMS / source are known, use those signals. Example: "Paper [ss:abc] is tagged as an RCT (SMS 5) but no abstract was retrieved — the design suggests credible causal estimates, but I can't speak to the intervention specifics."

FORMATTING — IMPORTANT:
Output PLAIN PROSE only. No markdown. No asterisks for bold or italic. No "*" or "-" bullets. No "1)" or "1." numbered lists. No "###" headers. Use short paragraphs and line breaks. The frontend renders text as-is, so any markdown syntax shows up literally as garbage characters.

TONE: Senior research colleague over coffee. Direct, expert, plainspoken. Treat the user as a peer. Don't reflexively summarize the brief; engage with the actual question.`;

/**
 * Build the user prompt for chat with evidence context.
 *
 * With asSplit=true, returns { prefix, suffix } where the prefix (brief context +
 * the full evidence block) is BYTE-IDENTICAL across every turn of the same brief,
 * and only the suffix (the question + grounding rules) varies. callSynthProvider
 * puts a Claude cache_control breakpoint after the prefix, so multi-turn chat pays
 * ~10% for the big evidence block on turns 2+ (within the 5-min cache TTL) instead
 * of full price every turn. The default (string) form is unchanged for the native
 * Gemini client, which relies on implicit prefix caching.
 */
export function buildChatUserPrompt(
  evidenceRows: EvidenceRow[],
  question: string,
  briefContext?: { strongestEvidence?: string | null; methodologyNote?: string | null },
): string;
export function buildChatUserPrompt(
  evidenceRows: EvidenceRow[],
  question: string,
  briefContext: { strongestEvidence?: string | null; methodologyNote?: string | null } | undefined,
  asSplit: true,
): { prefix: string; suffix: string };
export function buildChatUserPrompt(
  evidenceRows: EvidenceRow[],
  question: string,
  briefContext?: { strongestEvidence?: string | null; methodologyNote?: string | null },
  asSplit?: boolean,
): string | { prefix: string; suffix: string } {
  const evidenceContext = evidenceRows
    .map((row, i) => {
      const sms = row.smsLevel ?? "unclassified";
      const authors = row.authors && row.authors.length > 0
        ? `${row.authors.slice(0, 3).join(", ")}${row.authors.length > 3 ? " et al." : ""}`
        : "unknown authors";
      const method = row.methodologyBadge && row.methodologyBadge !== "Unclassified"
        ? row.methodologyBadge
        : null;
      const strength = row.causalStrength && row.causalStrength !== "signal"
        ? row.causalStrength
        : null;
      const geo = row.geography && row.geography.length > 0
        ? row.geography.slice(0, 3).join(", ")
        : null;

      const tags = [
        `SMS ${sms}`,
        method ? `design: ${method}` : null,
        strength ? `causal: ${strength}` : null,
        geo ? `geography: ${geo}` : null,
      ].filter(Boolean).join(" | ");

      // ~1500 chars of finding: enough to cover a full abstract
      const findingText = row.finding && row.finding.trim().length > 0
        ? row.finding.slice(0, 1500)
        : "(No abstract retrieved — use title + methodology + source to answer if possible.)";

      return `${i + 1}. [${row.workId}] "${row.title}" (${row.year}) — ${authors}\n   Source: ${row.sourceName} | ${tags}\n   Abstract: ${findingText}`;
    })
    .join("\n\n");

  const briefContextBlock = (() => {
    const parts: string[] = [];
    if (briefContext?.strongestEvidence) {
      parts.push(`Strongest evidence (from the brief — your ranking answers MUST be consistent with this): ${briefContext.strongestEvidence}`);
    }
    if (briefContext?.methodologyNote) {
      parts.push(`Methodology note (from the brief): ${briefContext.methodologyNote}`);
    }
    return parts.length > 0
      ? `BRIEF CONTEXT (already shown to the user — do not contradict):\n${parts.join("\n\n")}\n\n`
      : "";
  })();

  // PREFIX — stable across every turn of this brief (cacheable). SUFFIX — the
  // per-turn question + grounding rules.
  const prefix = `${briefContextBlock}EVIDENCE IN THIS BRIEF (${evidenceRows.length} papers — full set, not a sample):
${evidenceContext || "(No evidence papers in this brief.)"}`;
  const suffix = `

USER QUESTION: ${question}

GROUNDING RULES (HARD — violations will be auto-corrected):
1. Methodology, SMS level, year, and authors for any paper come ONLY from the tags shown above. Do NOT infer the design from the abstract. If the row says "design: DiD, SMS 4", state exactly that — never "this looks like an RCT" or "the methodology score should be 5 because…".
2. Findings about a specific paper come ONLY from that paper's Abstract field above. No invented effect sizes, countries, or sample sizes.
3. If a paper's design is "Unclassified" or SMS is missing, say "methodology not classified" — do NOT guess.
4. If asked about strongest/ranking, stay consistent with the brief context.
5. Apply the TWO-LANE RULE: paper-specific claims come ONLY from the evidence above (cite [workId]); concepts/definitions/methodology can use general knowledge ONLY when not tied to a specific paper.
6. Plain prose only — no markdown, no bullets.`;
  return asSplit ? { prefix, suffix } : `${prefix}${suffix}`;
}

/**
 * Coerce a value that should be a string[] but may contain objects.
 * gemini-2.5-flash sometimes ignores the `items: {type: STRING}` responseSchema
 * and returns `{ text, citation }` objects for summaryBullets — extract the text
 * so the brief stores plain strings (prevents "[object Object]" in the UI and
 * lets the downstream citation normalizer operate on strings).
 */
function coerceToStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        // Claude returns {body:} or {text:} or {content:} depending on the model/version
        if (typeof o.body === "string") return o.body;
        if (typeof o.text === "string") return o.text;
        if (typeof o.content === "string") return o.content;
      }
      return "";
    })
    .filter((s) => s.trim().length > 0);
}

/**
 * Normalize the string-array fields of a parsed brief so downstream code and
 * the frontend always receive string[], regardless of schema violations by the
 * model. Mutates and returns the same object.
 */
export function normalizeBriefSections(parsed: BriefSections | null): BriefSections | null {
  if (!parsed || typeof parsed !== "object") return parsed;
  const p = parsed as Record<string, unknown>;
  if ("summaryBullets" in p) p.summaryBullets = coerceToStringArray(p.summaryBullets);
  if ("followUpQuestions" in p) p.followUpQuestions = coerceToStringArray(p.followUpQuestions);
  if ("warnings" in p) p.warnings = coerceToStringArray(p.warnings);
  return parsed;
}

/**
 * Fallback: Generate brief via Ollama (qwen2.5:14b-instruct).
 * Extracts JSON from text response via regex.
 */
async function generateViaOllama(userPrompt: string, systemInstruction: string): Promise<BriefSections | null> {
  const client = createOllamaClient();
  if (!client) return null;

  try {
    const fullPrompt = `${systemInstruction}\n\nUser request:\n${userPrompt}\n\nRespond with ONLY valid JSON, no additional text.`;
    const response = await client.generate(fullPrompt, { temperature: 0.3, num_ctx: 4096, timeout: 60000 });

    if (!response) {
      console.error("[ollama-synth] No response from Ollama");
      return null;
    }

    // Extract JSON block from response (handle Ollama tendency to add extra text)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[ollama-synth] No JSON found in response");
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log("[synth-ollama] Brief generated successfully via Ollama fallback");
      return normalizeBriefSections(parsed);
    } catch (parseErr) {
      console.error("[ollama-synth] JSON parse failed:", (parseErr as Error).message);
      return null;
    }
  } catch (err) {
    console.error("[ollama-synth] Error:", (err as Error).message);
    return null;
  }
}

/**
 * Create a Gemini client for structured brief generation.
 * Returns null if no API key is configured.
 */
export function buildSuggestionsUserPrompt(
  briefQuery: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  avoid?: string[],
): string {
  const recentHistory = history.slice(-6);
  const transcript = recentHistory
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
    .join('\n');
  const avoidList = (avoid && avoid.length > 0)
    ? `\nAvoid suggesting these (already used): ${avoid.map((s) => `"${s}"`).join(', ')}`
    : '';
  return `Brief topic: "${briefQuery}"

Recent conversation:
${transcript || '(no messages yet)'}

Suggest exactly 3 short follow-up questions that help the user UNDERSTAND THE EXISTING CORPUS of retrieved papers — NOT explore new research areas or extrapolate beyond the evidence.

GOOD examples (corpus-grounded):
- "Which paper has the strongest causal identification?"
- "What contradicts the main finding?"
- "Which countries are best represented in the evidence?"
- "What sample sizes do the RCTs use?"
- "Which papers disagree on effect direction?"
- "Show me the papers from 2023 onwards"
- "Which study has the largest sample?"
- "Are there gender-disaggregated findings in the corpus?"

BAD examples (avoid — these are research-agenda items, not corpus exploration):
- "What are the policy implications for LAC?"  (extrapolation)
- "How might AI affect informal sector workers?"  (speculation)
- "What further research is needed?"  (research planning, belongs in §5)
- "How does this compare to OECD findings?"  (outside the corpus)

Each suggestion must be:
- ≤12 words
- A question (ends with ?)
- Answerable by examining the retrieved papers (counts, comparisons, methodology, sample, geography, year, contradictions WITHIN the set)
- Different angle from the most recent answer
- DO NOT repeat questions already asked${avoidList}

Return JSON only: {"suggestions": ["...", "...", "..."]}`;
}

export function createGeminiClient(opts?: { apiKey?: string; model?: string }): GeminiClient | null {
  const apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = opts?.model ?? (process.env.GEMINI_MODEL || DEFAULT_MODEL);

  return {
    model,

    /**
     * Generate a structured brief via Gemini generateContent (blocking).
     */
    async generateStructuredBrief({
      query,
      evidenceRows,
      coverage,
      promptInputs,
      persona,
    }: GenerateBriefParams): Promise<BriefSections | null> {
      const userPrompt = buildUserPrompt(
        query,
        evidenceRows,
        coverage,
        promptInputs
      );

      const body = {
        system_instruction: {
          parts: [{ text: buildSystemInstruction(persona) }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: BRIEF_SCHEMA,
          temperature: 0.3,
          // 8192 fits the default 50-paper brief (output rarely exceeds 6k). A
          // larger override set (load-more regenerate, up to 200 rows) cites
          // more papers and needs more room, or the JSON truncates → parse fail
          // → silent deterministic fallback. Scale with the row count, capped at
          // the model's 65536 ceiling. Watch logs for finishReason='MAX_TOKENS'.
          maxOutputTokens: Math.min(65536, Math.max(8192, evidenceRows.length * 220)),
          // Disable extended thinking on 2.5-* models. Thinking parts split
          // the response into multiple parts (thoughts vs text), and
          // parts[0]?.text would return undefined when parts[0] was a thought.
          // Thinking also eats the maxOutputTokens budget and was producing
          // partial JSON that satisfied "truthy" checks but missing fields,
          // causing the deterministic content to leak through merge.
          thinkingConfig: { thinkingBudget: 1 },
        },
      };

      const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(`[gemini] HTTP ${response.status}: ${text.slice(0, 200)}`);
          logLlmCall({ model, operation: "gemini_synthesis", latencyMs: Date.now() - startedAt, status: "error", error: `${response.status} ${text.slice(0, 200)}` });
          console.log("[synth] Attempting Ollama fallback after Gemini HTTP error...");
          return await generateViaOllama(userPrompt, buildSystemInstruction(persona));
        }
        const payload = await response.json();
        const um = payload?.usageMetadata;
        logLlmCall({
          model, operation: "gemini_synthesis", latencyMs: Date.now() - startedAt, status: "ok",
          tokensIn: typeof um?.promptTokenCount === "number" ? um.promptTokenCount : undefined,
          tokensOut: typeof um?.candidatesTokenCount === "number" ? um.candidatesTokenCount : undefined,
          // Gemini implicit context-cache hit (subset of promptTokenCount) → cache_read_tokens.
          cacheReadTokens: typeof um?.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : undefined,
          // Reasoning tokens (thinking models) — billed as output, not in candidatesTokenCount.
          thinkingTokens: typeof um?.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : undefined,
        });
        const finishReason = payload.candidates?.[0]?.finishReason;
        const blockReason = payload.promptFeedback?.blockReason;
        // Concatenate text from all parts. Defensive against multi-part
        // responses where parts[0]?.text would skip thought parts.
        const allParts = payload.candidates?.[0]?.content?.parts ?? [];
        const content = allParts
          .map((p: { text?: string }) => p?.text ?? "")
          .join("")
          .trim();
        if (!content) {
          console.error(
            `[gemini-synth] empty content. finish=${finishReason ?? "?"} block=${blockReason ?? "?"} parts=${allParts.length} raw=${JSON.stringify(payload).slice(0, 400)}`
          );
          return null;
        }

        try {
          return normalizeBriefSections(JSON.parse(content));
        } catch (parseErr) {
          console.error(
            `[gemini-synth] JSON parse failed. finish=${finishReason ?? "?"} contentLen=${content.length} contentTail=${JSON.stringify(content.slice(-200))} err=${(parseErr as Error).message}`
          );
          return null;
        }
      } catch (err) {
        const e = err as Error;
        console.error("[gemini-synth] Error:", e.message);
        const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        logLlmCall({ model, operation: "gemini_synthesis", latencyMs: Date.now() - startedAt, status: isTimeout ? "timeout" : "error", error: e?.message?.slice(0, 200) });
        // Fallback to Ollama if Gemini fails
        console.log("[synth] Attempting Ollama fallback...");
        return await generateViaOllama(userPrompt, buildSystemInstruction(persona));
      }
    },

    /**
     * Generate a 5-7 tweet thread for the Twitter persona.
     * Returns an array of {text, role} objects, or null on failure.
     */
    async generateTwitterThread({
      query,
      evidenceRows,
      coverage,
      promptInputs,
    }: GenerateBriefParams): Promise<ThreadTweet[] | null> {
      const userPrompt = buildUserPrompt(
        query,
        evidenceRows,
        coverage,
        promptInputs
      );

      const body = {
        system_instruction: {
          parts: [{ text: buildTwitterSystemInstruction() }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: THREAD_SCHEMA,
          temperature: 0.4,
          maxOutputTokens: 2048,
        },
      };

      const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(
            `[gemini-thread] HTTP ${response.status}: ${text.slice(0, 200)}`
          );
          return null;
        }

        const payload = await response.json();
        const content = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!content) return null;

        const parsed = JSON.parse(content);
        return Array.isArray(parsed?.threadTweets) ? parsed.threadTweets : null;
      } catch (err) {
        console.error("[gemini-thread] Error:", (err as Error).message);
        return null;
      }
    },

    /**
     * Stream a conversational chat response (Phase 5).
     * Multi-turn with plain text output — no JSON schema.
     */
    async streamChatResponse({
      evidenceRows,
      history,
      question,
      onChunk,
      briefContext,
    }: ChatParams): Promise<string | null> {
      const contents = [
        ...history.map(msg => ({
          role: msg.role,
          parts: [{ text: msg.content }],
        })),
        {
          role: "user" as const,
          parts: [{ text: buildChatUserPrompt(evidenceRows, question, briefContext) }],
        },
      ];

      // Ensure contents start with a user turn (Gemini requires it)
      if (contents.length === 0 || contents[0].role !== "user") {
        contents.unshift({
          role: "user" as const,
          parts: [{ text: "I have a follow-up question about this evidence brief." }],
        });
      }

      const body = {
        system_instruction: {
          parts: [{ text: CHAT_SYSTEM_INSTRUCTION }],
        },
        contents,
        generationConfig: {
          responseMimeType: "text/plain",
          temperature: 0.4,
          maxOutputTokens: 2048,
          // Disable built-in reasoning budget: gemini-2.5-flash otherwise
          // consumes output tokens on hidden "thinking" and returns no
          // visible text for short chat questions.
          thinkingConfig: { thinkingBudget: 1 },
        },
      };

      // Non-streaming chat: simpler + more robust than streamGenerateContent.
      // We still emit a single onChunk so the frontend typing UX works.
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

      const chatStartedAt = Date.now();
      try {
        console.log(`[gemini-chat] Sending ${contents.length} turns, evidence: ${evidenceRows.length} papers`);
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.error(`[gemini-chat] HTTP ${response.status}: ${text.slice(0, 500)}`);
          logLlmCall({ model, operation: "chat", latencyMs: Date.now() - chatStartedAt, status: "error", error: `${response.status} ${text.slice(0, 200)}` });
          throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        const payload = await response.json();

        // Collect text from ALL non-thought parts
        const parts = payload.candidates?.[0]?.content?.parts ?? [];
        if (parts.length > 1) {
          console.log(
            `[gemini-chat] multi-part response: parts=${parts.length} thoughtFlags=[${parts
              .map((p: any) => (p?.thought ? "T" : "F"))
              .join(",")}] lens=[${parts.map((p: any) => (p?.text ?? "").length).join(",")}]`
          );
        }
        let accumulated = "";
        for (const part of parts) {
          if (part?.thought) continue;
          const text = part?.text ?? "";
          if (text) accumulated += text;
        }

        // Dedup guard: Gemini occasionally returns the answer twice back-to-back.
        // If the string splits cleanly in half with (near-)identical halves, keep one.
        if (accumulated.length > 200) {
          const mid = Math.floor(accumulated.length / 2);
          const firstHalf = accumulated.slice(0, mid).trim();
          const secondHalf = accumulated.slice(mid).trim();
          if (firstHalf.length > 100 && firstHalf === secondHalf) {
            console.log(`[gemini-chat] exact duplicate halves detected — deduping from ${accumulated.length} to ${firstHalf.length} chars`);
            accumulated = firstHalf;
          }
        }

        if (!accumulated) {
          const finishReason = payload.candidates?.[0]?.finishReason;
          const blockReason = payload.promptFeedback?.blockReason;
          const safetyRatings = payload.candidates?.[0]?.safetyRatings;
          console.error(
            `[gemini-chat] empty response. finish=${finishReason ?? "?"} block=${blockReason ?? "?"} safety=${JSON.stringify(safetyRatings ?? []).slice(0, 200)} raw=${JSON.stringify(payload).slice(0, 500)}`
          );
          const reason = blockReason
            ? `safety block (${blockReason})`
            : finishReason === "MAX_TOKENS"
            ? "response hit max tokens before producing visible text"
            : finishReason === "SAFETY"
            ? "response blocked by safety filter"
            : finishReason && finishReason !== "STOP"
            ? `model stopped with reason: ${finishReason}`
            : "model produced no text (no candidates returned)";
          logLlmCall({ model, operation: "chat", latencyMs: Date.now() - chatStartedAt, status: "error", error: `empty — ${reason}` });
          throw new Error(`Gemini chat empty — ${reason}`);
        }

        logLlmCall({ model, operation: "chat", latencyMs: Date.now() - chatStartedAt, status: "ok" });
        // Emit the whole answer as one chunk for the frontend typing UX
        onChunk(accumulated);
        return accumulated;
      } catch (err) {
        const e = err as Error;
        console.error("[gemini-chat] Error:", e.message);
        // The HTTP-error and empty-response cases already logged above; only
        // log here for transport errors (timeout / network) not yet recorded.
        const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        if (!/^Gemini (HTTP|chat empty)/.test(e?.message ?? "")) {
          logLlmCall({ model, operation: "chat", latencyMs: Date.now() - chatStartedAt, status: isTimeout ? "timeout" : "error", error: e?.message?.slice(0, 200) });
        }
        throw err;
      }
    },

    async generateChatSuggestions({ briefQuery, history, avoid }) {
      // Quick non-streaming call. If anything goes wrong we return null and
      // the frontend falls back to a static evergreen list.
      const userPrompt = buildSuggestionsUserPrompt(briefQuery, history, avoid);

      const body = {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['suggestions'],
          },
          temperature: 0.7,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 1 },
        },
      };

      const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          console.error(`[gemini-suggest] HTTP ${response.status}: ${text.slice(0, 200)}`);
          return null;
        }
        const payload = await response.json();
        const parts = payload.candidates?.[0]?.content?.parts ?? [];
        let raw = '';
        for (const p of parts) {
          if (p?.thought) continue;
          if (p?.text) raw += p.text;
        }
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : null;
        if (!suggestions) return null;
        return suggestions
          .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
          .slice(0, 3);
      } catch (err) {
        console.error('[gemini-suggest] Error:', (err as Error).message);
        return null;
      }
    },
    // POLICY-ONLY: generateSectionParagraph (the multi-step Technical brief
    // section drafter) was removed 2026-06-03 with the technical brief register.
  };
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildUserPrompt(
  query: string,
  evidenceRows: EvidenceRow[],
  coverage: CoverageStats,
  promptInputs: PromptInputs
): string {
  // SINGLE evidence block (2026-07-06). Each line now also carries the design
  // and the retrieval classification tag — previously supplied by re-serializing
  // the whole evidence set 1-3 more times via the sourceScreening /
  // methodologyTagging / synthesis prompt families (full uncapped abstracts in
  // the latter), which roughly doubled brief input tokens for zero new signal.
  const evidenceSummary = evidenceRows
    .map((row, i) => {
      const sms = row.smsLevel ?? "unclassified";
      const design = row.methodologyBadge && row.methodologyBadge !== "Unclassified"
        ? `, ${row.methodologyBadge}`
        : "";
      const tag = row.evidenceMatch === "direct-lac" ? " [DIRECT-LAC]"
        : row.evidenceMatch === "direct-global" ? " [DIRECT-GLOBAL]"
        : row.evidenceMatch === "indirect" ? " [INDIRECT]"
        : "";
      return `${i + 1}. [${row.workId}] "${row.title}" (${row.year}) — ${row.sourceName}, SMS ${sms}${design}.${tag} Finding: ${row.finding?.slice(0, 300) || "Abstract not available."}`;
    })
    .join("\n");

  // Detect edge cases for explicit prompting
  const edgeCaseInstructions = buildEdgeCaseInstructions(
    evidenceRows,
    coverage
  );

  // Cap the citation-breadth floor at 40. At 0.65× an unbounded row count a
  // 200-paper regenerate (load-more override) demanded ~130 distinct citations,
  // which cannot fit in the output budget → truncated JSON → parse failure →
  // silent deterministic fallback. 40 distinct citations is already a very
  // broad brief; the output stays within maxOutputTokens.
  const minCitations = Math.min(evidenceRows.length, 40, Math.max(12, Math.floor(evidenceRows.length * 0.65)));

  return `Generate a structured evidence brief for the following policy question.

QUERY: ${query}

━━━ CITATION BREADTH RULES (READ BEFORE WRITING — FAILURE = INVALID BRIEF) ━━━
You have ${evidenceRows.length} papers. You MUST cite at least ${minCitations} DISTINCT [workId]s across the brief.
- EACH bullet in summaryBullets must cite at least 3 distinct [workId]s.
- EACH bullet must introduce at least 2 [workId]s NOT cited in any previous bullet. Cross-bullet repetition of the same workId is forbidden except when making a direct comparison.
- When multiple papers find the same result, group them: "Four RCTs [A][B][C][D] consistently find..." — do NOT collapse many papers into 1 citation.
- After drafting, count your unique [workId] tags. If fewer than ${minCitations}, you MUST revise — scan papers #${Math.floor(evidenceRows.length / 2)} onward and incorporate specific findings you have not yet cited.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EVIDENCE (${evidenceRows.length} papers):
${evidenceSummary || "(No evidence papers retrieved.)"}

COVERAGE FUNNEL:
- Universe estimate: ${coverage.universeCount?.toLocaleString() || "unavailable"}
- Retrieved: ${coverage.retrievedCount}
- Admissible: ${coverage.admissibleCount}
- Evidence: ${coverage.evidenceCount}
- Signals: ${coverage.signalCount}

${edgeCaseInstructions}

CONTEXT FROM RETRIEVAL PIPELINE:
${promptInputs.synthesis || ""}
${promptInputs.queryPlanning || ""}

Return the 5-section brief as JSON. Every summary bullet must cite at least 3 [workId]s. The methodology note must discuss the SMS distribution and causal limits. The coverage card must use the exact funnel numbers above.`;
}

// ---------------------------------------------------------------------------
// Edge case instructions for Gemini (SYNTH-05)
// ---------------------------------------------------------------------------

function buildEdgeCaseInstructions(
  evidenceRows: EvidenceRow[],
  coverage: CoverageStats
): string {
  const parts: string[] = [];

  // Zero results
  if (evidenceRows.length === 0) {
    const isUnderstudied = (coverage.universeCount || 0) < 50;
    parts.push("EDGE CASE — ZERO RESULTS:");
    if (isUnderstudied) {
      parts.push(
        "The universe count is very low. This topic appears understudied. Your summary should acknowledge the research gap, suggest adjacent topics, and avoid any unsupported claims. Do NOT fabricate evidence."
      );
    } else {
      parts.push(
        "Papers exist in the universe but none passed quality filters. This is likely a retrieval or filtering issue. Suggest relaxing thresholds and note what kinds of evidence might exist."
      );
    }
    return parts.join("\n");
  }

  // Mixed evidence quality
  const smsLevels = evidenceRows
    .map((r) => r.smsLevel)
    .filter((s): s is number => s != null);
  const strong = smsLevels.filter((s) => s >= 4).length;
  const weak = smsLevels.filter((s) => s <= 2).length;

  if (strong >= 1 && weak >= 1) {
    parts.push(
      `EDGE CASE — MIXED EVIDENCE QUALITY: ${strong} strong-design papers (SMS 4-5) and ${weak} correlational papers (SMS 1-2). Present findings from stronger designs first. When evidence conflicts, explain possible reasons (context, measurement, sample). Do NOT average across quality levels — weight toward stronger designs.`
    );
  }

  // Regional gap — check if no LAC terms in evidence
  const lacTerms =
    /\b(latin america|lac|caribbean|brazil|mexico|colombia|argentina|chile|peru|ecuador|bolivia)\b/i;
  const hasLac = evidenceRows.some(
    (r) => lacTerms.test(r.finding || "") || lacTerms.test(r.title || "")
  );
  if (!hasLac && evidenceRows.length >= 3) {
    parts.push(
      "EDGE CASE — REGIONAL GAP: No papers in this evidence set mention Latin America or the Caribbean. Acknowledge this gap explicitly. Note that external validity to LAC cannot be assumed. Suggest LAC-specific research as a follow-up."
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// ---------------------------------------------------------------------------
// JSON schema for Gemini structured output
// ---------------------------------------------------------------------------

const BRIEF_SCHEMA = {
  type: "OBJECT",
  properties: {
    abstractSummary: {
      type: "STRING",
      description: "A 3-4 sentence JEL-style abstract synthesizing the key finding, main mechanisms, and policy implication across all evidence. Cite the 2-3 most important [workId]s. Write like the opening paragraph of a Journal of Economic Literature review.",
    },
    summaryBullets: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Detailed findings expanding on the abstract. 5-7 bullets. " +
        "EACH ITEM MUST BE A PLAIN STRING — NOT an object. " +
        "Every string MUST begin with a bold thematic header, e.g. " +
        "'**The challenge:** prose prose.' or '**LAC evidence:** prose.' " +
        "Choose the header to fit the content — do NOT use fixed labels. " +
        "Each bullet cites at least 3 distinct [workId]s.",
    },
    methodologyNote: {
      type: "STRING",
      description:
        "Methods-mix breakdown as a SHORT MARKDOWN BULLET LIST. " +
        "EXACTLY this shape — one bullet per SMS tier present in the evidence, " +
        "plus one final caveat bullet. NO narrative prose. NO citation tags " +
        "(no [ss:...], no [oa:...], no [10.xxxx]) — citations belong in the " +
        "synthesis sections, not here. Each bullet ≤ 15 words. Example output:\n" +
        "- **SMS 5 (RCT):** 8 papers\n" +
        "- **SMS 4 (DiD / IV / RDD):** 12 papers\n" +
        "- **SMS 3 (matched obs., panel FE):** 24 papers\n" +
        "- **SMS 2 (cross-sectional):** 40 papers\n" +
        "- **SMS 1 (descriptive / qualitative):** 6 papers\n" +
        "- **Causal limits:** Strong RCT/QED evidence concentrated in Brazil; " +
        "Caribbean evidence is observational only.",
    },
    strongestEvidence: {
      type: "STRING",
      description: "2-3 sentence highlight of the single strongest piece of evidence. MUST include: (1) study name, authors, year; (2) the specific methodology used (e.g., 'randomized controlled trial', 'difference-in-differences with staggered adoption', 'synthetic control with 12 donor countries'), including sample size and identification strategy when available; (3) why this methodology produces credible causal claims (e.g., 'random assignment rules out selection bias'); (4) the headline finding. Do NOT just name the badge (RCT, DiD) — explain what was actually done.",
    },
    coverageCard: {
      type: "OBJECT",
      properties: {
        universeCount: { type: "NUMBER" },
        retrievedCount: { type: "NUMBER" },
        admissibleCount: { type: "NUMBER" },
        evidenceCount: { type: "NUMBER" },
        signalCount: { type: "NUMBER" },
        gapSummary: { type: "STRING" },
        regionalGap: { type: "STRING" },
        thinEvidenceAreas: { type: "STRING" },
        methodologicalGap: { type: "STRING" },
      },
      required: [
        "universeCount",
        "retrievedCount",
        "admissibleCount",
        "evidenceCount",
        "signalCount",
        "gapSummary",
        "regionalGap",
        "thinEvidenceAreas",
        "methodologicalGap",
      ],
    },
    followUpQuestions: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Suggested next queries to fill knowledge gaps. 2-4 questions.",
    },
    warnings: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Caveats a director should know before citing this brief.",
    },
  },
  required: [
    "abstractSummary",
    "summaryBullets",
    "methodologyNote",
    "strongestEvidence",
    "coverageCard",
    "followUpQuestions",
    "warnings",
  ],
};

const THREAD_SCHEMA = {
  type: "OBJECT",
  properties: {
    threadTweets: {
      type: "ARRAY",
      description: "5-7 tweets forming the thread, in order.",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "Tweet body, ~180 chars." },
          role: {
            type: "STRING",
            enum: [
              "hook",
              "context",
              "finding",
              "method",
              "mechanism",
              "caveat",
              "so-what",
            ],
          },
        },
        required: ["text", "role"],
      },
    },
  },
  required: ["threadTweets"],
};
