// Paper Studio — clarification & outline-preview engine.
// Produces evidence-derived clarifying questions, a refined working question,
// and a live draft outline from a plan's curated evidence. Gemini primary,
// Qwen fallback, graceful degrade to "use the query as-is".
//
// Reads works only; never writes the corpus (golden rule). The endpoints that
// call this persist results into jel_papers.plan.

// ── Shared question type (mirrors types.ts ClarifyingQuestion; redeclared here
//    so this Deno-only module stays self-contained) ──────────────────────────
export interface ClarifyingQuestion {
  q: string;
  options: string[];
  rationale: string;
}

import { callGemini, callQwen } from "./jelPaperPipeline.ts";

// LAC detection: a compact keyword/country set. (Later: import the canonical
// list used by topicGeoChannel.ts; duplicated small here to keep the engine
// self-contained.)
// Region terms are safe to substring-match (no common non-LAC place name
// contains them). Country terms must match a whole element (exact, or the
// element prefix before a comma) so "Jamaica Plain", "Panama City, FL",
// "Dominican University" etc. don't false-positive. ("lac" is intentionally a
// country/abbrev term, not a substring — "black"/"place" contain "lac".)
const LAC_REGION_TERMS = [
  "latin america", "caribbean", "south america", "central america",
];
const LAC_COUNTRY_TERMS = [
  "lac", "argentina", "bolivia", "brazil", "chile", "colombia", "costa rica",
  "cuba", "dominican republic", "ecuador", "el salvador", "guatemala", "haiti",
  "honduras", "jamaica", "mexico", "nicaragua", "panama", "paraguay", "peru",
  "uruguay", "venezuela", "trinidad and tobago", "barbados", "bahamas",
  "guyana", "suriname", "belize",
];

function isLac(geography: string[] | null | undefined): boolean {
  if (!geography || geography.length === 0) return false;
  return geography.some((g) => {
    const s = g.toLowerCase().trim();
    if (LAC_REGION_TERMS.some((t) => s.includes(t))) return true;
    return LAC_COUNTRY_TERMS.some((t) => s === t || s.startsWith(t + ","));
  });
}

function normDesign(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const s = String(raw).trim().toLowerCase();
  if (s === "rct" || s.includes("random")) return "RCT";
  if (s === "did" || s.includes("difference-in-diff") || s.includes("difference in differ") || s.includes("diff-in-diff")) return "DiD";
  if (s === "iv" || s.includes("instrumental")) return "IV";
  if (s === "rdd" || s.includes("discontinuity")) return "RDD";
  if (s.includes("matching") || s.includes("propensity")) return "matching";
  if (s.includes("quasi")) return "quasi-experimental";
  if (s.includes("observ")) return "observational";
  if (s.includes("simul")) return "simulation";
  if (s.includes("qual")) return "qualitative";
  if (s.includes("review") || s.includes("meta")) return "review";
  return "other";
}

export interface EvidenceWork {
  id: string;
  title?: string | null;
  year?: number | null;
  sms_level?: number | null;
  methodology_design?: string | null;
  geography?: string[] | null;
  citation_count?: number | null;
}

export interface EvidenceDistribution {
  total: number;
  byDesign: Record<string, number>;
  bySmsBand: { nonEmpirical: number; low: number; mid: number; high: number; unscored: number }; // 0 / 1-2 / 3 / 4-5 / null
  lac: number;
  nonLac: number;
  byDecade: Record<string, number>;
  foundational: number;       // citation_count >= 75 AND year < 2020
  recent: number;             // year >= 2020
  medianCitations: number;
}

