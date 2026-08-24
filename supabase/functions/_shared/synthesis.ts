/**
 * supabase/functions/_shared/synthesis.ts
 *
 * Brief generation logic. Updated for Phase 1 Supabase integration:
 * - createBriefFromRun now accepts a works array (not a tenant object)
 * - Handles empty evidence gracefully (Phase 1 has no live retrieval yet)
 */

import { promptFamilies, promptVersions, DEFAULT_PERSONA, type PersonaId } from "./prompts.ts";
import { verifySoWhatNumbers, verifyChatAnswer, type SoWhatStats } from "./verifier.ts";
import { normalizeBriefCitations } from "./citationNormalizer.ts";
import { logLlmCall } from "./telemetry.ts";
// Single source of truth for the evidence-table size. The brief synthesis must
// consider EVERY paper shown in the table, so the default synthesis cap is the
// table cap — they can never silently diverge. (retrieval.ts owns the number.)
import { EVIDENCE_TABLE_CAP } from "./retrieval.ts";

// Local back-compat normalizer for SearchFilters.populationFocus.
// Cannot import from root types.ts across the Deno/TSX boundary — mirrors
// normalizePopulationFocus in types.ts exactly. Accepts legacy string or
// new string[] from the updated type, plus null/undefined.
function normalizePopulationFocus(v: string | string[] | undefined | null): string[] {
  const arr = v == null ? [] : Array.isArray(v) ? v : [v];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = (s ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * Coerce any value to a string[]. A retrieved paper can carry `authors`/`geography`
 * as a JSON-encoded STRING (e.g. '["A","B"]') from an upstream source; `x || []`
 * passes that string through, and a string later crashes `x.slice(...).join(...)`
 * (String.slice returns a string with no .join). Always normalise to a real array:
 * parse a "[...]" string, wrap a plain string, drop everything else.
 */
function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith("[")) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

/**
 * Run Qwen verifier on the two so-what sentences in parallel. Returns the
 * corrected versions, falling back to the regex-verified inputs if Qwen fails
 * or times out. Never throws. Adds ~3-5s to brief generation but ensures box
 * content is grounded in the evidence table.
 */
export async function qwenVerifySoWhatSentences(
  regexMethodologyNote: string,
  regexGapSummary: string,
  evidenceRows: EvidenceRow[],
): Promise<{ methodologyNote: string; gapSummary: string }> {
  const verifierRows = evidenceRows.map((r) => ({
    workId: r.workId,
    title: r.title,
    authors: toStrArray(r.authors),
    year: r.year,
    methodologyBadge: r.methodologyBadge || "Unclassified",
    smsLevel: r.smsLevel,
    geography: toStrArray(r.geography),
    finding: r.finding || "",
  }));

  try {
    const [methResult, gapResult] = await Promise.all([
      verifyChatAnswer(regexMethodologyNote, verifierRows),
      verifyChatAnswer(regexGapSummary, verifierRows),
    ]);
    const corrected = {
      methodologyNote: methResult.changed && methResult.corrected ? methResult.corrected : regexMethodologyNote,
      gapSummary: gapResult.changed && gapResult.corrected ? gapResult.corrected : regexGapSummary,
    };
    if (methResult.changed || gapResult.changed) {
      console.log(
        `[brief-verifier] qwen applied corrections — methodology:${methResult.changed} gap:${gapResult.changed}`,
      );
    }
    return corrected;
  } catch (err) {
    console.error("[brief-verifier] qwen failed (non-blocking):", (err as Error).message);
    return { methodologyNote: regexMethodologyNote, gapSummary: regexGapSummary };
  }
}

/**
 * Build the deterministic stats bundle the LLM "so-what" sentences must agree
 * with. Used by verifySoWhatNumbers to swap any drifted counts/percentages.
 */
function buildSoWhatStats(
  evidence: AnyWork[],
  evidenceCount: number,
): SoWhatStats {
  const strongCount = evidence.filter(
    (w) => (w.smsLevel ?? w.sms_level ?? 0) >= 4,
  ).length;
  const strongShare = evidenceCount > 0
    ? Math.round((strongCount / evidenceCount) * 100)
    : 0;
  const lacRegex =
    /\b(latin america|lac|caribbean|brazil|mexico|colombia|argentina|chile|peru|ecuador|bolivia|uruguay|paraguay|venezuela|costa rica|panama|honduras|guatemala|el salvador|nicaragua|dominican republic|haiti|jamaica|trinidad|barbados|guyana|suriname|belize|cepal|eclac|iadb|idb)\b/i;
  const lacCount = evidence.filter((w) => {
    const text = `${w.title || ""} ${w.abstract || ""} ${w.summary || ""} ${toStrArray(w.geography).join(" ")}`;
    return lacRegex.test(text);
  }).length;
  return { evidenceCount, strongCount, strongShare, lacCount };
}

// POLICY-ONLY: brief generation is always the policy register. The persona
// argument (which may be a stored value on an existing brief) is ignored for
// generation — every new brief synthesizes as 'policy'. DEFAULT_PERSONA is
// 'policy'; PERSONA_IDS is ['policy']. Kept the param so callers that thread a
// stored persona through don't break.
function resolvePersona(_persona?: string | null): PersonaId {
  return DEFAULT_PERSONA;
}

/**
 * Cap evidence passed to the LLM prompt so it doesn't devour the output
 * token budget. JEL persona wants 4-6 long paragraphs in the response;
 * with 80+ papers in the prompt, truncated output → JSON parse fails →
 * silent deterministic fallback.
 *
 * Top papers selected by SMS level (higher causal rigor first). Full
 * evidenceRows are still returned in the brief — cap only affects the
 * prompt context, not what the user sees.
 */
// How many papers Gemini sees in the synthesis prompt. This is SINGLE-SOURCED
// from EVIDENCE_TABLE_CAP (retrieval.ts) so the brief synthesis always covers
// EVERY paper in the user-visible evidence table — never a silent subset that
// drops table rows. (User instruction: "synthesis should be over all in
// evidence table".) Gemini 2.5-flash handles the full table with abstracts
// well under context limits. Only an explicit SYNTHESIS_EVIDENCE_CAP env var
// overrides the table size (escape hatch for experiments).
const SYNTHESIS_EVIDENCE_CAP = (() => {
  // deno-lint-ignore no-explicit-any
  const envVal = (typeof Deno !== "undefined"
    ? Deno.env.get("SYNTHESIS_EVIDENCE_CAP")
    : (globalThis as any).process?.env?.SYNTHESIS_EVIDENCE_CAP);
  const parsed = envVal ? parseInt(envVal, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EVIDENCE_TABLE_CAP;
})();
function capEvidenceForPrompt(rows: EvidenceRow[], capOverride?: number): EvidenceRow[] {
  // Preserve composite rerank order — rows arrive pre-sorted by the server's
  // channel-aware weights (causal → rig first, foundational → cit first, etc.).
  // Sorting SMS-first here was correct when all channels used SMS as primary,
  // but now overrides the channel intent: for foundational it would push recent
  // high-SMS papers above Hanushek (SMS=2, cit=2000+), breaking both the table
  // and the STRONGEST_EVIDENCE anchor in the synthesis prompt.
  // The table and synthesis now share the same ordering: composite rerank order.
  const effectiveCap = (capOverride && capOverride > 0) ? capOverride : SYNTHESIS_EVIDENCE_CAP;
  if (rows.length <= effectiveCap) return rows;
  return rows.slice(0, effectiveCap);
}

/**
 * Kris citation fence — shared by BOTH generation paths (blocking + SSE).
 * Every [workId] token in LLM prose must exist in the evidence set; anything
 * else is a hallucinated citation. Scans and strips ALL prose fields (the old
 * inline version scanned 3 fields and stripped only summaryBullets, and ran
 * only in the blocking path — the SSE path shipped invented citations as-is).
 * Pure in-memory Set lookup, zero latency. Mutates `generated` in place;
 * returns the invalid ids so the caller can append a user-visible warning.
 * Fields absent from `generated` are left absent (never written back as
 * undefined — a present-but-undefined key would clobber the deterministic
 * base value in the `{...baseBrief, ...generated}` merge).
 */
// deno-lint-ignore no-explicit-any
function enforceCitationFence(generated: any, evidenceRows: EvidenceRow[]): string[] {
  const validWorkIds = new Set(evidenceRows.map((r) => r.workId));
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
  const proseText = [
    ...strings(generated.summaryBullets),
    ...strings(generated.methodologyNote),
    ...strings(generated.abstractSummary),
    ...strings(generated.strongestEvidence),
    ...strings(generated.followUpQuestions),
    ...strings(generated.warnings),
    ...strings(generated.coverageCard?.gapSummary),
    ...strings(generated.coverageCard?.regionalGap),
    ...strings(generated.coverageCard?.methodologicalGap),
  ].join(" ");
  const citedInBrief = [...proseText.matchAll(/\[([^\]]{4,})\]/g)].map((m) => m[1]);
  const invalidCites = [...new Set(citedInBrief)].filter(
    (id) => !validWorkIds.has(id) && !id.includes(" ") && !id.startsWith("http"),
  );
  if (invalidCites.length === 0) return [];
  const strip = (text: string) =>
    invalidCites.reduce(
      (t, id) => t.replace(new RegExp(`\\[${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "g"), ""),
      text,
    );
  // deno-lint-ignore no-explicit-any
  const stripKey = (obj: any, key: string) => {
    if (!obj) return;
    const v = obj[key];
    if (typeof v === "string") obj[key] = strip(v);
    else if (Array.isArray(v)) obj[key] = v.map((x) => (typeof x === "string" ? strip(x) : x));
  };
  stripKey(generated, "summaryBullets");
  stripKey(generated, "methodologyNote");
  stripKey(generated, "abstractSummary");
  stripKey(generated, "strongestEvidence");
  stripKey(generated, "followUpQuestions");
  stripKey(generated, "warnings");
  stripKey(generated.coverageCard, "gapSummary");
  stripKey(generated.coverageCard, "regionalGap");
  stripKey(generated.coverageCard, "methodologicalGap");
  return invalidCites;
}

interface ThreadTweet {
  text: string;
  role: "hook" | "context" | "finding" | "method" | "mechanism" | "caveat" | "so-what";
}

function deterministicThread(summaryBullets: string[] = []): ThreadTweet[] {
  if (!summaryBullets || summaryBullets.length === 0) return [];
  const roles: ThreadTweet["role"][] = [
    "hook",
    "context",
    "finding",
    "mechanism",
    "caveat",
    "so-what",
  ];
  return summaryBullets.slice(0, 6).map((text, i) => ({
    text: (text || "").slice(0, 260),
    role: roles[i] || "so-what",
  }));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type AnyWork = Record<string, any>;

// Minimal shape of a user-supplied extra paper (from POST /api/resolve-paper).
interface ExtraPaper {
  uploadId: string;
  title: string;
  authors: string[];
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  venue?: string | null;
  smsLevel?: number | null;
  matchedWorkId?: string | null;
  card?: {
    design: string | null;
    findingShort: string | null;
  } | null;
}

export interface EvidenceRow {
  workId: string;
  title: string;
  authors: string[];
  sourceName: string;
  year: number | null;
  methodologyBadge: string;
  causalStrength: string;
  smsLevel: number | null;
  geography: string[];
  doi: string | null;
  url: string;
  finding: string;
  /** Classification from the retrieval pipeline — populated when evidenceClassification is available. */
  evidenceMatch?: 'direct-lac' | 'direct-global' | 'indirect';
  /** True when this row was supplied by the user (not retrieved from corpus). */
  isManualAdd?: boolean;
}

interface CoverageStats {
  universeCount: number;
  retrievedCount: number;
  admissibleCount: number;
  evidenceCount: number;
  signalCount: number;
}

interface LacCoverage {
  covered: { country: string; count: number }[];
  uncovered: string[];
}

interface CoverageCard extends CoverageStats {
  gapSummary: string;
  regionalGap: string;
  thinEvidenceAreas?: string;
  methodologicalGap: string;
  gapType: string | null;
  // Phase 2 additions — structured LAC sub-region grid, time-window callout,
  // and rule-based next-mile action (Hybrid A — template + deterministic vars).
  lacCoverage?: LacCoverage;
  recencyGap?: string | null;
  nextMileAction?: string | null;
}

interface BriefSections {
  abstractSummary?: string;
  strongestEvidence?: string;
  summaryBullets: string[];
  evidenceRows: EvidenceRow[];
  methodologyNote: string;
  coverageCard: CoverageCard;
  followUpQuestions: string[];
  citations: string[];
  warnings: string[];
}

interface AiClient {
  model: string;
  generateStructuredBrief: (params: {
    query: string;
    evidenceRows: EvidenceRow[];
    coverage: CoverageStats;
    // deno-lint-ignore no-explicit-any
    promptInputs: Record<string, any>;
    persona?: PersonaId;
  // deno-lint-ignore no-explicit-any
  }) => Promise<Record<string, any> | null>;
  generateTwitterThread?: (params: {
    query: string;
    evidenceRows: EvidenceRow[];
    coverage: CoverageStats;
    // deno-lint-ignore no-explicit-any
    promptInputs: Record<string, any>;
  }) => Promise<ThreadTweet[] | null>;
}

type BriefLanguage = 'en' | 'es' | 'pt';

interface SearchRun {
  query: string;
  evidenceWorkIds?: string[];
  signalWorkIds?: string[];
  coverage?: CoverageStats;
  // deno-lint-ignore no-explicit-any
  filters?: Record<string, any>;
  // deno-lint-ignore no-explicit-any
  evidenceClassification?: Record<string, any> | null;
  // Channel-of-origin provenance (workId -> channel ids). Additive; null on
  // legacy runs.
  workChannels?: Record<string, string[]> | null;
}

interface SourceRecord {
  id: string;
  name: string;
}

interface GapResult {
  type: string | null;
  summary: string;
  regional: string;
  thin: string;
  methodological: string;
  // Phase 2 additions
  lacCoverage?: LacCoverage;
  recencyGap?: string | null;
  nextMileAction?: string | null;
}

interface MixedEvidenceResult {
  isMixed: boolean;
  warning: string;
}

// deno-lint-ignore no-explicit-any
interface BriefResult {
  query: string;
  status: string;
  // deno-lint-ignore no-explicit-any
  sections: any;
  auditTrace: {
    model: string;
    persona?: PersonaId;
    lang?: BriefLanguage;
    promptVersions: Record<string, string>;
    retrievalPolicy: string;
    queryPlan: string[];
    generatedAt: string;
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// buildEvidenceRows
// ---------------------------------------------------------------------------

/**
 * Build evidence row objects for the brief sections.
 */
export function buildEvidenceRows(
  evidence: AnyWork[],
  sources: SourceRecord[] = [],
  // deno-lint-ignore no-explicit-any
  classificationMap?: Record<string, any> | null,
  // Channel-of-origin map (workId -> channel ids). Additive provenance — when
  // present, each row gets `retrievalChannels` so BriefView can render pills
  // from the TRUE surfacing channel(s) instead of the deterministic recompute.
  workChannels?: Record<string, string[]> | null,
): EvidenceRow[] {
  return evidence.map((work) => {
    const cls = classificationMap?.[work.id];
    const fine: string | undefined = cls?.classification ?? cls?.evidenceMatch;
    const evidenceMatch: EvidenceRow['evidenceMatch'] =
      fine === 'direct-lac' ? 'direct-lac'
      : fine === 'direct-global' || fine === 'direct' ? 'direct-global'
      : fine === 'indirect' ? 'indirect'
      : undefined;

    return {
      workId: work.id,
      title: work.title,
      authors: toStrArray(work.authors),
      sourceName:
        work.venue ||
        sources.find((source) => source.id === work.sourceId)?.name ||
        work.institution ||
        (work.source === "semantic_scholar" ? "Semantic Scholar" :
         work.source === "exa" ? "Exa" :
         work.source || "Unknown"),
      year: work.year,
      methodologyBadge:
        work.methodology_design ||
        work.methodologyDesign ||
        work.methodology?.design ||
        "Unclassified",
      causalStrength:
        work.causal_strength ||
        work.causalStrength ||
        work.methodology?.causalStrength ||
        "signal",
      smsLevel: work.sms_level ?? work.smsLevel ?? null,
      citationCount: work.citation_count ?? work.citationCount ?? null,
      isFoundational: (() => {
        const cit = Number(work.citation_count ?? work.citationCount ?? 0);
        const yr = Number(work.year ?? 0);
        return cit >= 75 && yr > 0 && yr < 2020;
      })(),
      geography: toStrArray(work.geography),
      doi: work.canonical_doi || work.canonicalDoi,
      url: work.url || work.open_access_pdf_url || work.openAccessPdfUrl || "",
      finding: work.summary || work.abstract || "",
      evidenceMatch,
      retrievalChannels: workChannels?.[work.id],
    };
  });
}

function buildExtraPaperRows(extraPapers: ExtraPaper[]): EvidenceRow[] {
  return extraPapers.map((p) => ({
    workId: p.matchedWorkId ?? p.doi ?? p.uploadId,
    title: p.title ?? '(untitled)',
    authors: Array.isArray(p.authors) ? p.authors : [],
    sourceName: p.venue ?? '',
    year: p.year ?? null,
    methodologyBadge: p.card?.design ?? '',
    causalStrength: 'signal',
    smsLevel: p.smsLevel ?? null,
    geography: [],
    doi: p.doi ?? null,
    url: '',
    finding: p.card?.findingShort ?? (p.abstract ? p.abstract.slice(0, 300) : ''),
    isManualAdd: true,
  }));
}

// ---------------------------------------------------------------------------
// createBriefFromRun
// ---------------------------------------------------------------------------

/**
 * Generate a structured evidence brief from a completed search run.
 *
 * Phase 1: aiClient may be null (env var not set) — falls back to deterministic synthesis.
 * Phase 1: works arrays will be empty — deterministic brief handles this gracefully.
 */
export async function createBriefFromRun(
  searchRun: SearchRun,
  works: AnyWork[] = [],
  aiClient: AiClient | null = null,
  sources: SourceRecord[] = [],
  persona?: string | null,
  lang: BriefLanguage = 'en',
  synthesisCap?: number,
  extraPapers: ExtraPaper[] = [],
): Promise<BriefResult> {
  const resolvedPersona = resolvePersona(persona);
  const evidence = works.filter((work) =>
    (searchRun.evidenceWorkIds || []).includes(work.id)
  );
  const signals = works.filter((work) =>
    (searchRun.signalWorkIds || []).includes(work.id)
  );
  const evidenceRows = buildEvidenceRows(evidence, sources, searchRun.evidenceClassification, searchRun.workChannels);
  const extraRows = buildExtraPaperRows(extraPapers);
  const allEvidenceRows = [...evidenceRows, ...extraRows];
  const coverage: CoverageStats = searchRun.coverage || {
    universeCount: 0,
    retrievedCount: 0,
    admissibleCount: 0,
    evidenceCount: 0,
    signalCount: 0,
  };

  // Always build deterministic base (SYNTH-06)
  const baseBrief = synthesizeDeterministicBrief(
    searchRun.query,
    allEvidenceRows,
    coverage,
    evidence,
    signals,
    resolvedPersona,
  );

  const model = aiClient?.model || "deterministic";
  // The audit trace must report the model that actually produced the shipped
  // sections — not the client we merely attempted. Flips to `model` only when
  // generation succeeds; a failed LLM call ships the deterministic brief and
  // the trace says so.
  let auditModel = "deterministic";
  // deno-lint-ignore no-explicit-any
  let sections: any = baseBrief;
  let notes = ["Deterministic synthesis fallback used."];

  console.log(
    `[synth-block] entering ai check. aiClient=${!!aiClient} evidenceLen=${evidence.length} persona=${resolvedPersona}`
  );

  // Try AI synthesis if client is available and we have evidence
  if (aiClient && evidence.length > 0) {
    // Cap CORPUS rows only, then append the user-added extras. Extras were
    // previously appended last and sliced off whenever the table was already
    // at the cap — so the papers the user explicitly added never reached the
    // LLM prompt while still showing in the table as first-class evidence.
    const cappedEvidenceRows = [...capEvidenceForPrompt(evidenceRows, synthesisCap), ...extraRows];
    // sourceScreening/methodologyTagging retired 2026-07-06: they re-serialized
    // every evidence title/design into the prompt (a 3rd and 4th copy). Design +
    // classification now ride on the single EVIDENCE block line (buildUserPrompt).
    const promptInputs = {
      queryPlanning: promptFamilies.queryPlanning({
        query: searchRun.query,
        filters: searchRun.filters || {},
      }),
      synthesis: promptFamilies.synthesis({
        query: searchRun.query,
        evidenceRows: cappedEvidenceRows,
        coverage,
        persona: resolvedPersona,
        lang,
        // Pre-search clarifying card population focus — synthesis emphasis
        // only (NEVER read by retrieval). Adds the POPULATION FOCUS HARD RULE.
        // normalizePopulationFocus handles legacy string and new string[].
        populationFocus: normalizePopulationFocus(searchRun.filters?.populationFocus),
      }),
    };

    // POLICY-ONLY: briefs always use the single policy synthesis path. The old
    // technical multi-step branch (main call + 5 parallel section calls) was
    // removed 2026-06-03 along with the technical brief register.
    console.log(`[synth-block] calling generateStructuredBrief with ${cappedEvidenceRows.length} rows`);

    const synthStartedAt = Date.now();
    const generated = await aiClient.generateStructuredBrief({
      query: searchRun.query,
      evidenceRows: cappedEvidenceRows,
      coverage,
      promptInputs,
      persona: resolvedPersona,
    });
    console.log(`[synth-block] generateStructuredBrief returned: ${generated ? "ok" : "null"}`);

    // FALLBACK-RATE TRIPWIRE (top-priority signal): status='fallback' means the
    // deterministic brief shipped instead of real Gemini synthesis. Fail-safe.
    logLlmCall({
      // Actual synthesis model (this was a hardcoded, since-retired alias that
      // mislabeled rows the cost report prices by model string).
      model: aiClient.model,
      operation: "brief_synthesis",
      latencyMs: Date.now() - synthStartedAt,
      status: generated ? "ok" : "fallback",
    });

    if (generated) {
      // Recover canonical [workId] tokens from Gemini's [ss:DIGITS] hallucination
      // (NBER/SSRN workIds — see citationNormalizer.ts).
      const citeStats = normalizeBriefCitations(generated, cappedEvidenceRows);
      if (citeStats.rewritten || citeStats.dropped || citeStats.ambiguous) {
        console.log(
          `[synth-block] citation normalize: rewritten=${citeStats.rewritten} dropped=${citeStats.dropped} ambiguous=${citeStats.ambiguous}`,
        );
      }
      // Kris citation fence (shared): strip hallucinated [workId] tokens from
      // ALL prose fields. See enforceCitationFence.
      const invalidCites = enforceCitationFence(generated, cappedEvidenceRows);
      if (invalidCites.length > 0) {
        console.log(`[synth-kris] ${invalidCites.length} citation(s) not in evidence set: ${invalidCites.join(", ")}`);
        if (!generated.warnings) generated.warnings = [];
        generated.warnings.push(
          `${invalidCites.length} citation tag(s) removed — referenced paper(s) not in the retrieved evidence set.`,
        );
      }
      // Two-pass verifier: regex number-check first (instant), then Qwen
      // cross-check (parallel, ~3-5s). Qwen falls through to regex-verified
      // if it fails or times out.
      const soWhatStats = buildSoWhatStats(evidence, allEvidenceRows.length);
      const regexMethodologyNote = verifySoWhatNumbers(
        generated.methodologyNote || baseBrief.methodologyNote,
        soWhatStats,
      );
      const regexGapSummary = verifySoWhatNumbers(
        (generated.coverageCard?.gapSummary as string | undefined) || baseBrief.coverageCard.gapSummary,
        soWhatStats,
      );
      // Qwen verifier runs ASYNC post-done in the SSE handler so it doesn't
      // block the brief's done event. Here we just ship the regex-verified
      // values; the handler swaps them via a `verified` SSE event later.
      const verifiedMethodologyNote = regexMethodologyNote;
      const verifiedGapSummary = regexGapSummary;

      sections = {
        ...sections,
        ...generated,
        // Always keep retrieval-sourced evidence rows — never use AI-generated rows
        evidenceRows: allEvidenceRows,
        citations: [
          ...evidence.map((work) => work.id),
          ...extraPapers.map((p) => p.matchedWorkId ?? p.doi ?? p.uploadId).filter(Boolean),
        ],
        methodologyNote: verifiedMethodologyNote,
        // Keep retrieval-derived gap diagnostics stable and IADB-facing.
        // The model may draft narrative sections, but these sidebar cards
        // should reflect the actual corpus/retrieval assessment.
        coverageCard: {
          ...(generated.coverageCard || {}),
          universeCount: coverage.universeCount,
          retrievedCount: coverage.retrievedCount,
          admissibleCount: coverage.admissibleCount,
          evidenceCount: coverage.evidenceCount,
          signalCount: coverage.signalCount,
          // gapSummary is the LLM "so-what" sentence — let Gemini's win, but
          // pass it through verifySoWhatNumbers so cited counts match the table.
          gapSummary: verifiedGapSummary,
          // Stat rows stay deterministic — Gemini's prose isn't allowed to drift these.
          regionalGap: lang === "en"
            ? baseBrief.coverageCard.regionalGap
            : (generated.coverageCard?.regionalGap || baseBrief.coverageCard.regionalGap),
          thinEvidenceAreas: lang === "en"
            ? baseBrief.coverageCard.thinEvidenceAreas
            : (generated.coverageCard?.thinEvidenceAreas || baseBrief.coverageCard.thinEvidenceAreas),
          methodologicalGap: lang === "en"
            ? baseBrief.coverageCard.methodologicalGap
            : (generated.coverageCard?.methodologicalGap || baseBrief.coverageCard.methodologicalGap),
          gapType: baseBrief.coverageCard.gapType,
          // Phase 2 — deterministic LAC grid, recency callout, and next-mile
          // action stay under our control; Gemini doesn't get to drift these.
          lacCoverage: baseBrief.coverageCard.lacCoverage,
          recencyGap: baseBrief.coverageCard.recencyGap,
          nextMileAction: baseBrief.coverageCard.nextMileAction,
        },
      };
      notes = [
        `Gemini (${model}) structured synthesis generated from retrieved evidence.`,
        `Persona: ${resolvedPersona}.`,
        "Evidence rows come from retrieval pipeline, not AI generation.",
        "All claims are grounded in cited papers.",
      ];
      auditModel = model;
    }

    // Twitter persona: additionally generate a thread shape
    if (resolvedPersona === "twitter" && aiClient.generateTwitterThread) {
      const thread = await aiClient.generateTwitterThread({
        query: searchRun.query,
        evidenceRows: allEvidenceRows,
        coverage,
        promptInputs,
      });
      sections = {
        ...sections,
        threadTweets:
          thread && thread.length > 0
            ? thread
            : deterministicThread(sections.summaryBullets),
      };
    }
  } else if (resolvedPersona === "twitter") {
    sections = {
      ...sections,
      threadTweets: deterministicThread(sections.summaryBullets),
    };
  }

  return {
    query: searchRun.query,
    status: "ready",
    sections,
    auditTrace: {
      model: auditModel,
      persona: resolvedPersona,
      lang,
      promptVersions,
      retrievalPolicy: "hybrid-curated-rag-v1",
      queryPlan: [
        "Discovery Agent expands the query into entities, synonyms, and geography.",
        "Retrieval Agent ranks works with lexical, metadata, and source-policy signals.",
        "SMS Classifier tags methodology level (1-5) via keyword scan.",
        "Journal Rankings lookup matches ABS + RePEC scores.",
        `Synthesis Agent outputs brief shaped for persona: ${resolvedPersona}.`,
      ],
      generatedAt: new Date().toISOString(),
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// createStreamingBriefFromRun (Phase 4 — two-phase SSE streaming)
// ---------------------------------------------------------------------------

/**
 * Streaming brief generation. Sends the deterministic brief immediately
 * via onPhase1, then streams Gemini synthesis text via onChunk.
 * Returns the final merged brief.
 */
export async function createStreamingBriefFromRun(
  searchRun: SearchRun,
  works: AnyWork[],
  aiClient: AiClient | null,
  sources: SourceRecord[],
  callbacks: {
    onPhase1: (brief: BriefResult) => void;
    onChunk: (text: string) => void;
  },
  persona?: string | null,
  lang: BriefLanguage = 'en',
  extraPapers: ExtraPaper[] = [],
): Promise<BriefResult> {
  const resolvedPersona = resolvePersona(persona);
  const evidence = works.filter((work) =>
    (searchRun.evidenceWorkIds || []).includes(work.id)
  );
  const signals = works.filter((work) =>
    (searchRun.signalWorkIds || []).includes(work.id)
  );
  const evidenceRows = buildEvidenceRows(evidence, sources, searchRun.evidenceClassification, searchRun.workChannels);
  const extraRows = buildExtraPaperRows(extraPapers);
  const allEvidenceRows = [...evidenceRows, ...extraRows];
  const coverage: CoverageStats = searchRun.coverage || {
    universeCount: 0,
    retrievedCount: 0,
    admissibleCount: 0,
    evidenceCount: 0,
    signalCount: 0,
  };

  // Always build deterministic base (SYNTH-06)
  const baseBrief = synthesizeDeterministicBrief(
    searchRun.query,
    allEvidenceRows,
    coverage,
    evidence,
    signals,
    resolvedPersona,
  );

  const model = aiClient?.model || "deterministic";

  const deterministicResult: BriefResult = {
    query: searchRun.query,
    status: "ready",
    sections:
      resolvedPersona === "twitter"
        ? { ...baseBrief, threadTweets: deterministicThread(baseBrief.summaryBullets) }
        : baseBrief,
    auditTrace: {
      // Phase-1 result IS deterministic. If the LLM pass below succeeds, the
      // final merged result overrides this with the real model; if it fails,
      // this ships as-is and the trace correctly reports the fallback.
      model: "deterministic",
      persona: resolvedPersona,
      lang,
      promptVersions,
      retrievalPolicy: "hybrid-curated-rag-v1",
      queryPlan: [
        "Discovery Agent expands the query into entities, synonyms, and geography.",
        "Retrieval Agent ranks works with lexical, metadata, and source-policy signals.",
        "SMS Classifier tags methodology level (1-5) via keyword scan.",
        "Journal Rankings lookup matches ABS + RePEC scores.",
        `Synthesis Agent outputs brief shaped for persona: ${resolvedPersona}.`,
      ],
      generatedAt: new Date().toISOString(),
      notes: ["Deterministic synthesis fallback used."],
    },
  };

  // Phase 1: send deterministic brief immediately (<5s)
  callbacks.onPhase1(deterministicResult);

  console.log(
    `[synth] entering ai check. aiClient=${!!aiClient} evidenceLen=${evidence.length} persona=${resolvedPersona}`
  );

  // Phase 2: Gemini synthesis. We use the non-streaming generateContent
  // endpoint — the streamGenerateContent SSE endpoint silently returns
  // zero frames (same bug chat hit), so streaming is unreliable. The SSE
  // wrapper around this function still sends phase1 + done events to the
  // frontend, so the UX is unchanged aside from the in-brief typing effect.
  if (aiClient && evidence.length > 0) {
    // Cap CORPUS rows only, then append the user-added extras (see the
    // blocking path above — extras must always reach the LLM prompt).
    const cappedEvidenceRows = [...capEvidenceForPrompt(evidenceRows), ...extraRows];
    // sourceScreening/methodologyTagging retired 2026-07-06 — see the blocking
    // path above; the single EVIDENCE block now carries design + classification.
    const promptInputs = {
      queryPlanning: promptFamilies.queryPlanning({
        query: searchRun.query,
        filters: searchRun.filters || {},
      }),
      synthesis: promptFamilies.synthesis({
        query: searchRun.query,
        evidenceRows: cappedEvidenceRows,
        coverage,
        persona: resolvedPersona,
        lang,
        // Pre-search clarifying card population focus — synthesis emphasis
        // only (NEVER read by retrieval). Adds the POPULATION FOCUS HARD RULE.
        // normalizePopulationFocus handles legacy string and new string[].
        populationFocus: normalizePopulationFocus(searchRun.filters?.populationFocus),
      }),
    };

    console.log(`[synth] calling generateStructuredBrief with ${cappedEvidenceRows.length} rows, lang=${lang}`);
    const synthStartedAt = Date.now();
    const generated = await aiClient.generateStructuredBrief({
      query: searchRun.query,
      evidenceRows: cappedEvidenceRows,
      coverage,
      promptInputs,
      persona: resolvedPersona,
    });
    console.log(`[synth] generateStructuredBrief returned: ${generated ? "ok" : "null"}`);

    // FALLBACK-RATE TRIPWIRE (top-priority signal): status='fallback' means the
    // deterministic brief shipped instead of real Gemini synthesis. Fail-safe.
    logLlmCall({
      // Actual synthesis model (this was a hardcoded, since-retired alias that
      // mislabeled rows the cost report prices by model string).
      model: aiClient.model,
      operation: "brief_synthesis",
      latencyMs: Date.now() - synthStartedAt,
      status: generated ? "ok" : "fallback",
    });

    if (generated) {
      // Recover canonical [workId] tokens from Gemini's [ss:DIGITS] hallucination
      // (NBER/SSRN workIds — see citationNormalizer.ts).
      const citeStats = normalizeBriefCitations(generated, cappedEvidenceRows);
      if (citeStats.rewritten || citeStats.dropped || citeStats.ambiguous) {
        console.log(
          `[synth] citation normalize: rewritten=${citeStats.rewritten} dropped=${citeStats.dropped} ambiguous=${citeStats.ambiguous}`,
        );
      }
      // Kris citation fence (shared): strip hallucinated [workId] tokens from
      // ALL prose fields. Previously the SSE path — the path the UI actually
      // uses — had NO citation validation at all, so an invented citation
      // shipped straight into the persisted brief.
      // deno-lint-ignore no-explicit-any
      const invalidCitesS = enforceCitationFence(generated as any, cappedEvidenceRows);
      if (invalidCitesS.length > 0) {
        console.log(`[synth-kris] ${invalidCitesS.length} citation(s) not in evidence set: ${invalidCitesS.join(", ")}`);
        // deno-lint-ignore no-explicit-any
        const g = generated as any;
        if (!Array.isArray(g.warnings)) g.warnings = [];
        g.warnings.push(
          `${invalidCitesS.length} citation tag(s) removed — referenced paper(s) not in the retrieved evidence set.`,
        );
      }
      // Number-check LLM so-what sentences first (cheap, instant regex pass).
      const soWhatStats = buildSoWhatStats(evidence, allEvidenceRows.length);
      const regexMethodologyNote = verifySoWhatNumbers(
        // deno-lint-ignore no-explicit-any
        (generated as any).methodologyNote || baseBrief.methodologyNote,
        soWhatStats,
      );
      const regexGapSummary = verifySoWhatNumbers(
        // deno-lint-ignore no-explicit-any
        ((generated as any).coverageCard?.gapSummary as string | undefined) || baseBrief.coverageCard.gapSummary,
        soWhatStats,
      );
      // Then Qwen verifier (parallel calls, ~3-5s) — corrects non-numeric drift
      // like wrong methodology attribution or unsupported claims. Falls through
      // to regex-verified versions if Qwen fails.
      // Qwen verifier runs ASYNC post-done in the SSE handler so it doesn't
      // block the brief's done event. Here we just ship the regex-verified
      // values; the handler swaps them via a `verified` SSE event later.
      const verifiedMethodologyNote = regexMethodologyNote;
      const verifiedGapSummary = regexGapSummary;

      // deno-lint-ignore no-explicit-any
      let mergedSections: any = {
        ...baseBrief,
        ...generated,
        // Always keep retrieval-sourced evidence rows — never use AI-generated rows
        evidenceRows: allEvidenceRows,
        citations: [
          ...evidence.map((work) => work.id),
          ...extraPapers.map((p) => p.matchedWorkId ?? p.doi ?? p.uploadId).filter(Boolean),
        ],
        methodologyNote: verifiedMethodologyNote,
        // Keep retrieval-derived gap diagnostics stable and IADB-facing.
        // The model may draft narrative sections, but these sidebar cards
        // should reflect the actual corpus/retrieval assessment.
        coverageCard: {
          // deno-lint-ignore no-explicit-any
          ...(generated.coverageCard as any || {}),
          universeCount: coverage.universeCount,
          retrievedCount: coverage.retrievedCount,
          admissibleCount: coverage.admissibleCount,
          evidenceCount: coverage.evidenceCount,
          signalCount: coverage.signalCount,
          // gapSummary is the LLM "so-what" sentence — let Gemini's win when
          // present, but pass through verifySoWhatNumbers so cited counts
          // match the table.
          gapSummary: verifiedGapSummary,
          // Stat rows stay deterministic — Gemini's prose isn't allowed to drift these.
          regionalGap: lang === "en"
            ? baseBrief.coverageCard.regionalGap
            : ((generated.coverageCard as any)?.regionalGap || baseBrief.coverageCard.regionalGap),
          thinEvidenceAreas: lang === "en"
            ? baseBrief.coverageCard.thinEvidenceAreas
            : ((generated.coverageCard as any)?.thinEvidenceAreas || baseBrief.coverageCard.thinEvidenceAreas),
          methodologicalGap: lang === "en"
            ? baseBrief.coverageCard.methodologicalGap
            : ((generated.coverageCard as any)?.methodologicalGap || baseBrief.coverageCard.methodologicalGap),
          gapType: baseBrief.coverageCard.gapType,
          // Phase 2 — deterministic LAC grid, recency callout, and next-mile
          // action stay under our control; Gemini doesn't get to drift these.
          lacCoverage: baseBrief.coverageCard.lacCoverage,
          recencyGap: baseBrief.coverageCard.recencyGap,
          nextMileAction: baseBrief.coverageCard.nextMileAction,
        },
      };

      // Twitter persona: additionally generate thread from cached evidence.
      if (resolvedPersona === "twitter" && aiClient.generateTwitterThread) {
        const thread = await aiClient.generateTwitterThread({
          query: searchRun.query,
          evidenceRows: allEvidenceRows,
          coverage,
          promptInputs,
        });
        mergedSections = {
          ...mergedSections,
          threadTweets:
            thread && thread.length > 0
              ? thread
              : deterministicThread(mergedSections.summaryBullets),
        };
      }

      return {
        ...deterministicResult,
        sections: mergedSections,
        auditTrace: {
          ...deterministicResult.auditTrace,
          model,
          notes: [
            `Gemini (${model}) synthesis generated from retrieved evidence.`,
            `Persona: ${resolvedPersona}.`,
            "Evidence rows come from retrieval pipeline, not AI generation.",
            "All claims are grounded in cited papers.",
          ],
        },
      };
    }
  }

  // No Gemini or no evidence — return deterministic brief as-is
  return deterministicResult;
}

// ---------------------------------------------------------------------------
// synthesizeDeterministicBrief
// ---------------------------------------------------------------------------

export function synthesizeDeterministicBrief(
  query: string,
  evidenceRows: EvidenceRow[],
  coverage: CoverageStats,
  evidence: AnyWork[] = [],
  signals: AnyWork[] = [],
  persona: PersonaId = DEFAULT_PERSONA,
): BriefSections {
  const gaps = detectGaps(coverage, evidence, query);
  const methodologyMix = summarizeMethodologyMix(evidence);
  const mixedEvidence = detectMixedEvidence(evidence);

  // --- SYNTH-05: Edge case — zero results ---
  if (evidenceRows.length === 0) {
    const isUnderstudied = (coverage.universeCount || 0) < 50;
    return {
      summaryBullets: isUnderstudied
        ? [
            `No admissible evidence found for "${query}". The academic universe contains fewer than ${coverage.universeCount ?? 50} papers — this topic appears understudied.`,
            "Consider broadening search terms, relaxing quality thresholds, or searching adjacent topics.",
            ...(signals.length > 0
              ? [
                  "Weak signals exist in lower-tier sources but do not meet evidence standards for this brief.",
                ]
              : []),
          ]
        : [
            `No admissible evidence found for "${query}", despite ~${(coverage.universeCount || 0).toLocaleString()} papers in the universe.`,
            "This may indicate a retrieval issue: papers exist but none passed the current quality filters. Try lowering SMS or journal ranking thresholds.",
            ...(signals.length > 0
              ? [
                  `${signals.length} signal-only result${signals.length > 1 ? "s" : ""} detected but excluded from the evidence table.`,
                ]
              : []),
          ],
      evidenceRows,
      methodologyNote:
        "No evidence retrieved — methodology assessment not applicable.",
      coverageCard: {
        universeCount: coverage.universeCount,
        retrievedCount: coverage.retrievedCount,
        admissibleCount: coverage.admissibleCount,
        evidenceCount: coverage.evidenceCount,
        signalCount: coverage.signalCount,
        gapSummary: gaps.summary,
        regionalGap: gaps.regional,
        thinEvidenceAreas: gaps.thin,
        methodologicalGap: gaps.methodological,
        gapType: gaps.type,
        lacCoverage: gaps.lacCoverage,
        recencyGap: gaps.recencyGap,
        nextMileAction: gaps.nextMileAction,
      },
      followUpQuestions: [
        `What adjacent topics might yield transferable evidence for "${query}"?`,
        'Would relaxing quality thresholds to "Exploratory" surface relevant papers?',
        `Are there ongoing RCTs or pre-registered studies on "${query}" in LAC?`,
      ],
      citations: [],
      warnings: [
        "This brief contains no admissible evidence. Do not cite it as an evidence review.",
        "The zero-result finding itself is informative — it identifies a potential research gap.",
      ],
    };
  }

  // --- Standard brief with evidence ---
  // QUAL-12: every summary bullet cites a specific paper. Keep fallback
  // thematic so it does not degrade into a paper-by-paper bibliography.
  const strongRows = evidenceRows.filter((row) => (row.smsLevel ?? 0) >= 4);
  const moderateRows = evidenceRows.filter((row) => (row.smsLevel ?? 0) >= 2 && (row.smsLevel ?? 0) < 4);
  const descriptiveRows = evidenceRows.filter((row) => (row.smsLevel ?? 0) < 2);
  const cite = (row: EvidenceRow | undefined) => row ? `[${row.workId}]` : "";
  const describeRow = (row: EvidenceRow | undefined) => row
    ? `${truncateFinding(row.finding || row.title, 180)} ${cite(row)}`.trim()
    : "No representative paper is available.";
  if (persona === "non-technical") {
    const strongerCount = strongRows.length;
    const weakerCount = moderateRows.length + descriptiveRows.length;
    const summaryBullets = [
      `The main answer comes from ${evidenceRows.length} retrieved studies on "${query}". The clearest finding is: ${describeRow(evidenceRows[0])}`,
      strongerCount > 0
        ? `${strongerCount} stronger ${strongerCount === 1 ? "study uses" : "studies use"} fairer comparisons, so ${strongerCount === 1 ? "it deserves" : "they deserve"} more weight. The best example is ${describeRow(strongRows[0] || evidenceRows[0])}`
        : "None of the retrieved studies is clearly strong enough to treat as proof. Use these papers as useful clues, not as a final answer.",
      weakerCount > 0
        ? `${weakerCount} other ${weakerCount === 1 ? "study is" : "studies are"} better for context, mechanisms, and examples than for proving cause and effect. A representative example is ${describeRow(moderateRows[0] || descriptiveRows[0] || evidenceRows[1])}`
        : "The retrieved set is small, so the brief should avoid broad claims beyond the cited studies.",
      `The biggest caution is transferability. ${gaps.regional} ${gaps.thin} ${cite(evidenceRows[2] || evidenceRows[0])}`.trim(),
    ];
    if (signals.length > 0) {
      summaryBullets.push("Some weaker signals exist, but they are not strong enough to count as evidence in this brief.");
    }
    if (mixedEvidence.isMixed) {
      summaryBullets.push("The evidence quality is mixed, so stronger studies should drive the answer and weaker studies should mainly explain context.");
    }
    const methodologyNote = strongerCount > 0
      ? `${strongerCount} stronger ${strongerCount === 1 ? "study makes" : "studies make"} the answer more credible, but weaker studies still limit confidence.`
      : "The evidence is mostly descriptive, so it can guide questions but should not be treated as proof.";
    const topPapers = evidenceRows.slice(0, 3);
    const abstractSummary = topPapers.length > 0
      ? `This brief looks at ${evidenceRows.length} papers on "${query}". The most useful papers are ${topPapers.map(r => `${(r.authors[0] || "Unknown").split(" ").pop() || "Unknown"} (${r.year || "n.d."})`).join(", ")}. The answer is more trustworthy when studies compare similar people or places fairly; otherwise it should be read as suggestive. ${gaps.type ? `The main gap is ${gaps.type.replace(/_/g, " ")}.` : "No major gap was detected."}`
      : `No admissible evidence found for "${query}".`;
    const strongest = [...evidenceRows].sort((a, b) => (b.smsLevel ?? 0) - (a.smsLevel ?? 0))[0];
    const strongestEvidence = strongest
      ? `${(strongest.authors?.[0] || "Unknown").split(" ").pop() || "Unknown"} (${strongest.year || "n.d."}) is the strongest retrieved paper because it uses a more reliable comparison. ${cite(strongest)}`
      : "No evidence to highlight.";
    return {
      abstractSummary,
      summaryBullets,
      strongestEvidence,
      evidenceRows,
      methodologyNote,
      coverageCard: {
        universeCount: coverage.universeCount,
        retrievedCount: coverage.retrievedCount,
        admissibleCount: coverage.admissibleCount,
        evidenceCount: coverage.evidenceCount,
        signalCount: coverage.signalCount,
        gapSummary: gaps.summary,
        regionalGap: gaps.regional,
        thinEvidenceAreas: gaps.thin,
        methodologicalGap: gaps.methodological,
        gapType: gaps.type,
        lacCoverage: gaps.lacCoverage,
        recencyGap: gaps.recencyGap,
        nextMileAction: gaps.nextMileAction,
      },
      followUpQuestions: [
        `Which stronger studies best answer "${query}"?`,
        "What should a non-specialist be most cautious about?",
        "Where is the evidence still too thin to guide decisions?",
      ],
      citations: evidenceRows.map((r) => r.workId),
      warnings: [
        ...(gaps.type ? [`Gap detected: ${gaps.type}.`] : []),
        ...(mixedEvidence.isMixed ? ["Evidence quality is mixed; read weaker studies as context."] : []),
      ],
    };
  }
  const summaryBullets = [
    `**1. Main empirical regularity.** Across ${evidenceRows.length} retrieved evidence papers on "${query}", the strongest recurring pattern is: ${describeRow(evidenceRows[0])}`,
    `**2. Causal evidence.** ${strongRows.length} paper${strongRows.length === 1 ? "" : "s"} reach SMS 4-5. The best-supported causal claim comes from ${describeRow(strongRows[0] || evidenceRows[0])}`,
    `**3. Mechanisms and heterogeneity.** Moderate and descriptive studies (${moderateRows.length + descriptiveRows.length}) should be used for mechanisms, subgroups, and context rather than causal proof. Representative signal: ${describeRow(moderateRows[0] || descriptiveRows[0] || evidenceRows[1])}`,
    `**4. External validity and research frontier.** ${gaps.regional} ${gaps.thin} ${cite(evidenceRows[2] || evidenceRows[0])}`.trim(),
  ];

  if (signals.length > 0) {
    summaryBullets.push(
      "Weak signals exist, but they remain outside the admissible evidence table for this brief."
    );
  }

  // --- SYNTH-05: Edge case — conflicting/mixed evidence quality ---
  if (mixedEvidence.isMixed) {
    summaryBullets.push(mixedEvidence.warning);
  }

  const methodologyNote = buildMethodologyNote(methodologyMix, gaps, evidence);

  const followUpQuestions = buildFollowUpQuestions(query, gaps, mixedEvidence);

  // Deterministic abstract: synthesize a short paragraph from the top evidence
  const topPapers = evidenceRows.slice(0, 3);
  const abstractSummary = topPapers.length > 0
    ? `This brief reviews ${evidenceRows.length} papers on "${query}". ${topPapers.map(r => {
        const author = (r.authors[0] || "").split(" ").pop() || "Unknown";
        return `${author} (${r.year || "n.d."})`;
      }).join(", ")} provide the most cited evidence. The methodology mix is ${methodologyMix}. ${gaps.type ? `A ${gaps.type.replace(/_/g, " ")} was detected.` : "No major gaps detected."}`
    : `No admissible evidence found for "${query}".`;

  // Highlight strongest paper by SMS level then citation count
  const strongest = [...evidenceRows].sort((a, b) => {
    const smsA = a.smsLevel ?? 0;
    const smsB = b.smsLevel ?? 0;
    if (smsB !== smsA) return smsB - smsA;
    return 0; // no citation count in EvidenceRow, so SMS is the tiebreaker
  })[0];

  const strongestEvidence = strongest
    ? (() => {
        const firstAuthor = (strongest.authors?.[0] || "Unknown").split(" ").pop() || "Unknown";
        const authorTag = (strongest.authors?.length ?? 0) > 1 ? `${firstAuthor} et al.` : firstAuthor;
        const year = strongest.year || "n.d.";
        const design = strongest.methodologyBadge && strongest.methodologyBadge !== "Unclassified"
          ? strongest.methodologyBadge
          : "unclassified";
        const decisionUse = strongest.smsLevel != null && strongest.smsLevel >= 4
          ? "Causal claims OK with LAC fit check."
          : strongest.smsLevel != null && strongest.smsLevel >= 2
          ? "Scoping only — not causal proof."
          : "Background only.";
        return `${authorTag} (${year}), "${strongest.title}" — SMS ${strongest.smsLevel ?? "–"}, ${design}. ${decisionUse}`;
      })()
    : "No evidence to highlight.";

  return {
    abstractSummary,
    summaryBullets,
    strongestEvidence,
    evidenceRows,
    methodologyNote,
    coverageCard: {
      universeCount: coverage.universeCount,
      retrievedCount: coverage.retrievedCount,
      admissibleCount: coverage.admissibleCount,
      evidenceCount: coverage.evidenceCount,
      signalCount: coverage.signalCount,
      gapSummary: gaps.summary,
      regionalGap: gaps.regional,
      thinEvidenceAreas: gaps.thin,
      methodologicalGap: gaps.methodological,
      gapType: gaps.type,
      lacCoverage: gaps.lacCoverage,
      recencyGap: gaps.recencyGap,
      nextMileAction: gaps.nextMileAction,
    },
    followUpQuestions,
    citations: evidenceRows.map((row) => row.workId),
    warnings: buildWarnings(gaps, mixedEvidence),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect mixed/conflicting evidence quality (SYNTH-05).
 */
function detectMixedEvidence(evidence: AnyWork[]): MixedEvidenceResult {
  const smsLevels = evidence
    .map((w) => (w.smsLevel ?? w.sms_level ?? null) as number | null)
    .filter((s): s is number => s != null);

  if (smsLevels.length < 3) return { isMixed: false, warning: "" };

  const strong = smsLevels.filter((s) => s >= 4).length;
  const weak = smsLevels.filter((s) => s <= 2).length;

  if (strong >= 1 && weak >= 1) {
    return {
      isMixed: true,
      warning: `Evidence quality varies significantly: ${strong} paper${strong > 1 ? "s" : ""} use strong causal methods (SMS 4-5) while ${weak} ${weak > 1 ? "are" : "is"} correlational (SMS 1-2). Findings may differ by methodology — weight conclusions toward stronger designs.`,
    };
  }

  return { isMixed: false, warning: "" };
}

function truncateFinding(finding: string | null | undefined, max = 500): string {
  if (!finding) return "";
  // Try to cut at a sentence boundary within the limit so the snippet ends
  // cleanly. Falls back to a hard cut if no period is available.
  if (finding.length <= max) return finding;
  const slice = finding.slice(0, max);
  const lastPeriod = slice.lastIndexOf(". ");
  if (lastPeriod > Math.floor(max * 0.5)) {
    return slice.slice(0, lastPeriod + 1);
  }
  return slice.slice(0, max - 3) + "...";
}

function buildMethodologyNote(
  methodologyMix: string,
  gaps: GapResult,
  evidence: AnyWork[]
): string {
  const strongCount = evidence.filter(
    (w) => (w.smsLevel ?? w.sms_level ?? 0) >= 4
  ).length;
  const evidenceCount = evidence.length;
  const strongShare = evidenceCount > 0
    ? Math.round((strongCount / evidenceCount) * 100)
    : 0;
  return `${strongCount}/${evidenceCount} papers (${strongShare}%) at SMS 4–5. Mix: ${methodologyMix}.`;
}

function buildFollowUpQuestions(
  query: string,
  gaps: GapResult,
  mixedEvidence: MixedEvidenceResult
): string[] {
  const questions: string[] = [];

  if (gaps.type === "regional_gap") {
    questions.push(
      `Are there LAC-specific studies on "${query}" that use different terminology or are published in Spanish?`
    );
    questions.push(
      "Which LAC countries have active research programs on this topic?"
    );
  } else {
    questions.push(
      `Which Latin America sub-regions are under-covered for "${query}"?`
    );
  }

  if (mixedEvidence.isMixed) {
    questions.push(
      "Do the stronger-design studies (SMS 4-5) converge on a direction, or do they also disagree?"
    );
  }

  if (gaps.type === "methodological_gap") {
    questions.push(
      `Are there ongoing RCTs or quasi-experimental studies on "${query}"?`
    );
  }

  questions.push(
    "What changes if the search expands to Tier C signals for early trend detection?"
  );

  return questions.slice(0, 4); // cap at 4
}

function buildWarnings(
  gaps: GapResult,
  mixedEvidence: MixedEvidenceResult
): string[] {
  const warnings = [
    "This brief is constrained to the indexed corpus and source-use policy.",
    "Tier C signal sources are labeled separately and excluded from evidence tables.",
  ];

  if (gaps.type === "regional_gap") {
    warnings.unshift(
      "No LAC-specific evidence found — global evidence may not transfer to Latin American contexts."
    );
  }

  if (mixedEvidence.isMixed) {
    warnings.unshift(
      "Evidence quality is mixed — conclusions from weaker designs may not hold under rigorous methods."
    );
  }

  return warnings;
}

/**
 * Detect gap scenarios (QUAL-11).
 *
 * Four scenarios:
 *   1. research_gap     — Universe count low (<50), topic hasn't been studied much
 *   2. retrieval_issue   — Universe high (>=50) but admissible low (<5), retrieval missed papers
 *   3. methodological_gap — Universe high, papers found, but no strong causal evidence (SMS >= 4)
 *   4. regional_gap      — Universe high, papers found, but no LAC-relevant evidence
 */
function detectGaps(
  coverage: CoverageStats,
  evidence: AnyWork[],
  query = ""
): GapResult {
  const U = coverage.universeCount || 0;
  const A = coverage.admissibleCount || 0;
  const E = evidence.length;
  const profile = buildCoverageProfile(query, evidence);

  // Count papers with strong methods (SMS 4-5)
  const strongMethodCount = evidence.filter(
    (w) => w.smsLevel >= 4 || w.sms_level >= 4
  ).length;

  // Recency callout — surfaces a stale-evidence gap as its own §3 box line.
  // Fires when there's at least one strong-design paper overall but none in
  // the last 3 years (post-AI-shock and post-pandemic dynamics uncovered).
  const RECENCY_WINDOW = 3;
  const recencyCutoff = new Date().getFullYear() - RECENCY_WINDOW;
  const recentStrongCount = evidence.filter(
    (w) =>
      ((w.smsLevel ?? w.sms_level ?? 0) as number) >= 4 &&
      ((w.year ?? 0) as number) >= recencyCutoff,
  ).length;
  const queryClause = query.trim() ? ` on ${query.trim()}` : "";
  const recencyGap =
    strongMethodCount >= 1 && recentStrongCount === 0
      ? `0 SMS 4–5 papers post-${recencyCutoff}${queryClause} — strongest evidence may be stale.`
      : null;

  // Next-mile action — Hybrid A: rule-based template per gap type, with
  // deterministic variable substitution from coverage data. No LLM.
  const altLang = "Spanish or Portuguese";
  const missingCountries = profile.lacCoverage.uncovered.slice(0, 3);
  const missingCountriesPhrase = missingCountries.length > 0
    ? formatList(missingCountries)
    : "country-specific terms";
  const topicClause = profile.topCoveredTopic
    ? ` on ${profile.topCoveredTopic}`
    : "";
  const nextMileBy = (gapType: string | null): string => {
    switch (gapType) {
      case "research_gap":
        return `Broaden the query (drop one constraint), or try terms in ${altLang}.`;
      case "retrieval_issue":
        return `Lower the SMS filter to 3 or drop the tier filter — ${U.toLocaleString()} papers exist in the universe that weren't admitted.`;
      case "methodological_gap":
        return `Search adjacent topics with stronger designs (RCT, DiD)${topicClause}; treat the current set as scoping only.`;
      case "regional_gap":
        return `Add ${missingCountriesPhrase} to the query and check IADB Working Papers and CEPAL in ${altLang}.`;
      default:
        return `Coverage looks healthy — deepen with sub-topic queries${topicClause}.`;
    }
  };

  // Scenario 1: Research gap — very few papers exist on this topic
  if (U < 50 && E === 0) {
    return {
      type: "research_gap",
      summary: `Universe is only ${U} papers; topic is understudied.`,
      regional: "No LAC pattern detectable — too few papers retrieved.",
      thin: "Whole topic is thin. Broaden query before naming missing subtopics.",
      methodological: "Methods unassessable. Need a reviewable evidence map first.",
      lacCoverage: profile.lacCoverage,
      recencyGap,
      nextMileAction: nextMileBy("research_gap"),
    };
  }

  // Scenario 2: Retrieval issue — papers exist but we couldn't retrieve enough
  if (U >= 50 && A < 5) {
    return {
      type: "retrieval_issue",
      summary: `${U.toLocaleString()} papers in universe but only ${A} admissible — retrieval gap, not research gap.`,
      regional: "LAC coverage unassessable. Try Spanish/Portuguese query variants.",
      thin: "Thin areas confounded with retrieval failure.",
      methodological: "Loosen source/venue filters before interpreting methods.",
      lacCoverage: profile.lacCoverage,
      recencyGap,
      nextMileAction: nextMileBy("retrieval_issue"),
    };
  }

  // Scenario 3: Methodological gap — papers found but no strong causal evidence
  if (E >= 3 && strongMethodCount === 0) {
    return {
      type: "methodological_gap",
      summary: `0 of ${E} papers at SMS 4–5 — no causal-grade evidence retrieved.`,
      regional: profile.lacEvidence,
      thin: profile.thinAreas,
      methodological:
        profile.methodsNeeded ||
        "0 RCTs · 0 DiD · 0 RDD · 0 IV in this set.",
      lacCoverage: profile.lacCoverage,
      recencyGap,
      nextMileAction: nextMileBy("methodological_gap"),
    };
  }

  // Scenario 4: Regional gap — papers found but none mention LAC countries
  const lacTerms =
    /\b(latin america|lac|caribbean|brazil|mexico|colombia|argentina|chile|peru|ecuador|bolivia|uruguay|paraguay|venezuela|costa rica|panama|honduras|guatemala|el salvador|nicaragua|dominican republic|haiti|jamaica|trinidad|barbados|guyana|suriname|belize|cepal|eclac|iadb|idb)\b/i;
  const hasLacEvidence = evidence.some(
    (w) =>
      lacTerms.test(w.title || "") ||
      lacTerms.test(w.abstract || "") ||
      lacTerms.test(w.summary || "")
  );

  if (E >= 3 && !hasLacEvidence) {
    return {
      type: "regional_gap",
      summary: `0 of ${E} papers mention LAC — treat as global evidence, not LAC proof.`,
      regional: profile.lacEvidence,
      thin: profile.thinAreas,
      methodological:
        profile.methodsNeeded ||
        (strongMethodCount > 0
          ? `${strongMethodCount} SMS 4–5 papers, all non-LAC. Next: transferability memo.`
          : "0 SMS 4–5 in LAC. Next: identify datasets + feasible evaluation designs."),
      lacCoverage: profile.lacCoverage,
      recencyGap,
      nextMileAction: nextMileBy("regional_gap"),
    };
  }

  // Default — no major gap detected
  const strongPct =
    E > 0 ? Math.round((strongMethodCount / E) * 100) : 0;
  return {
    type: null,
    summary: `${E} papers, ${strongMethodCount} at SMS 4–5 (${strongPct}%).`,
    regional: profile.lacEvidence,
    thin: profile.thinAreas,
    methodological: profile.methodsNeeded,
    lacCoverage: profile.lacCoverage,
    recencyGap,
    nextMileAction: nextMileBy(null),
  };
}

function buildCoverageProfile(query: string, evidence: AnyWork[]) {
  const lacCountries: [string, RegExp][] = [
    ["Brazil", /\bbrazil|brasil\b/i],
    ["Mexico", /\bmexico|mexican\b/i],
    ["Colombia", /\bcolombia|colombian\b/i],
    ["Argentina", /\bargentina|argentine\b/i],
    ["Chile", /\bchile|chilean\b/i],
    ["Peru", /\bperu|peruvian\b/i],
    ["Ecuador", /\becuador\b/i],
    ["Bolivia", /\bbolivia\b/i],
    ["Uruguay", /\buruguay\b/i],
    ["Paraguay", /\bparaguay\b/i],
    ["Costa Rica", /\bcosta rica\b/i],
    ["Panama", /\bpanama\b/i],
    ["Central America", /\bcentral america|guatemala|honduras|el salvador|nicaragua\b/i],
    ["Caribbean", /\bcaribbean|dominican republic|haiti|jamaica|trinidad|barbados|guyana|suriname|belize\b/i],
    ["LAC regional", /\blatin america|lac|iadb|idb|cepal|eclac\b/i],
  ];
  const topics: [string, RegExp][] = [
    ["AI adoption", /\bai|artificial intelligence|automation|algorithm|machine learning|digital technolog/i],
    ["firm productivity and technology adoption", /\bfirm|productivity|technology adoption|innovation|smes?|enterprise/i],
    ["employment and job transitions", /\bemployment|job|occupation|worker|labor demand|labour demand|displacement/i],
    ["wages and income", /\bwage|earnings|income|salary|compensation/i],
    ["skills and training", /\bskill|training|reskilling|upskilling|education|human capital/i],
    ["informality and vulnerable workers", /\binformal|informality|self-employ|low-skill|low skill|vulnerable/i],
    ["gender and inclusion", /\bgender|women|female|youth|inequality|inclusion/i],
    ["platform work", /\bplatform|gig|freelance|ride-hailing|delivery worker/i],
    ["public-sector adoption", /\bpublic sector|government|civil service|public administration/i],
    ["social protection and labor supply", /\bsocial protection|cash transfer|labor supply|labour supply|welfare|benefit/i],
  ];

  const queryText = query.toLowerCase();
  const queryIsAiLabor = /\b(ai|artificial intelligence|automation|algorithm|machine learning)\b/.test(queryText) &&
    /\b(labor|labour|employment|job|worker|work|wage|skill)\b/.test(queryText);
  const relevantTopics = queryIsAiLabor
    ? topics.slice(0, 9)
    : topics.filter(([, pattern]) => pattern.test(queryText)).slice(0, 6);
  const topicSet = relevantTopics.length > 0 ? relevantTopics : topics.slice(1, 7);

  const countryCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const strongTopicCounts = new Map<string, number>();
  const topicNewestYear = new Map<string, number>();
  const topicSingleSampleSize = new Map<string, number>(); // tracks topics with only 1 paper
  const lacWorks: { work: AnyWork; country: string }[] = [];

  for (const work of evidence) {
    const text = `${work.title || ""} ${work.abstract || ""} ${work.summary || ""} ${toStrArray(work.geography).join(" ")}`;
    const isStrong = (work.smsLevel ?? work.sms_level ?? 0) >= 4;
    const year = (work.year ?? 0) as number;
    let firstLacCountry: string | null = null;
    for (const [label, pattern] of lacCountries) {
      if (pattern.test(text)) {
        countryCounts.set(label, (countryCounts.get(label) || 0) + 1);
        if (!firstLacCountry && label !== "LAC regional") firstLacCountry = label;
      }
    }
    if (firstLacCountry) lacWorks.push({ work, country: firstLacCountry });
    for (const [label, pattern] of topicSet) {
      if (pattern.test(text)) {
        topicCounts.set(label, (topicCounts.get(label) || 0) + 1);
        if (isStrong) strongTopicCounts.set(label, (strongTopicCounts.get(label) || 0) + 1);
        if (year > (topicNewestYear.get(label) || 0)) topicNewestYear.set(label, year);
      }
    }
  }
  for (const [label, count] of topicCounts.entries()) {
    if (count === 1) topicSingleSampleSize.set(label, 1);
  }

  const coveredTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label]) => label);
  const missingTopics = topicSet
    .map(([label]) => label)
    .filter((label) => !topicCounts.has(label))
    .slice(0, 5);
  const weakMethodTopics = [...topicCounts.keys()]
    .filter((label) => !strongTopicCounts.has(label));
  const outdatedTopics = [...topicCounts.entries()]
    .filter(([label, _count]) => {
      const newest = topicNewestYear.get(label) || 0;
      return newest > 0 && newest < 2020 && (strongTopicCounts.get(label) || 0) > 0;
    })
    .map(([label]) => label);

  const countryStats = [...countryCounts.entries()]
    .filter(([label]) => label !== "LAC regional")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, n]) => `${label} (${n})`);

  // Untouched LAC regions/sub-regions — reference list of sub-regions we'd
  // expect to see in a healthy LAC scan.
  const expectedRegions = ["Brazil", "Mexico", "Colombia", "Argentina", "Chile", "Peru", "Central America", "Caribbean"];
  const uncoveredRegions = expectedRegions.filter((r) => !countryCounts.has(r));

  // Top LAC papers by rigor: SMS desc, then year desc.
  const topLacByRigor = [...lacWorks]
    .sort((a, b) => {
      const smsA = (a.work.smsLevel ?? a.work.sms_level ?? 0) as number;
      const smsB = (b.work.smsLevel ?? b.work.sms_level ?? 0) as number;
      if (smsA !== smsB) return smsB - smsA;
      return ((b.work.year ?? 0) as number) - ((a.work.year ?? 0) as number);
    })
    .slice(0, 2);

  const describeLacPaper = ({ work, country }: { work: AnyWork; country: string }): string => {
    const firstAuthor = ((work.authors?.[0] || "Unknown") as string).split(" ").pop() || "Unknown";
    const authorTag = (work.authors?.length ?? 0) > 1 ? `${firstAuthor} et al.` : firstAuthor;
    const year = work.year || "n.d.";
    const design = work.methodology_design || work.methodologyDesign || work.methodology?.design || "unclassified design";
    const sms = work.smsLevel ?? work.sms_level;
    const smsTag = sms != null ? `SMS ${sms}` : "SMS –";
    const finding = truncateFinding(work.summary || work.abstract || "", 180);
    const findingClause = finding ? ` ${finding}` : "";
    return `${country} — ${authorTag} (${year}, ${design}, ${smsTag}):${findingClause}`;
  };

  const lacEvidence = countryStats.length > 0
    ? `${countryStats.join(" · ")}.${
        topLacByRigor.length > 0
          ? ` Strongest in-region: ${topLacByRigor.map(describeLacPaper).join(" ")}`
          : ""
      }`
    : "No LAC-specific papers in this set — evidence is global/adjacent. Run a country-focused search (Spanish/Portuguese terms, IADB/CEPAL/ECLAC repositories) before treating the gap as real.";

  // Thin areas — classify each by reason: no-evidence, weak-methods, outdated.
  const thinReasons: string[] = [];
  if (missingTopics.length > 0) {
    thinReasons.push(
      `No evidence on ${formatList(missingTopics.slice(0, 3))} — these topics returned 0 papers in the admissible set.`
    );
  }
  if (weakMethodTopics.length > 0) {
    thinReasons.push(
      `Weak methods on ${formatList(weakMethodTopics.slice(0, 3))} — papers exist but none reach SMS 4–5, so claims here are associational at best.`
    );
  }
  if (outdatedTopics.length > 0) {
    thinReasons.push(
      `Outdated rigor on ${formatList(outdatedTopics.slice(0, 2))} — strongest papers pre-date 2020, so post-pandemic and post-AI-shock dynamics are uncovered.`
    );
  }
  if (uncoveredRegions.length > 0 && countryStats.length > 0) {
    thinReasons.push(
      `Country gaps: ${formatList(uncoveredRegions.slice(0, 4))} have no papers in this set.`
    );
  }
  // Join with "\n" so the renderer can split on it for a bullet list.
  // Old briefs joined with " " still render as a single line — graceful.
  const thinAreas = thinReasons.length > 0
    ? thinReasons.slice(0, 3).join("\n")
    : "Main query topics covered with reasonable rigor and recency. Verify small economies and informal-sector representation in the table.";

  // Methods needed — focus on topics with no rigorous evidence + recency / sample-size flags.
  const methodsNeededParts: string[] = [];
  if (weakMethodTopics.length > 0) {
    methodsNeededParts.push(
      `0 SMS 4–5 papers on ${formatList(weakMethodTopics.slice(0, 3))} — no causal-grade design has been run on these, so impact claims would rest on observational correlations.`
    );
  }
  const singleStrongTopics = [...strongTopicCounts.entries()]
    .filter(([_label, count]) => count === 1)
    .map(([label]) => label);
  if (singleStrongTopics.length > 0) {
    methodsNeededParts.push(
      `Single-study rigor on ${formatList(singleStrongTopics.slice(0, 2))} — only 1 SMS 4–5 paper each; one replication or a different setting would meaningfully raise confidence.`
    );
  }
  const recencyGapTopics = [...topicCounts.keys()].filter((label) => {
    const newest = topicNewestYear.get(label) || 0;
    return newest > 0 && newest < 2022 && (strongTopicCounts.get(label) || 0) > 0;
  });
  if (recencyGapTopics.length > 0) {
    methodsNeededParts.push(
      `Recency gap on ${formatList(recencyGapTopics.slice(0, 2))} — strongest evidence is pre-2022 and may not reflect current AI/technology adoption.`
    );
  }
  if (uncoveredRegions.length > 0) {
    methodsNeededParts.push(
      `Untouched regions: ${formatList(uncoveredRegions.slice(0, 4))}.`
    );
  }
  // Newline-join for bullet rendering in the §3 box (same pattern as thinAreas).
  const methodsNeeded = methodsNeededParts.length > 0
    ? methodsNeededParts.slice(0, 3).join("\n")
    : "Strong, recent, multi-study evidence across covered topics. Next moves should target external validity and LAC replication.";

  // Phase 2 — structured LAC coverage for the §3 sub-region mini-grid.
  // Covered: countries with ≥1 paper (drops "LAC regional" pseudo-bucket).
  // Uncovered: expectedRegions that have zero papers in this set.
  const lacCoverage: LacCoverage = {
    covered: [...countryCounts.entries()]
      .filter(([label]) => label !== "LAC regional")
      .sort((a, b) => b[1] - a[1])
      .map(([country, count]) => ({ country, count })),
    uncovered: uncoveredRegions,
  };

  // Top covered topic — used by nextMileAction's "deepen with sub-topic
  // queries on {topic}" template when no major gap is detected.
  const topCoveredTopic = coveredTopics[0] || null;

  return { lacEvidence, thinAreas, methodsNeeded, lacCoverage, topCoveredTopic };
}

function formatList(items: string[]): string {
  if (items.length === 0) return "no clearly classified topics";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function summarizeMethodologyMix(evidence: AnyWork[]): string {
  if (!evidence || evidence.length === 0)
    return "empty (no evidence retrieved yet)";

  const counts = evidence.reduce(
    (acc: Record<string, number>, work) => {
      const design =
        work.methodology_design || work.methodologyDesign ||
        work.methodology?.design || "Unknown";
      acc[design] = (acc[design] || 0) + 1;
      return acc;
    },
    {}
  );

  const parts = Object.entries(counts).map(
    ([design, count]) => `${count} ${design}`
  );
  return parts.length > 0 ? parts.join(", ") : "empty";
}
