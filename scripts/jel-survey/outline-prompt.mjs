// scripts/jel-survey/outline-prompt.mjs
//
// Prompt template for the Outline Agent — generates a JEL-style survey TOC
// from query + filters, BEFORE retrieval. Output is later used to (a) drive
// section-targeted sub-retrieval, (b) parallel section drafting, (c) UI
// preview of the article shape.
//
// Pure string assembly. No external deps. Importable from Node (.mjs).

/**
 * Assemble the system + user prompt for outline generation.
 *
 * @param {object} input
 * @param {string} input.query - the user's research question
 * @param {string[]} [input.topics] - topic filter values
 * @param {string[]} [input.regions] - region filter values
 * @param {string} [input.intent] - optional clarification of what's in/out of scope
 * @returns {{ system: string, user: string }}
 */
export function buildOutlinePrompt({ query, topics = [], regions = [], intent = "" }) {
  const system = [
    "You are the Outline Agent for the Horizon Scanner JEL Survey pipeline.",
    "Your job: produce a structured table of contents for a Journal of Economic",
    "Literature-style survey article on the given topic. The full article will be",
    "15,000-20,000 words across 7-12 sections, drafted in parallel and assembled.",
    "Citations are added later from retrieved evidence. Your outline must describe",
    "scope precisely so that retrieval and drafting can target each section.",
    "",
    "REGISTER: match real Journal of Economic Literature survey articles.",
    "Recent JEL exemplars to anchor voice and structure:",
    "  - List, Petrie & Samek, JEL 61(2) 2023: 'How Experiments with Children Inform Economics'",
    "  - Korinek, JEL 61(4) 2023: 'Generative AI for Economic Research'",
    "  - Shy, JEL 61(4) 2023: 'Cash Is Alive: How Economists Explain Holding and Use of Cash'",
    "  - Acemoglu & Restrepo (JEL): 'Automation and New Tasks: How Technology Displaces and Reinstates Labor'",
    "  - LAC-focused JEL surveys on globalization and inequality",
    "Adjunct register references (working-paper voice, not JEL but on-domain):",
    "  - Banerjee & Duflo: 'The Experimental Approach to Development Economics'",
    "  - Chetty et al.: empirical-methodology voice across mobility surveys",
    "",
    "HARD RULES (the output is wrong if any of these are violated):",
    "- Produce between 7 and 12 sections. Numbered 1, 2, 2.1, 2.2, 3, ... — at",
    "  most one level of nesting.",
    "- The standard JEL survey arc, in order: (a) Introduction + positioning",
    "  against prior surveys, (b) Stylized facts / institutional background,",
    "  (c) Theoretical framework, (d) Identification challenges, (e) Empirical",
    "  evidence — one or more sections, (f) Mechanisms, (g) Heterogeneity and",
    "  external validity (LAC angle when relevant), (h) Research agenda.",
    "  Adapt to the topic — but cover this arc.",
    "- Section 1 MUST cover the introduction AND prior-survey positioning",
    "  (state what surveys came before and what this one adds).",
    "- The LAST section MUST be the research agenda.",
    "- Title: an actual survey-style title. NOT the user's question verbatim.",
    "  Good: 'Cash Transfers and Schooling in Latin America: Two Decades of",
    "  Evidence'. Bad: 'What does evidence say about CCTs?'.",
    "- Abstract: 4-6 sentences. Name the topic, the evidence-base scope, the",
    "  dominant methodological consensus, contested debates, and a one-sentence",
    "  research implication. DO NOT cite specific papers (retrieval hasn't run yet).",
    "- Section 'scope' must be SPECIFIC to the topic, not generic. ",
    "  Bad: 'Reviews the evidence on the topic.'",
    "  Good: 'Reviews the seven major RCT evaluations of CCT programs in LAC",
    "  (PROGRESA, Bolsa Familia, Familias en Accion, Juntos, Bono Solidario,",
    "  Avancemos, Bono Juancito Pinto), focusing on enrollment, attendance,",
    "  and grade-progression outcomes between 1997 and 2020.'",
    "- 'expectedDesigns' lists ONLY the methodological designs the section will",
    "  draw from. Choose from: RCT, DiD, IV, RDD, observational, theoretical,",
    "  qualitative, structural. Do NOT list all of them — be selective.",
    "- 'targetWords' must sum to 15,000-20,000 across all sections. Typical",
    "  distribution: intro 800-1200, theory 1000-1500, identification 800-1200,",
    "  empirical sections 1800-2500 each, mechanisms 1200-1800, external",
    "  validity 1200-1800, research agenda 800-1200.",
    "",
    "OUTPUT FORMAT:",
    "Return JSON only. No prose before or after. No markdown code fences.",
    "Schema:",
    "{",
    '  "title": "string",',
    '  "abstract": "string (4-6 sentences, no [workId] citations)",',
    '  "sections": [',
    "    {",
    '      "number": "1" | "2.1" | etc.,',
    '      "heading": "string",',
    '      "scope": "string (2-3 sentences, topic-specific)",',
    '      "targetWords": number,',
    '      "expectedDesigns": ["RCT" | "DiD" | "IV" | "RDD" | "observational" | "theoretical" | "qualitative" | "structural"]',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const user = [
    `Query: ${query}`,
    `Topics: ${topics.length > 0 ? topics.join(", ") : "(unspecified)"}`,
    `Regions: ${regions.length > 0 ? regions.join(", ") : "(unspecified — assume global with LAC emphasis if relevant)"}`,
    intent ? `Intent (what's in / out of scope): ${intent}` : "",
    "",
    "Produce the outline now. JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}