// Deterministic — no LLM. This is the structured signal the LLM reasons over.
export function computeEvidenceDistribution(works: EvidenceWork[]): EvidenceDistribution {
  const byDesign: Record<string, number> = {};
  const byDecade: Record<string, number> = {};
  const band = { nonEmpirical: 0, low: 0, mid: 0, high: 0, unscored: 0 };
  let lac = 0, foundational = 0, recent = 0;
  const cites: number[] = [];

  for (const w of works) {
    const d = normDesign(w.methodology_design);
    byDesign[d] = (byDesign[d] ?? 0) + 1;

    const sms = w.sms_level;
    if (sms === 0) band.nonEmpirical++;
    else if (sms === 1 || sms === 2) band.low++;
    else if (sms === 3) band.mid++;
    else if (sms === 4 || sms === 5) band.high++;
    else band.unscored++; // null / undefined / out-of-range

    if (isLac(w.geography)) lac++;

    const y = w.year ?? null;
    if (y) {
      const dec = `${Math.floor(y / 10) * 10}s`;
      byDecade[dec] = (byDecade[dec] ?? 0) + 1;
      if (y >= 2020) recent++;
    }
    const c = w.citation_count ?? 0;
    if (c >= 75 && y !== null && y < 2020) foundational++;
    cites.push(c);
  }

  cites.sort((a, b) => a - b);
  const mid = Math.floor(cites.length / 2);
  const medianCitations = cites.length === 0
    ? 0
    : cites.length % 2 === 1
      ? cites[mid]
      : Math.round((cites[mid - 1] + cites[mid]) / 2);

  return {
    total: works.length,
    byDesign,
    bySmsBand: band,
    lac,
    nonLac: works.length - lac,
    byDecade,
    foundational,
    recent,
    medianCitations,
  };
}

function distributionToText(d: EvidenceDistribution): string {
  const designs = Object.entries(d.byDesign)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  const decades = Object.entries(d.byDecade)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  return [
    `Total evidence papers: ${d.total}`,
    `Methodology designs: ${designs}`,
    `Rigor (SMS bands): non-empirical(0):${d.bySmsBand.nonEmpirical}, low(1-2):${d.bySmsBand.low}, mid(3):${d.bySmsBand.mid}, high(4-5):${d.bySmsBand.high}, unscored:${d.bySmsBand.unscored}`,
    `Geography: LAC-tagged:${d.lac}, other/global:${d.nonLac}`,
    `Time: by decade ${decades}; foundational(cit>=75 & pre-2020):${d.foundational}; recent(2020+):${d.recent}`,
    `Median citations: ${d.medianCitations}`,
  ].join("\n");
}

// 5/10 pages × WORDS_PER_PAGE (500). Offers 5 or 10 pages only (2026-06-26) — no 2pg, no 20-30pg.
const LENGTH_OPTIONS = [2500, 5000];

type AlwaysAskStaplesShape = { audience: ("policy" | "technical")[]; lengthOptions: number[] };

function staples(): AlwaysAskStaplesShape {
  return { audience: ["policy", "technical"], lengthOptions: [...LENGTH_OPTIONS] };
}

// ── Clarify prompt ─────────────────────────────────────────────────────────
function buildClarifyPrompt(
  query: string,
  briefAbstract: string | null,
  briefBullets: string[],
  dist: EvidenceDistribution,
) {
  const system = [
    "You are the Framing Agent for the Horizon Scanner Paper Studio. A user wants to",
    "turn a body of retrieved economics evidence into a JEL-style survey paper. Your job",
    "is to help them SHARPEN the question before generation — not to write the paper.",
    "",
    "You are given: the user's query, an optional existing synthesis, and a DETERMINISTIC",
    "evidence distribution (counts by design, rigor band, geography, decade). Reason over",
    "the distribution — it is the ground truth about what the evidence can actually support.",
    "",
    "Produce questions that genuinely disambiguate scope, i.e. where the query is",
    "broader/narrower/different from what the evidence mix implies. Examples of a real",
    "disambiguation: query says 'global' but 80% of evidence is one region; query implies",
    "causal effects but most papers are descriptive; query names a mechanism the evidence",
    "barely covers. Always find at least 3 genuinely useful scoping dimensions.",
    "Never ask audience or length — those are collected separately.",
    "",
    "Also produce a refined workingQuestion (a crisp, survey-able restatement faithful to",
    "the evidence) and a DRAFT OUTLINE (a light preview: a title + 5–7 sections with one-line",
    "scope each). The outline must reflect the evidence distribution, not invent themes.",
    "expectedDesigns/section labels use canonical terms (RCT, DiD, IV, RDD, observational,",
    "review, descriptive).",
    "",
    "OUTPUT (JSON only, no markdown fences):",
    "{",
    '  "clarifyingQuestions": [ { "q": "...", "options": ["...","..."], "rationale": "...(why the evidence makes this worth asking)" } ],',
    '  "workingQuestion": "...",',
    '  "draftOutline": { "title": "...", "sections": [ { "number": 1, "heading": "...", "scope": "..." } ] }',
    "}",
    "Return 3–5 clarifyingQuestions (always find at least 3 genuinely useful scoping dimensions). Return 5–7 outline sections (7 is the hard maximum).",
  ].join("\n");

  const synthBlock = briefAbstract || briefBullets.length
    ? [
        "EXISTING SYNTHESIS (elaborate, do not pivot):",
        briefAbstract ?? "",
        ...briefBullets.slice(0, 6).map((b, i) => `${i + 1}. ${b}`),
        "",
      ].join("\n")
    : "(no prior synthesis — ground framing directly in the distribution)\n";

  const user = [
    `USER QUERY: ${query}`,
    "",
    synthBlock,
    "EVIDENCE DISTRIBUTION:",
    distributionToText(dist),
    "",
    "Produce the framing JSON per the rules above.",
  ].join("\n");

  return { system, user };
}

