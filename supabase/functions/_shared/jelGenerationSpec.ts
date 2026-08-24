// deno-lint-ignore-file no-explicit-any
/**
 * JEL survey-paper generation CONTRACT — single source of truth.
 *
 * These blocks are the model-independent rules for how a JEL section is written
 * (citation fence, citation-context calibration, framing allowance, output shape).
 * They are consumed by TWO places, which therefore cannot drift:
 *   1. The server pipeline — `buildSectionPrompt()` in jelPaperPipeline.ts spreads
 *      these arrays into the Section-Drafter system prompt (Gemini/Qwen).
 *   2. The Claude Code plugin — `GET /api/generation-spec` serves the composed
 *      document (built by `buildJelGenerationSpec()`), and the plugin's local
 *      Claude drafts against it.
 *
 * 🔒 INVARIANT: change the writing contract HERE, not inline in a builder. The
 * verbatim arrays below are spread into the live prompt, so editing them changes
 * BOTH the server output and the plugin — that's the point. Keep entries as exact
 * prompt lines (no trailing whitespace surprises); they are joined with "\n".
 *
 * The DYNAMIC, evidence-parameterized minimums (coreCiteMin = ceil(coreCount×0.8),
 * design-channel ≥50%, overall ≥60% capped) stay computed in server code — they
 * depend on the specific evidence set and cannot be a frozen string. They are
 * stated here as POLICY prose (JEL_SPREAD_POLICY) for the plugin, which applies
 * the policy selectively rather than to a precomputed count.
 */

/** Bumped when the contract changes — surfaced by GET /api/generation-spec so the
 *  plugin (and any cache) can tell which contract a paper was written against. */
export const JEL_SPEC_VERSION = "2026-07-09.1";

// --- VERBATIM blocks: spread into buildSectionPrompt AND served to the plugin ---

/** Author-year citation fence. */
export const JEL_CITATION_RULES: string[] = [
  "CITATION RULES (CRITICAL — JEL author-year style):",
  "- ALWAYS introduce a citation as 'Author (year) [workId]' — NEVER a bare [workId] alone.",
  "  Use the EXACT 'authors' field given for that workId in the EVIDENCE block — do NOT guess, recall, or invent author names from memory. A wrong author name is a citation error even when the [workId] is correct. If 'authors' is n/a, attribute by the work's title, never a fabricated name.",
  "  Example: 'Acemoglu and Restrepo (2018) [10.1257/jep.33.2.3] find that...'",
  "  Example: '...reduces employment by 0.2pp (Acemoglu and Restrepo 2018) [10.1257/jep.33.2.3].'",
  "  The [workId] tag MUST appear immediately after the author-year text — never on its own.",
  "- Use the exact workId string from the EVIDENCE block. NEVER use [ss:DIGITS] alone.",
  "- For works with 1-2 authors: 'Autor and Salomons (2018)'. For 3+: 'Acemoglu et al. (2022)'.",
  "- Every empirical claim MUST carry at least one author-year [workId] citation.",
  "- Do NOT invent papers, authors, years, or workIds. Do NOT copy verbatim sentences from any source paper — paraphrase and synthesize.",
];

/** Static spread rules (the dynamic per-section minimums are computed in code). */
export const JEL_SPREAD_RULES: string[] = [
  "- No single workId may appear more than 2 times in this section.",
  "- Do NOT anchor on just the top 3-4 papers. If a claim is supported by multiple papers, cite ALL of them.",
  "- Explicitly address papers with different designs or contradictory findings — a JEL survey must show the full evidence landscape, not just the consensus.",
  "- Stay on the article's topic as set by the title and outline. Do NOT introduce themes that are not represented in the evidence corpus.",
];

