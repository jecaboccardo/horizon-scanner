// deno-lint-ignore-file no-explicit-any
/**
 * Grounded creative query planner for paper evidence expansion.
 *
 * "The model proposes, the database disposes." The planner (Gemini or Qwen)
 * emits search INTENT — sub-queries, named works, sub-literatures. Every
 * proposal is grounded against the corpus via searchLocalCorpus (read-only) and
 * named works are verified against stored authors/title/year. Anything that
 * does not resolve to a real corpus row evaporates — no fabricated paper can be
 * added. Additive ONLY: it proposes adds; the kill rules apply to its own
 * proposals, never to the channel-built base table.
 *
 * 🔒 GOLDEN RULE: never calls retrieveWorks, never upserts `works`.
 * Soft-fail: any LLM/search failure returns an empty expansion, never throws.
 */

import { searchLocalCorpus, cosineForIds } from "./vectorSearch.ts";
import { createEmbeddingClient } from "./embeddingClient.ts";
import { qwenGenerate } from "./qwenClient.ts";
import { logLlmCall } from "./telemetry.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "./llmConfig.ts";
import { callSynthProvider, currentProviderCfg } from "./synthesisProvider.ts";

export type PlannerKind = "gemini" | "qwen";

export type EvidenceType = "rct" | "quasi_experimental" | "meta_analysis" | "systematic_review" | "observational" | "theoretical" | "review";
export interface NamedWork { title?: string; description: string; author?: string; year?: number; evidence_type?: EvidenceType }
export interface CreativePlan { subQueries: string[]; namedWorks: NamedWork[]; literatures: string[]; model: PlannerKind | null }

export interface GroundedCandidate {
  id: string; title: string; authors: string[]; year: number | null;
  citationCount: number | null; smsLevel: number | null; venue: string | null;
  similarity: number; via: string;                 // "subq" | "lit" | "named"
  abstract?: string | null; publicationType?: string | null;
  tier: 'evidence' | 'context';
}
export interface PlannerAddedPaper extends GroundedCandidate { why: string }
export interface PlannerDroppedProposal { id?: string; label: string; reason: "evaporated" | "low_relevance" | "low_quality" | "low_quality_noise" | "already_in_table" | "duplicate" | "over_cap" }

export function surname(name: string): string {
  const parts = String(name ?? "").trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}
function tokens(s: string): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}
export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Strong corpus match for a named work: title overlap, or author + title/year. */
export function verifyAgainst(
  candidates: Array<{ id: string; title?: string; authors?: string[]; year?: number | null }>,
  w: NamedWork,
): { e: any; by: "title" | "author+title" | "author+year"; tj: number } | null {
  const want = surname(w.author ?? "");
  for (const e of candidates) {
    if (!e?.title) continue;
    const authorHit = !!want && Array.isArray(e.authors) && e.authors.some((a) => surname(a) === want || String(a).toLowerCase().includes(want));
    const tj = Math.max(w.title ? jaccard(w.title, e.title) : 0, jaccard(w.description, e.title));
    const yearHit = !!w.year && !!e.year && Math.abs(Number(w.year) - Number(e.year)) <= 1;
    if (tj >= 0.55) return { e, by: "title", tj: +tj.toFixed(2) };
    if (authorHit && tj >= 0.30) return { e, by: "author+title", tj: +tj.toFixed(2) };
    if (authorHit && yearHit && tj >= 0.20) return { e, by: "author+year", tj: +tj.toFixed(2) };
  }
  return null;
}

/**
 * A content-empty corpus row (no abstract AND no authors) is a stub — journal
 * apparatus, an editorial/award announcement, a references-list placeholder. These
 * can match a probe on title tokens and clear the relevance gate, but they carry
 * no evidence and must never enter the pool. (2026-06-16: caught a "Sherwin Rosen
 * Award" announcement + journal-apparatus stubs injected into a survey's evidence.)
 */
function isContentStub(c: GroundedCandidate): boolean {
  const hasAbstract = !!(c.abstract && String(c.abstract).trim().length >= 40);
  const hasAuthors = Array.isArray(c.authors) && c.authors.length > 0;
  return !hasAbstract && !hasAuthors;
}

/**
 * Apply the kill rules to grounded candidates and cap the net adds.
 * Kill = content-stub OR low relevance OR already in the base table OR duplicate.
 * Relevance MUST be the TRUE query·paper cosine (see rescoreByTrueQueryCosine) —
 * NOT the raw searchLocalCorpus probe similarity, which is cosine to the
 * sub-query / named-work probe text and lets off-topic-but-probe-similar papers
 * clear the gate. Named works that failed verification never reach here (they
 * were dropped as "evaporated" upstream).
 */