// ── Outline-preview prompt (re-run on plan edits; cheaper, no clarify Qs) ─────
function buildOutlinePreviewPrompt(
  workingQuestion: string,
  scope: { include: string[]; exclude: string[] },
  emphasis: { themes?: string[]; spotlightDebate?: string; audience?: string; targetWords?: number },
  dist: EvidenceDistribution,
) {
  const system = [
    "You are the Outline Preview Agent for the Horizon Scanner Paper Studio. Produce a",
    "LIGHT draft table of contents (a preview, not the final paper) for a JEL-style survey,",
    "grounded in the evidence distribution provided. Reflect the evidence; do not invent",
    "themes or designs the corpus lacks.",
    "",
    "Honor the user's framing: the working question is the north star; scope.include themes",
    "should be foregrounded and scope.exclude themes omitted; emphasis.themes bias section",
    "ordering/weighting; emphasis.spotlightDebate (if set) gets a dedicated section.",
    "",
    "OUTPUT (JSON only, no fences):",
    '{ "title": "...", "sections": [ { "number": 1, "heading": "...", "scope": "..." } ] }',
    "Return 5–7 sections (7 is the hard maximum). Last section is a research agenda. Section 1 is intro + positioning.",
  ].join("\n");

  const user = [
    `WORKING QUESTION: ${workingQuestion}`,
    `SCOPE include: ${scope.include.join(", ") || "(none)"}`,
    `SCOPE exclude: ${scope.exclude.join(", ") || "(none)"}`,
    `EMPHASIS themes: ${(emphasis.themes ?? []).join(", ") || "(none)"}`,
    `EMPHASIS spotlight debate: ${emphasis.spotlightDebate ?? "(none)"}`,
    `AUDIENCE: ${emphasis.audience ?? "policy"}   TARGET WORDS: ${emphasis.targetWords ?? 5000}`,
    "",
    "EVIDENCE DISTRIBUTION:",
    distributionToText(dist),
    "",
    "Produce the outline-preview JSON per the rules above.",
  ].join("\n");

  return { system, user };
}

// ── Generators (Gemini primary, Qwen fallback, graceful degrade) ─────────────

export interface DraftOutline {
  title: string;
  sections: { number: number; heading: string; scope: string }[];
}

export interface OutlinePreviewResult {
  outline: DraftOutline | null;
  degraded: boolean;
}

function validOutline(o: any): boolean {
  return o && typeof o.title === "string" && Array.isArray(o.sections) && o.sections.length >= 3;
}

function normalizeOutline(o: any): DraftOutline | null {
  if (!validOutline(o)) return null;
  return {
    title: String(o.title),
    sections: o.sections.map((s: any, i: number) => ({
      number: typeof s.number === "number" ? s.number : i + 1,
      heading: String(s.heading ?? `Section ${i + 1}`),
      scope: String(s.scope ?? ""),
    })),
  };
}