/** Match language strength to evidence type. */
export const JEL_CITATION_CONTEXT_RULES: string[] = [
  "CITATION CONTEXT RULES — match language strength to evidence type (evidence metadata is in the EVIDENCE block below):",
  "- FOUNDATIONAL (year ≤ 2010, high sms OR high citation count in its era): Field-accepted baseline. 'The seminal work of Author (year) established...' — stated with confidence. Do NOT penalize for pre-causal-inference methodology; citation count signals field acceptance.",
  "- CAUSAL (sms ≥ 4, design: RCT / DiD / IV / RDD): A single rigorous causal study justifies a confident attributed claim: 'A large-scale RCT by Author (year) [workId] demonstrates...' Multiple consistent causal studies: 'Strong evidence shows...' Contradicting causal studies: name both and explain the difference in context or population.",
  "- RECENT + RIGOROUS (year ≥ 2023, sms ≥ 3): Rigorous but not yet widely replicated. Low citation count is a recency artifact, NOT a quality signal. 'Recent rigorous evidence from Author (year) [workId] finds... though replication is limited.'",
  "- RECENT + OBSERVATIONAL (year ≥ 2023, sms ≤ 2): 'Emerging evidence from Author (year) [workId] suggests...'",
  "- OBSERVATIONAL / LOW SMS (sms ≤ 2): Always hedge: 'Evidence from Author (year) [workId] suggests...' Never state as established fact from a single low-rigor study.",
  "- MULTI-PAPER THRESHOLD: A claim may be stated without per-paper attribution ONLY if ≥ 3 papers in the evidence set support it. For 1–2 papers, always name the source(s) explicitly.",
  "- CONTRADICTIONS: When papers disagree, name both sides and explain why (context, population, identification strategy). Never smooth over genuine scientific disagreement.",
];

/** Framing-prose allowance (gated by DOSSIER_ENRICH in the server; always part of
 *  the served contract for the plugin). */
export const JEL_FRAMING_PROSE_RULE =
  "FRAMING PROSE (allowed — for narrative arc): You MAY add brief NON-EMPIRICAL framing, background, theory, and institutional-context sentences to set up the literature, define concepts, and connect empirical blocks — drawing on the 'context' notes in the EVIDENCE block. HARD LIMIT: every EMPIRICAL claim (any number, magnitude, effect size, or verb like found/shows/estimates/reduces/increases) MUST still carry an author-year [workId] citation to a paper in the EVIDENCE block. Context notes are NOT citable — NEVER attach a [workId] to a claim whose only source is a context note. Framing serves the evidence; it does not replace citations.";

/** Section output shape. */
export const JEL_SECTION_OUTPUT_RULE =
  "OUTPUT — return ONLY the section body as plain prose in flowing paragraphs, then STOP. HARD FORMAT RULES (a violation makes the section unusable): " +
  "(1) NO markdown of any kind — no '#'/'##'/'###'/'####' headings or sub-headings, no bullet or numbered lists, no bold or italic markers ('**', '*', '__'), no code fences, no JSON. " +
  "(2) Do NOT repeat or restate the section heading or its number (no '§2', no 'Section 2', no title line). " +
  "(3) Do NOT write a paper-by-paper catalogue or annotated bibliography — one entry per study is forbidden. Even when the scope says to 'categorize', 'overview', or 'summarize the evidence base', you MUST synthesize it into connected paragraphs that compare and contrast studies in continuous prose (e.g. 'The causal evidence divides between RCTs such as Author (year) [id] and difference-in-differences work like Author (year) [id], which together suggest…'), NOT a list. " +
  "Just the ready-to-read prose with inline 'Author (year) [workId]' citations.";

// --- POLICY prose: served to the plugin (the server implements these as computed
//     numeric minimums in code; here they are stated as rules the model applies). ---

export const JEL_SPREAD_POLICY = [
  "CITATION SPREAD & CITE-WHAT-MATTERS (quality over coverage):",
  "- Cite SELECTIVELY, not exhaustively — a real JEL survey omits weak/peripheral papers rather than forcing them in. Forcing a low-information paper in is WORSE than omitting it.",
  "- Prioritise CORE papers: relevant to the section AND credible under at least one channel — causal (sms≥3), foundational (citations≥75 & year<2020), recent (year≥2020 & sms≥3), or region-relevant (LAC geography + on-topic content). Cite the large majority of the section's CORE papers.",
  "- Cite supporting papers only where they add distinct evidence (a mechanism, a contrast, a context). You MAY omit peripheral (thin/off-topic) papers entirely.",
  "- DESIGN-CHANNEL: where a section expects specific designs (RCT/DiD/IV/RDD), cite a solid share of the design-matched papers — do not skip the rigorous studies.",
  "- CHANNEL MIX: when the evidence spans multiple channels (causal/foundational/recent/region), represent each where the topic allows — do not collapse a section onto one channel.",
].join("\n");