export function selectAdds(
  candidates: GroundedCandidate[],
  baseTableIds: Set<string>,
  cap: number,
  relThreshold: number,
): { added: GroundedCandidate[]; dropped: PlannerDroppedProposal[] } {
  const dropped: PlannerDroppedProposal[] = [];
  const seen = new Set<string>();
  const survivors: GroundedCandidate[] = [];

  for (const c of candidates) {
    if (baseTableIds.has(c.id)) {
      dropped.push({ id: c.id, label: c.title, reason: "already_in_table" }); continue;
    }
    if (seen.has(c.id)) {
      dropped.push({ id: c.id, label: c.title, reason: "duplicate" }); continue;
    }
    if (isContentStub(c)) {
      dropped.push({ id: c.id, label: c.title, reason: "low_quality" }); continue;
    }
    // Hard-drop uncited SMS:0 papers (narrative overviews with no scholarly traction)
    if (c.smsLevel === 0 && (c.citationCount ?? 0) < 20) {
      dropped.push({ id: c.id, label: c.title, reason: "low_quality_noise" }); continue;
    }
    if ((c.similarity ?? 0) < relThreshold) {
      dropped.push({ id: c.id, label: c.title, reason: "low_relevance" }); continue;
    }
    seen.add(c.id);
    // Assign tier: evidence = SMS 3+ (QE/RCT/meta-analysis), context = everything else
    const tier: "evidence" | "context" = (c.smsLevel != null && c.smsLevel >= 3)
      ? "evidence"
      : "context";
    survivors.push({ ...c, tier });
  }

  // Sort: evidence first, then context — within each tier by similarity desc
  survivors.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "evidence" ? -1 : 1;
    return (b.similarity ?? 0) - (a.similarity ?? 0);
  });

  const added = survivors.slice(0, cap);
  for (const c of survivors.slice(cap)) {
    dropped.push({ id: c.id, label: c.title, reason: "over_cap" });
  }
  return { added, dropped };
}

/**
 * Overwrite each candidate's `similarity` with the TRUE query·paper cosine
 * (query embedded once, compared to the candidate's stored corpus embedding via
 * the `cosine_for_ids` RPC). This is the relevance signal `selectAdds` must gate
 * on. Grounding probes return cosine to the SUB-QUERY / NAMED-WORK text (or 0 for
 * an FTS-only hit), so an off-topic paper that lexically matched a probe can clear
 * the gate; rescoring against the real user query removes that escape hatch and
 * makes the 0.50 threshold mean what the offline eval already measures.
 *
 * Soft-fail: if the query can't be embedded or the RPC returns nothing, the
 * candidates are returned UNCHANGED (keep probe similarity) so expansion still
 * works in a degraded environment — it just isn't precision-hardened.
 */