export interface ClarificationResult {
  clarifyingQuestions: ClarifyingQuestion[];
  alwaysAsk: AlwaysAskStaplesShape;
  workingQuestion: string;
  draftOutline: DraftOutline | null;
  degraded: boolean;
}

// ── Topic classifier for clarifying questions ──────────────────────────────
// Classifies a clarifying question into a semantic topic bucket so that
// ensureMinQuestions can deduplicate by topic rather than by string prefix.
// The "other:<snippet>" bucket is intentionally per-question so two distinct
// open-ended questions don't collapse into a single "other" slot.
export function questionTopic(q: string): string {
  const s = q.toLowerCase();
  if (/geograph|region|lac|latin america|caribbean|global|cross-?country|country/i.test(q)) return "geography";
  if (/year|time window|decade|recent|period|temporal/i.test(q)) return "time";
  if (/causal|identification|rct|experiment|observational|method|design|rigor/i.test(q)) return "design";
  if (/audience|policy|academic|practitioner/i.test(q)) return "audience";
  if (/mechanism|channel|pathway|why|how does/i.test(q)) return "mechanism";
  if (/debate|contradiction|disagree|controvers|tension/i.test(q)) return "debate";
  // Distinct "other" per question so two different open-ended questions don't merge.
  return `other:${s.slice(0, 32)}`;
}

// ── Deterministic backfill bank ────────────────────────────────────────────
// Guarantees a floor of 3 and a ceiling of 5 clarifying questions.
// When the LLM returns fewer than 3, we append questions derived from the
// evidence distribution that are provably useful for scoping the paper.
// When the LLM returns 0 (degraded path), this still gives the user something
// meaningful to engage with before generation.
//
// Dedup is by SEMANTIC TOPIC (via questionTopic), not by string prefix.
// Model questions seed the seen-topics set; bank questions that share a topic
// with any already-present question (model or earlier bank) are skipped.
// This prevents the LLM geography question + the bank "Which geography…"
// question from both appearing.
//
// Field mapping vs. EvidenceDistribution:
//   byDesign     → same field name
//   byDecade     → same field name
//   lac/nonLac   → replaces a hypothetical byGeography dict (we use counts)
//   bySmsBand    → replaces byRigor (nonEmpirical/low/mid/high/unscored)
export function ensureMinQuestions(
  modelQs: ClarifyingQuestion[],
  dist: EvidenceDistribution,
): ClarifyingQuestion[] {
  const out = [...modelQs];
  // Seed seen-topics from ALL model questions upfront.
  const seenTopics = new Set(out.map((q) => questionTopic(q.q)));

  const designs = Object.keys(dist.byDesign ?? {});
  const decades = Object.keys(dist.byDecade ?? {}).sort();
  const hasLacSplit = dist.lac > 0 && dist.nonLac > 0;
  const smsBand = dist.bySmsBand ?? { nonEmpirical: 0, low: 0, mid: 0, high: 0, unscored: 0 };
  const hasRigorMix = (smsBand.high > 0) && (smsBand.low + smsBand.mid > 0);

  const bank: ClarifyingQuestion[] = [
    hasLacSplit
      ? {
          q: `Which geography should the paper center on?`,
          options: ["LAC-focused", "global/cross-country", "both — compare LAC to global"],
          rationale: `Your evidence has a LAC/non-LAC split (${dist.lac} LAC, ${dist.nonLac} other) — focusing sharpens the narrative.`,
        }
      : null,
    decades.length > 1
      ? {
          q: `What time window should the survey emphasize?`,
          options: [`${decades[0]}–present`, `last decade only`, `all years`],
          rationale: `Evidence runs ${decades[0]}–${decades[decades.length - 1]}; recency framing changes the story.`,
        }
      : null,
    designs.length > 1
      ? {
          q: `Should the paper foreground causal identification or describe the broad landscape?`,
          options: ["causal-identification focus", "broad landscape"],
          rationale: `Design mix is ${designs.slice(0, 3).join("/")} — this sets how strict the evidence bar reads.`,
        }
      : null,
    {
      q: `Is this written for a policy audience or an academic one?`,
      options: ["policy", "academic"],
      rationale: `Shapes tone, framing of mechanisms, and which takeaways lead.`,
    },
    hasRigorMix
      ? {
          q: `Should the paper include lower-rigor descriptive studies alongside RCTs/quasi-experiments?`,
          options: ["high-rigor only (SMS 4-5)", "all rigor levels", "rigor-stratified sections"],
          rationale: `Evidence spans high-rigor (${smsBand.high}) and lower-rigor (${smsBand.low + smsBand.mid}) studies — the inclusion bar changes scope and message.`,
        }
      : {
          q: `Is there a specific debate or contradiction the paper should spotlight?`,
          options: [],
          rationale: `Naming the live debate makes the survey argue, not just catalog.`,
        },
  ].filter(Boolean) as ClarifyingQuestion[];

  for (const q of bank) {
    if (out.length >= 5) break;
    const topic = questionTopic(q.q);
    if (!seenTopics.has(topic)) {
      out.push(q);
      seenTopics.add(topic);
    }
    if (out.length >= 3 && modelQs.length >= 3) break;
  }
  return out.slice(0, 5);
}