export const JEL_STRUCTURE = [
  "STRUCTURE:",
  "- Title + 200–250 word abstract stating the question, scope, and headline synthesis.",
  "- Introduction: the policy problem in concrete numbers, why it matters for Latin America & the Caribbean, and what the paper covers.",
  "- Thematic body sections organised by mechanism / question / debate (NOT a paper-by-paper list) — the whole paper is 3–7 numbered sections total (Introduction + thematic body + Synthesis), the pipeline's hard cap. Per section: state the claim, marshal the evidence with citations, note methodology strength and where evidence is thin or contested.",
  "- Synthesis / implications for LAC: what the body implies for policy; quantify; name the countries/contexts the evidence covers and the gaps it leaves.",
  "- WORKS CITED (footer, MANDATORY): a table of ONLY the papers actually cited in prose, columns #, Authors (Year), Title, Method, SMS, DOI. Render DOI as https://doi.org/<doi> using the paper's canonical doi; if absent, use https://doi.org/<workId> when the workId is a 10.* DOI, else \"—\". Do NOT append a full all-papers table.",
].join("\n");

export const JEL_VOICE_TECHNICAL =
  "VOICE: IADB-grade, precise, evidence-first, technical register. Quantify claims; name specific countries and study designs; be candid about evidence quality and gaps. No marketing language, no hedging filler.";

export const JEL_VOICE_POLICY =
  "VOICE: IADB Policy Brief register — open with the scale of the challenge in hard numbers, then evidence, then policy levers, then LAC implications. Prescriptive, country-specific, every claim quantified.";

// Quality self-review — the plugin's single-model analog of the server's
// Devil's-Advocate / claim-audit / coherence / Corrector passes. Run it AFTER
// the first full draft, then revise. (The server runs these as separate LLM
// passes; one capable model can do them as a review-and-revise pass.)
export const JEL_QUALITY_REVIEW = [
  "QUALITY SELF-REVIEW (MANDATORY — after the first full draft, run this COMPLETE pass, then revise. It mirrors the app's full QA suite — section recovery, claim audit, Devil's Advocate, coherence, Kris DOI check, corpus-gap weaving, Corrector, final review — performed here by one capable model):",
  "- COMPLETENESS (section recovery): every outlined section has substantive content. Re-draft any section that is blank, near-empty, or cut off mid-sentence (no truncated sections; each ends cleanly). If a section genuinely has no supporting evidence, drop it cleanly rather than leave a blank heading.",
  "- CLAIM AUDIT (all cited claims): check EVERY cited claim against the cited paper's evidence. Triage each problem: keep / soften / re-attribute to the correct paper / remove — removal is the LAST resort, and when unsure, KEEP. Never leave an unsupported claim.",
  "- DEVIL'S ADVOCATE: adversarially attack the draft — single-study findings stated as fact, causal language on observational results, ignored contradictory evidence, cherry-picking, over-claiming for LAC from non-LAC evidence. Hedge to match each study's rigor, name genuine disagreements, add the counter-evidence that exists in the set.",
  "- COHERENCE: one connected argument; consistent terminology/definitions; no internal contradictions; the abstract matches the body; citations diversified across sections (not the same 2–3 papers everywhere).",
  "- CITATION SPREAD / CITE-WHAT-MATTERS: cite the CORE (relevant + credible) papers and represent each active evidence channel; don't over-rely on a few; don't force in peripheral papers.",
  "- CORPUS-GAP WEAVING: where a section is thin, weave in relevant UNCITED papers already in the evidence set rather than leaving the gap — never invent a source to fill it.",
  "- CITATION-RETENTION (on revision): when you rewrite a passage, do NOT strip its [workId] citations — a rewrite that drops citations is worse than the original.",
  "- DOI / KRIS CHECK: every cited [workId] exists in the evidence set (the fence) and renders a real DOI in Works Cited; flag any that cannot resolve to a DOI.",
  "- ATTRIBUTION: every author name is verbatim from the evidence block — no fabricated author-year labels.",
  "- FINAL REVIEW: a last read-through — each section delivers a clear 'so what', the paper meets IADB-grade standard, and nothing is fabricated.",
].join("\n");

/**
 * Plugin-only evidence enrichment via Claude web_search. NOT spread into the
 * app's buildSectionPrompt — the app enriches from work_dossiers (full text /
 * Gemini-grounded) at draft time; the plugin's local Claude does the equivalent
 * with its own web_search on the user's subscription. Narrow, fence-safe carve-out.
 */