export async function rescoreByTrueQueryCosine(
  candidates: GroundedCandidate[],
  query: string,
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<GroundedCandidate[]> {
  if (!candidates.length || !query?.trim() || !client) return candidates;
  try {
    const embeddingClient = createEmbeddingClient();
    if (!embeddingClient) return candidates;
    const qvec = await embeddingClient.embedText(query, "query");
    if (!qvec) return candidates;
    const cos = await cosineForIds(client, qvec, candidates.map((c) => c.id));
    if (!cos.size) return candidates;
    // Any id the RPC didn't return (no stored embedding) → 0 so it fails the gate.
    return candidates.map((c) => ({ ...c, similarity: cos.has(c.id) ? cos.get(c.id)! : 0 }));
  } catch (e) {
    console.warn(`[creative-planner] true-cosine rescore failed: ${(e as Error).message}`);
    return candidates;
  }
}

// ---------------------------------------------------------------------------
// LLM planner + read-only grounding
// ---------------------------------------------------------------------------

function readEnv(key: string): string | undefined {
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") return denoEnv.get(key) ?? undefined;
  return (globalThis as any).process?.env?.[key];
}
const GEMINI_MODEL = readEnv("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;
const GEMINI_KEY = () => readEnv("GEMINI_API_KEY") ?? "";

const REL_THRESHOLD = Number(readEnv("PLANNER_REL_THRESHOLD") ?? "0.50");
export const PLANNER_REL_THRESHOLD = REL_THRESHOLD;
const SUB_QUERY_LIMIT = 80;
const TOP_PER_PROBE = 12;
const NAMED_PROBE_LIMIT = 10;
const QWEN_TIMEOUT_MS = 90_000;
const GEMINI_TIMEOUT_MS = 60_000;

const PLANNER_SYSTEM =
  `You are a senior development economist planning a rigorous evidence search. You know this field's canonical papers, competing theories, key authors, and adjacent literatures by name.\n` +
  `Do NOT answer the question and do NOT state facts — plan the most creative yet ON-TOPIC search, with a strong bias toward PRIMARY EMPIRICAL EVIDENCE.\n\n` +
  `OUTPUT STRICT JSON only:\n` +
  `{"subQueries":["3-7 rich academic sub-literature search phrases — favour phrases that retrieve RCTs, quasi-experimental designs, meta-analyses, and systematic reviews with causal identification"],` +
  `"namedWorks":[{"title":"exact paper title if known, else \\"\\"","description":"1-2 sentence abstract-style description of a SPECIFIC paper you believe exists","author":"primary author surname","year":2010,"evidence_type":"rct|quasi_experimental|meta_analysis|systematic_review|observational|theoretical|review"}],` +
  `"literatures":["2-5 named sub-fields or methodological literatures"]}\n\n` +
  `namedWorks rules:\n` +
  `- List 4-10 SPECIFIC studies. Generic topics are not studies.\n` +
  `- Prioritise: RCTs (evidence_type=rct), quasi-experimental designs (DiD/IV/RDD = quasi_experimental), meta-analyses (meta_analysis).\n` +
  `- Include at most 2 reviews or theoretical papers (evidence_type=review|theoretical) — label them honestly.\n` +
  `- It is fine to be wrong about the title — each is verified against our corpus and unmatched ones are dropped.`;

function buildPlannerUserPrompt(query: string, anchorTitles: string[]): string {
  const anchor = anchorTitles.slice(0, 50).map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `POLICY QUESTION: ${query}\n\nPapers we already have (do not re-list these — name what is MISSING):\n${anchor}`;
}

function parseJsonLoose(text: string): any | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

async function callGeminiPlanner(user: string, tenantId?: string): Promise<string> {
  const byokCfg = currentProviderCfg();
  if (byokCfg) {
    const out = await callSynthProvider(PLANNER_SYSTEM, user, { expectJson: false, maxTokens: 8192, op: "planner_gemini", temperature: 0.7, tenantId }, byokCfg);
    return typeof out === "string" ? out : JSON.stringify(out);
  }

  const key = GEMINI_KEY();
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const startedAt = Date.now();
  try {
    const r = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PLANNER_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 1 } },
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Gemini ${r.status}: ${txt.slice(0, 300)}`);
    }
    const j = await r.json();
    const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
    if (!text) {
      throw new Error(`Gemini returned no text. finishReason=${j?.candidates?.[0]?.finishReason}`);
    }
    // Fire-and-forget telemetry (logLlmCall never blocks, never throws).
    logLlmCall({
      model: GEMINI_MODEL,
      operation: "creative_planner",
      tokensIn: j?.usageMetadata?.promptTokenCount,
      tokensOut: j?.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - startedAt,
      status: "ok",
      tenantId,
    });
    return text;
  } catch (err) {
    const e = err as Error;
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    logLlmCall({
      model: GEMINI_MODEL,
      operation: "creative_planner",
      latencyMs: Date.now() - startedAt,
      status: isTimeout ? "timeout" : "error",
      error: e?.message?.slice(0, 200),
      tenantId,
    });
    throw err;
  }
}

function normalizePlan(parsed: any, model: PlannerKind | null): CreativePlan {
  const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
  const named: NamedWork[] = Array.isArray(parsed?.namedWorks)
    ? parsed.namedWorks.filter((w: any) => w && typeof w === "object").slice(0, 12) /* prompt asks 4-10; 12 is a defensive upper bound */.map((w: any) => ({
        title: typeof w.title === "string" ? w.title.trim() : "",
        description: typeof w.description === "string" ? w.description.trim() : "",
        author: typeof w.author === "string" ? w.author.trim() : "",
        year: Number(w.year) || undefined,
        evidence_type: typeof w.evidence_type === "string" ? w.evidence_type.trim() as EvidenceType : undefined,
      })) : [];
  return { subQueries: strs(parsed?.subQueries).slice(0, 8), namedWorks: named, literatures: strs(parsed?.literatures).slice(0, 6), model };
}

export async function planQuery(query: string, planner: PlannerKind, anchorTitles: string[], tenantId?: string): Promise<CreativePlan> {
  if (!query) return { subQueries: [], namedWorks: [], literatures: [], model: null };
  const user = buildPlannerUserPrompt(query, anchorTitles);
  try {
    if (planner === "gemini") {
      return normalizePlan(parseJsonLoose(await callGeminiPlanner(user, tenantId)), "gemini");
    }
    // qwenGenerate logs its own llm_calls row internally — no explicit logLlmCall needed here.
    const raw = await qwenGenerate(user, { system: PLANNER_SYSTEM, format: "json", temperature: 0.7, timeoutMs: QWEN_TIMEOUT_MS, operation: "creative_planner", tenantId });
    return normalizePlan(parseJsonLoose(raw), "qwen");
  } catch (e) {
    console.warn(`[creative-planner] ${planner} failed:`, (e as Error).message);
    return { subQueries: [], namedWorks: [], literatures: [], model: null };
  }
}

function mapPaper(p: any, via: string): GroundedCandidate {
  return {
    id: String(p.id), title: p.title ?? "", authors: Array.isArray(p.authors) ? p.authors : [],
    year: p.year ?? null, citationCount: p.citationCount ?? p.citation_count ?? null,
    smsLevel: p.sms_level ?? p.smsLevel ?? null, venue: p.venue ?? null,
    similarity: Number(p.similarity ?? 0), via,
    abstract: p.abstract ?? null, publicationType: p.publicationType ?? p.publication_type ?? null,
    tier: "context", // Default; will be reassigned in selectAdds
  };
}

/** Ground every proposal against the corpus. Read-only. Named works run a
 *  title probe + description probe and are kept only if verifyAgainst passes. */
export async function groundPlan(plan: CreativePlan): Promise<{ candidates: GroundedCandidate[]; evaporated: PlannerDroppedProposal[] }> {
  const byId = new Map<string, GroundedCandidate>();
  const add = (p: any, via: string) => {
    const c = mapPaper(p, via);
    if (!c.id) return;
    const prev = byId.get(c.id);
    if (!prev || c.similarity > prev.similarity) byId.set(c.id, { ...c, via: prev ? [...new Set([...prev.via.split("+"), via])].join("+") : via });
  };
  const runProbe = async (text: string, via: string, top = TOP_PER_PROBE) => {
    try {
      const res = await searchLocalCorpus(text, { limit: SUB_QUERY_LIMIT, threshold: REL_THRESHOLD });
      [...(res.papers ?? [])].sort((a: any, b: any) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0)).slice(0, top).forEach((p: any) => add(p, via));
    } catch (e) { console.warn(`[creative-planner] probe failed "${text.slice(0, 50)}":`, (e as Error).message); }
  };

  // BOUNDED-CONCURRENCY (2026-06-14): these probes were run SEQUENTIALLY — up to
  // 8 subQueries + 6 literatures + 12 namedWorks×2 = ~38 awaited searchLocalCorpus
  // calls (each an embedding call + vector query). On a loaded GPU/DB that stalled
  // the write-first auto-expand for 10-15 min BEFORE the outline, so the paper
  // looked stuck on "Planning…" until a deploy killed it. Run them in a small pool
  // (read-only; cap keeps the embedding proxy from being hammered — see the
  // 2026-05-27 high-concurrency Qwen incident). Order-independent: `add` dedups by
  // id keeping max similarity, and selectAdds sorts deterministically downstream.
  const PROBE_CONCURRENCY = 6;
  async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; await fn(items[idx]); }
      }),
    );
  }

  const probeTasks = [
    ...plan.subQueries.map((text) => ({ text, via: "subq" })),
    ...plan.literatures.map((text) => ({ text, via: "lit" })),
  ];
  await pool(probeTasks, PROBE_CONCURRENCY, (t) => runProbe(t.text, t.via));

  const evaporated: PlannerDroppedProposal[] = [];
  await pool(plan.namedWorks, PROBE_CONCURRENCY, async (w) => {
    const cands: any[] = [];
    if (w.title) { try { const r = await searchLocalCorpus(w.title, { limit: NAMED_PROBE_LIMIT, threshold: 0.30 }); cands.push(...(r.papers ?? [])); } catch { /* read-only soft-fail */ } }
    try { const r = await searchLocalCorpus(`${w.description} ${w.author ?? ""}`.trim(), { limit: NAMED_PROBE_LIMIT, threshold: 0.30 }); cands.push(...(r.papers ?? [])); } catch { /* soft-fail */ }
    const v = verifyAgainst(cands, w);
    if (v) add(v.e, "named");
    else evaporated.push({ label: `${w.author ?? "?"} ${w.year ?? ""}`.trim() || (w.title ?? "unknown"), reason: "evaporated" });
  });
  return { candidates: [...byId.values()], evaporated };
}