async function callLlm(system: string, user: string, maxTokens: number): Promise<any | null> {
  // Gemini-primary for the INTERACTIVE framing layer (clarify, outline-preview):
  // the user waits on these, and Qwen's shared-GPU queue made them hang (10-30s+
  // or never). Gemini ~2s, cost is cents per session. Qwen is the fallback if
  // Gemini is down. Heavy section drafting keeps its own hybrid policy.
  try {
    return await callGemini(system, user, maxTokens);
  } catch (e1) {
    console.warn("[paperPlanEngine] Gemini failed, trying Qwen:", (e1 as Error).message);
    try {
      return await callQwen(system, user, maxTokens);
    } catch (e2) {
      console.warn("[paperPlanEngine] Qwen also failed:", (e2 as Error).message);
      return null;
    }
  }
}

export async function generateClarification(
  query: string,
  briefAbstract: string | null,
  briefBullets: string[],
  works: EvidenceWork[],
): Promise<ClarificationResult> {
  const dist = computeEvidenceDistribution(works);
  const { system, user } = buildClarifyPrompt(query, briefAbstract, briefBullets, dist);
  const raw = await callLlm(system, user, 4096);

  if (!raw) {
    // Degrade: "use my query as-is" — still show deterministic bank questions
    // so the user has something useful to engage with before generation.
    return {
      clarifyingQuestions: ensureMinQuestions([], dist),
      alwaysAsk: staples(),
      workingQuestion: query,
      draftOutline: null,
      degraded: true,
    };
  }

  const qs = Array.isArray(raw.clarifyingQuestions)
    ? raw.clarifyingQuestions
        .slice(0, 5)
        .filter((q: any) => q && typeof q.q === "string")
        .map((q: any) => ({
          q: String(q.q),
          options: Array.isArray(q.options) ? q.options.map(String) : [],
          rationale: String(q.rationale ?? ""),
        }))
    : [];

  return {
    clarifyingQuestions: ensureMinQuestions(qs, dist),
    alwaysAsk: staples(),
    workingQuestion: typeof raw.workingQuestion === "string" && raw.workingQuestion.trim()
      ? raw.workingQuestion.trim()
      : query,
    draftOutline: normalizeOutline(raw.draftOutline),
    degraded: false,
  };
}

export async function generateOutlinePreview(
  workingQuestion: string,
  scope: { include: string[]; exclude: string[] },
  emphasis: { themes?: string[]; spotlightDebate?: string; audience?: string; targetWords?: number },
  works: EvidenceWork[],
): Promise<OutlinePreviewResult> {
  const dist = computeEvidenceDistribution(works);
  const { system, user } = buildOutlinePreviewPrompt(workingQuestion, scope, emphasis, dist);
  const raw = await callLlm(system, user, 3072);
  if (!raw) return { outline: null, degraded: true };
  return { outline: normalizeOutline(raw), degraded: false };
}