export const JEL_ENRICHMENT_POLICY = [
  "EVIDENCE ENRICHMENT (web_search — for CITED papers only; NOT a citation-fence exception):",
  "- You MAY use web_search to recover effect sizes, sample, identification, caveats, or findings that a CITED paper's abstract omits — i.e. THAT paper's OWN reported results that a survey reader expects.",
  "- ACCEPT a web-found number ONLY if the source EXPLICITLY names that exact paper (its title, OR its authors AND year) — prefer the paper itself (working-paper or published version) or a review/replication that cites it by name. If you are not certain a number is from THAT paper, do NOT use it.",
  "- HEDGE every web-sourced magnitude: 'the study reports approximately +0.2 SD ...' — web-sourced numbers are not read from the full text and carry lower confidence than a number shown in the evidence block.",
  "- The number stays attributed to that paper's [workId]; you are DEEPENING a cited paper, not adding a new source or a free-floating fact.",
  "- NEVER attach a web number to a paper the source does not name. NEVER add general background facts that are not a specific cited paper's own result. The fence (cite only in-set workIds; invent nothing) is unchanged.",
].join("\n");

/**
 * Evidence segmentation — Core / Context / Off (2026-06-25). The app computes this
 * server-side (topicalitySegmenter.ts) and shows it on the brief table; the plugin's
 * local Claude does the equivalent over its bundle. Validated offline (eval-core-bar-ab):
 * loose CORE bar, generous OFF, region/time stripped from the topic → 0 false-drops.
 */
export const JEL_SEGMENTATION_POLICY = [
  "EVIDENCE SEGMENTATION (Core / Context / Off — drives the evidence-table tier + section emphasis):",
  "- FIRST derive the question's CORE topic = its primary OUTCOME + INTERVENTION/MECHANISM. STRIP geography/country/region, time period, and population — those are NEVER part of the topic for this judgment.",
  "- Label EACH evidence paper:",
  "  • CORE — directly studies the core OUTCOME (the intervention/mechanism may be implicit, and ANY country or era counts).",
  "  • CONTEXT — relates to at least one key concept, or an adjacent outcome/mechanism (useful background).",
  "  • OFF — unrelated to EVERY key concept.",
  "🔴 GEOGRAPHY AND TIME PERIOD ARE IRRELEVANT to the label — a study of the topic in any country/era is CORE, never downgraded for being non-LAC or old. Be GENEROUS: partial concept coverage is CONTEXT, never OFF; use OFF only when unrelated to ALL concepts.",
  "- The combined evidence table gains a 'Tier' column (Core / Context / Off) and is ORDERED Core first, then Context, then Off. NEVER drop OFF rows — keep them, flagged, for analyst review.",
  "- Build the survey's argument on CORE papers; use CONTEXT for background/framing; do NOT cite OFF papers as core evidence (they stay in the table for transparency).",
].join("\n");

/**
 * Compose the full contract into the document served by GET /api/generation-spec
 * and followed by the plugin's local Claude. `audience` selects the voice block.
 */
export function buildJelGenerationSpec(audience: "technical" | "policy" = "technical"): string {
  const voice = audience === "policy" ? JEL_VOICE_POLICY : JEL_VOICE_TECHNICAL;
  return [
    `# JEL Survey Generation Spec (v${JEL_SPEC_VERSION})`,
    "",
    "You write an IADB-grade JEL-style survey paper over a FIXED evidence set. The",
    "evidence is the source of truth — synthesize it. Do NOT add free-floating outside",
    "facts; the ONE allowance is a CITED paper's own reported results (see Evidence",
    "Enrichment below). Cite ONLY works present in the evidence set, by their exact workId. This document is",
    "the authoritative writing contract; obey it exactly.",
    "",
    JEL_CITATION_RULES.join("\n"),
    "",
    JEL_CITATION_CONTEXT_RULES.join("\n"),
    "",
    JEL_ENRICHMENT_POLICY,
    "",
    JEL_SPREAD_POLICY,
    ...JEL_SPREAD_RULES,
    "",
    JEL_FRAMING_PROSE_RULE,
    "",
    JEL_SEGMENTATION_POLICY,
    "",
    JEL_STRUCTURE,
    "",
    voice,
    "",
    JEL_QUALITY_REVIEW,
    "",
    "FINAL SELF-CHECK: every [workId] you used exists in the evidence set; the Works",
    "Cited table lists only the papers you cited (with DOIs); no invented papers,",
    "authors, numbers, or findings; the quality self-review above has been applied.",
  ].join("\n");
}
