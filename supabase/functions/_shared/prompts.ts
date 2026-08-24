/**
 * supabase/functions/_shared/prompts.ts
 *
 * Prompt templates for the retrieval-augmented synthesis pipeline.
 * Pure string templates — no env vars, no external deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PersonaId =
  // Active audiences (Box 2 picker — 2026-05-21)
  | "technical"
  | "policy"
  // Retired — no longer selectable in UI. Kept in type so existing DB records
  // (briefs with auditTrace.persona = 'jel' etc.) still resolve correctly.
  | "non-technical"
  | "research"
  | "country-economist"
  | "sector-expert"
  | "operations"
  | "jel"
  | "twitter"
  | "talking-points";

// POLICY-ONLY: `policy` is the SOLE active brief register. Every NEW brief is a
// policy brief; the request `persona` field is ignored for generation (see
// resolvePersona). Retired personas remain in the PersonaId type purely so
// existing DB records (briefs with auditTrace.persona='technical'/'twitter'/etc.)
// still resolve a label and render without crashing.
export const PERSONA_IDS: PersonaId[] = [
  "policy",
];

// The summary brief is ALWAYS the IADB Policy Brief register (see CLAUDE.md
// "Search UX flow"). resolvePersona() coerces any requested/stored persona to
// this value for generation. Keep in sync with DEFAULT_PERSONA in types.ts
// (the frontend copy — cross-runtime files can't share an import).
// NOTE: the JEL survey paper / Paper Studio does NOT read this — it pins its
// own emphasis.audience='technical' in the seeded plan, so this value never
// affects JEL register.
export const DEFAULT_PERSONA: PersonaId = "policy";

interface QueryPlanningInput {
  query: string;
  filters: {
    topics?: string[];
    regions?: string[];
    methodology?: string[];
  };
}

interface SynthesisEvidenceRow {
  workId: string;
  finding: string;
  evidenceMatch?: 'direct-lac' | 'direct-global' | 'indirect';
}

interface SynthesisInput {
  query: string;
  evidenceRows: SynthesisEvidenceRow[];
  coverage: {
    universeCount: number;
    retrievedCount: number;
    admissibleCount: number;
  };
  persona?: PersonaId;
  // Population focus chosen on the pre-search clarifying card.
  // Accepts the new string[] form or the legacy string from saved runs.
  // SYNTHESIS-EMPHASIS ONLY — never a retrieval predicate.
  populationFocus?: string | string[];
}

// Local back-compat normalizer (cannot import from root types.ts across the
// Deno/TSX boundary — mirrors normalizePopulationFocus in types.ts exactly).
function _normalizePopulationFocus(v: string | string[] | undefined | null): string[] {
  const arr = v == null ? [] : Array.isArray(v) ? v : [v];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = (s ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt versions
// ---------------------------------------------------------------------------

export const promptVersions: Record<string, string> = {
  queryPlanning: "v1",
  // sourceScreening/methodologyTagging retired 2026-07-06: they re-serialized
  // every evidence title (a 3rd and 4th time) into the synthesis prompt for no
  // information gain — design + SMS now ride on the single EVIDENCE block line.
  synthesis: "v3",
  alertSummary: "v1",
};

// ---------------------------------------------------------------------------
// Persona instructions
// ---------------------------------------------------------------------------

// POLICY-ONLY: `policy` is the only ACTIVE brief register, so it is the only
// prompt-family instruction block we ship. The retired-persona instruction
// blocks (technical / research / non-technical / country-economist /
// sector-expert / operations / jel / twitter / talking-points) were removed
// 2026-06-03 — they only ever fed brief generation, which is now always policy.
// resolvePersona() coerces everything to `policy`, and geminiClient falls back
// to `policy` for any persona not present in this map, so stored briefs with a
// retired persona still synthesize/label safely. The PersonaId TYPE keeps the
// retired members for DB back-compat.
export const personaInstructions: Partial<Record<PersonaId, string>> = {
  policy: [
    "PERSONA: IADB Policy Brief author — decision-ready brief for policy specialists, sector economists, and country teams.",
    "REGISTER: IDB Policy Brief style. 2-3 page synthesis with thematic sections, concrete numbers, LAC-first framing. Written for a reader who knows the topic but needs a synthesis of what the evidence says and what to do with it.",
    "",
    "MATCH THIS STYLE: IDB Policy Briefs (e.g. IDB-PB series). Open with the challenge at scale, move to what the evidence shows, close with policy levers and country-specific implications.",
    "",
    "HARD RULES:",
    "- EVERY summaryBullets string MUST start with a bold thematic header. Output shape: '**The challenge:** prose prose prose [workId].' Choose the header to fit the content — '**LAC evidence:**', '**What works:**', '**Implementation risks:**', etc. Do NOT use a fixed set of headers each time. Do NOT return an object — each bullet is a plain string starting with bold markdown.",
    "- Open with the SCALE of the challenge in hard numbers ('An estimated 20-40% of health spending is wasted globally... in LAC this means...'). Policy readers need the stakes before the evidence.",
    "- Name specific countries when the evidence permits. Never say 'the region' when you can say 'Brazil, Colombia, and Mexico'. If evidence is thin on LAC, say so explicitly.",
    "- Quantify every major claim: percentage points, GDP share, lives saved, program cost per beneficiary, poverty headcount impact. Prose without numbers is not a policy brief.",
    "- Use prescriptive language: 'countries should', 'governments need to', 'the evidence supports X policy'. Do not hedge unless the evidence is genuinely contested.",
    "- Acknowledge political economy where evidence speaks to it: feasibility constraints, distributional tradeoffs, implementation risks.",
    "- Acknowledge evidence quality in plain language: 'The strongest evidence — three RCTs in Brazil and Colombia — supports this finding. Results from observational studies should be treated as indicative.' Do not use SMS numbers or jargon.",
    "- Cite [workId] inline for specific findings. NEVER fabricate citations.",
    "",
    "SECTION TARGETS:",
    "- abstractSummary: 3-4 sentences. S1: open with the challenge + scale (numbers). S2: bottom-line policy answer, directly. S3: key condition, caveat, or LAC-specific finding. No hedging opener like 'The evidence suggests...' — state the finding.",
    "- summaryBullets: 5-7 thematic sections, each with a bold header and 3-4 sentences. Tell a coherent story across the sections: Challenge → Evidence → What works → Where it fails → LAC context → Policy levers → Next steps. Sections should build on each other, not be independent bullets.",
    "- methodologyNote: ONE sentence in plain policy language (no SMS tiers or jargon). State what the evidence CAN and CANNOT support for policymakers. Must reference at least one concrete number. Example: 'Three RCTs from Brazil and Mexico support the core finding; evidence on long-run effects and scale-up is still limited to observational studies.'",
    "- followUpQuestions: 3-4 questions framed as 'Would this work in your country given X?' or 'What data do you need to estimate Y?' — country-team questions, not research agenda items.",
  ].join("\n"),
};

// POLICY-ONLY: brief generation is always policy. resolvePersona() ignores the
// requested/stored persona for generation and returns DEFAULT_PERSONA ('policy').
// The argument is retained only so callers that pass a stored persona (e.g. the
// audit trail of an existing brief) don't break; it has no effect on output.
function resolvePersona(_persona?: PersonaId): PersonaId {
  return DEFAULT_PERSONA;
}

function methodologyInstructionForPersona(persona: PersonaId): string {
  if (persona === "non-technical") {
    return [
      "Methodology note for Plain language:",
      "Use everyday language to explain how much confidence the reader should have.",
      "Say whether the evidence comes from fair comparisons, before/after comparisons, or mostly descriptive studies.",
      "Avoid unexplained jargon such as SMS, identification, external validity, log points, or standardized effects.",
      "If you mention a design acronym such as RCT or DiD, define it immediately in plain words.",
      "Use stronger/weaker studies language instead of methods shorthand when possible.",
    ].join(" ");
  }
  if (persona === "policy") {
    return "Methodology note for Policy team: one sentence on how the evidence quality affects decision confidence, using light design language only when useful.";
  }
  if (persona === "research") {
    return "Methodology note for Research agenda: one sentence on the missing design, data, or identification feature that most limits the next research agenda.";
  }
  return "Methodology note for Technical review: one sentence on SMS distribution, study designs, and causal limits, using precise methods language.";
}

// ---------------------------------------------------------------------------
// Prompt families
// ---------------------------------------------------------------------------

export const promptFamilies = {
  queryPlanning({ query, filters }: QueryPlanningInput): string {
    return [
      "You are the Discovery Agent for Horizon Scanner.",
      "Return only the planning frame for retrieval.",
      `Query: ${query}`,
      `Topics: ${(filters.topics ?? []).join(", ") || "none"}`,
      `Regions: ${(filters.regions ?? []).join(", ") || "none"}`,
      "Expand entities, synonyms, geography, and timeframe without making claims.",
    ].join("\n");
  },

  // sourceScreening + methodologyTagging families retired 2026-07-06 — see
  // promptVersions note. Their only unique signal (per-paper design) now rides
  // on the single EVIDENCE block line in geminiClient.buildUserPrompt.

  synthesis({ query, evidenceRows, coverage, persona, lang, populationFocus }: SynthesisInput & { lang?: 'en' | 'es' | 'pt' }): string {
    const resolved = resolvePersona(persona);
    const top = evidenceRows[0];
    const topAnchor = top
      ? `STRONGEST_EVIDENCE_BY_RIGOR: workId=${top.workId} — this is the user-visible #1 paper in the evidence table (sorted by methodological rigor, descending). The Methodology Note MUST cite this paper as the strongest evidence by rigor; do not nominate any other paper as "strongest" or "highest-rigor". Other sections may freely reference any paper.`
      : "";

    // Dynamic citation balance — computed from classification labels on each row.
    const directLacCount  = evidenceRows.filter((r) => r.evidenceMatch === 'direct-lac').length;
    const directGlobalCount = evidenceRows.filter((r) => r.evidenceMatch === 'direct-global').length;
    const totalDirect = directLacCount + directGlobalCount;
    const indirectCount = evidenceRows.filter((r) => r.evidenceMatch === 'indirect').length;
    // Min direct citations: use all available if ≤25; otherwise 50% of the direct set.
    const minDirectCites = totalDirect <= 25
      ? totalDirect
      : Math.ceil(totalDirect * 0.5);
    const hasClassification = totalDirect + indirectCount > 0;
    // Citation-spread scales with TABLE SIZE (2026-06-17): the relevance floor can
    // return a short table (e.g. 12 papers), and "cite ≥12 distinct" is impossible
    // then. Require ceil(0.6 × tableSize), floored at 4, capped at the original 12.
    const spreadMin = Math.min(12, Math.max(4, Math.ceil(evidenceRows.length * 0.6)));

    const citationBalance = hasClassification ? [
      `EVIDENCE CLASSIFICATION: ${totalDirect} DIRECT papers (${directLacCount} [DIRECT-LAC] + ${directGlobalCount} [DIRECT-GLOBAL]) and ${indirectCount} [INDIRECT] (mechanism/contextual) papers.`,
      `CITATION BALANCE (HARD — failure to follow = low-quality brief):`,
      `- [DIRECT-LAC] and [DIRECT-GLOBAL] papers are the PRIMARY SPINE of the brief. Open every substantive causal claim with direct evidence. Cite them first.`,
      `- Minimum direct citations: cite at least ${minDirectCites} distinct [DIRECT-LAC]/[DIRECT-GLOBAL] workIds across the full brief.${totalDirect <= 25 ? " All available direct papers — use every one." : ` That is 50% of the ${totalDirect} direct papers available.`}`,
      `- Mechanisms section (bullet 3): draw heavily from [INDIRECT] papers — they provide the clearest mechanism signal. Explain what indirect evidence tells us about WHY or WHERE effects operate.`,
      `- No single workId may appear in more than 2 bullets.`,
      `- When multiple papers show the same result, cite them together: "Three RCTs in LAC [A][B][C] find..." — do NOT collapse a body of evidence to 1-2 citations.`,
      `- Spread citations across designs, time periods, and countries. After drafting, count your unique [workId] tags — if fewer than ${minDirectCites} direct papers cited, scan the lower-ranked papers in the evidence list and incorporate their specific findings.`,
    ].join("\n") : [
      `CITATION SPREAD (HARD): The summaryBullets collectively MUST cite at least ${spreadMin} distinct workIds (the evidence table has ${evidenceRows.length} papers). No single workId may appear in more than 2 bullets. When multiple papers find the same result, cite them together ("Studies in Brazil [A], Mexico [B], and Colombia [C] find...") — do not collapse a body of evidence to 1-2 citations. After drafting, count your unique [workId] tags — if fewer than ${spreadMin}, scan the lower-ranked papers in the evidence list and incorporate specific findings you have not yet cited.`,
    ].join("\n");

    // Language directive — applies to all narrative fields. Paper titles,
    // author names, and [workId] citations stay in their original form.
    // Strengthened 2026-05-10: was overridden by persona-specific English
    // phrasing rules ("EVERY bullet starts with…"). Now imperative, ALL
    // CAPS, repeated, and reinforced before each section directive.
    const langName = lang === 'es' ? 'SPANISH (español)' : lang === 'pt' ? 'PORTUGUESE (português brasileiro)' : '';
    const langDirective = (lang === 'es' || lang === 'pt')
      ? [
          `══════════════════ CRITICAL LANGUAGE REQUIREMENT ══════════════════`,
          `OUTPUT LANGUAGE: ${langName}`,
          `ALL narrative text in your JSON response MUST be in ${langName}.`,
          `This applies to EVERY field that contains prose: abstractSummary,`,
          `summaryBullets (each one), methodologyNote, coverageCard.gapSummary,`,
          `followUpQuestions (each one), warnings (each one), strongestEvidence.`,
          `Do NOT mix English and ${langName}. Do NOT write in English then`,
          `translate. Generate directly in ${langName} academic prose.`,
          `EXCEPTIONS — these stay in their original language:`,
          `  • Paper titles when quoted in citations`,
          `  • Author surnames`,
          `  • [workId] citation tags like [ss:abc123] or [10.1234/abc]`,
          `  • Methodology design acronyms: RCT, DiD, IV, RDD, OLS, IPW`,
          `If a persona instruction below uses English example phrasing,`,
          `TRANSLATE the pattern into ${langName} — do not copy the English.`,
          `═══════════════════════════════════════════════════════════════════`,
        ].join('\n')
      : "";

    // Translate section-target phrasing when language is set so persona's
    // English example bullets don't tempt the model to output English.
    const sectionLangReminder = (lang === 'es' || lang === 'pt')
      ? `REMINDER: Every field below must be in ${langName}. The persona's bold-label examples ("**What worked:**", "**1. Foundational findings.**") translate to the equivalent ${langName} phrase.`
      : "";
    const methodologyInstruction = methodologyInstructionForPersona(resolved);

    // 2026-07-06: the per-row evidence text is NO LONGER serialized here. It
    // previously duplicated the full (uncapped) abstract of every paper on top
    // of the EVIDENCE block already present in geminiClient.buildUserPrompt —
    // the single largest token sink in brief generation (~2× the evidence).
    // The [DIRECT-LAC]/[DIRECT-GLOBAL]/[INDIRECT] tags now ride on the single
    // EVIDENCE block line; this family only computes the balance stats below.

    // Population focus (pre-search clarifying card, 2026-06-10). PRESCRIPTIVE
    // HARD RULE — synthesis emphasis only; retrieval is untouched by design
    // (eval 2026-06-10: population terms in retrieval are neutral-to-negative).
    // Normalise: handles legacy single-string or new string[] from the array type.
    const focusList = _normalizePopulationFocus(populationFocus);
    const focus = focusList.join(', ');
    const populationFocusRule = focus
      ? [
          `POPULATION FOCUS HARD RULE: The user asked this brief to focus on ${focus}.`,
          `(1) summaryBullets MUST prioritize findings that directly concern ${focus} when such evidence exists in the table.`,
          `(2) When a key claim rests on evidence NOT covering ${focus}, the bullet MUST say so explicitly (e.g. "evidence from adult populations").`,
          `(3) The coverage gapSummary MUST state how much of the evidence set covers ${focus}.`,
        ].join("\n")
      : "";

    const citationContextRules = [
      "CITATION CONTEXT RULES — match language strength to evidence type:",
      "- FOUNDATIONAL (year ≤ 2010 AND high citation count): Field-accepted baseline established before modern causal inference. State confidently and attribute: 'The seminal work of Author (year) [workId] established...' Do NOT penalize for pre-RCT methodology.",
      "- CAUSAL (SMS ≥ 4, design: RCT / DiD / IV / RDD): Gold standard. A single rigorous causal study justifies a confident attributed claim: 'A large-scale RCT by Author (year) [workId] demonstrates...' Multiple consistent causal papers: 'Strong evidence shows...' [workId1][workId2].",
      "- RECENT + RIGOROUS (year ≥ 2023, SMS ≥ 3): Rigorous but not yet widely replicated. Low citation count is a data artifact, NOT a quality signal. Language: 'Recent rigorous evidence from Author (year) [workId] finds... though independent replication is limited.'",
      "- RECENT + OBSERVATIONAL (year ≥ 2023, SMS ≤ 2): 'Emerging evidence from Author (year) [workId] suggests...'",
      "- OBSERVATIONAL / LOW SMS (SMS ≤ 2, any year): Always hedge: 'Evidence from Author (year) [workId] suggests...' Never state as established fact from a single study.",
      "- MULTI-PAPER THRESHOLD: A claim may be stated without per-paper attribution ONLY if ≥ 3 papers in the evidence set support it. For 1–2 papers, always name the source(s) explicitly.",
      "- CONTRADICTIONS: When papers disagree, name both sides explicitly. NEVER smooth over genuine scientific disagreement.",
    ].join("\n");

    return [
      langDirective,
      "You are the Synthesis Agent for Horizon Scanner.",
      "Return a fixed five-section brief with citations and warnings.",
      personaInstructions[resolved],
      sectionLangReminder,
      citationContextRules,
      citationBalance,
      populationFocusRule,
      `Query: ${query}`,
      "Evidence rows: use the EVIDENCE list above — each line carries the paper's workId, SMS level, design, and its [DIRECT-LAC] / [DIRECT-GLOBAL] / [INDIRECT] classification tag when available.",
      topAnchor,
      `Coverage: U=${coverage.universeCount}, R=${coverage.retrievedCount}, A=${coverage.admissibleCount}`,
      "Separate evidence from signals. Forbid uncited claims. Shape Summary Bullets, Methodology Note, and Follow-up Questions in line with the persona. Evidence Table and Coverage Card remain factual regardless of persona.",
      methodologyInstruction,
      "Coverage Card rules — write concise, query-specific prose for gapSummary, regionalGap, thinEvidenceAreas, and methodologicalGap. Keep funnel numbers exact.",
      "gapSummary: ONE sentence, ≤25 words. So-what for THIS query: what this evidence can/can't answer, anchored on at least one number from the coverage stats or evidence count. NO 'This can support', NO 'Use it to', NO 'Consider', NO generic policy-brief language. Must name the query topic.",
      langDirective ? `FINAL REMINDER: All narrative output in ${langName}. No English in any prose field.` : "",
    ].filter(Boolean).join("\n");
  },
  // POLICY-ONLY: the `twitterThread` prompt family was removed 2026-06-03 — the
  // twitter persona is retired and nothing calls it. The twitter brief path in
  // synthesis.ts is dead (resolvePersona never returns 'twitter') but kept
  // null-safe so DB-stored twitter briefs still render their cached threads.
};
