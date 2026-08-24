// scripts/jel-survey/section-prompt.mjs
//
// Prompt template for JEL Skill #4 — Section Drafter.
// Assembles system + user prompts that take ONE outline section and produce
// drafted JEL-register prose with [workId] inline citations.
//
// Pure string assembly. No deps. Importable from Node (.mjs).

/**
 * Build the system+user prompt for a single section draft.
 *
 * @param {object} input
 * @param {object} input.outline       Outline JSON (title, abstract, sections[])
 * @param {object} input.section       The specific section to draft (one of outline.sections)
 * @param {object[]} input.evidence    Papers from the coding sheet, filtered + sorted for this section
 * @param {string} input.exemplarText  Voice-anchor excerpt (1000-2000 words from one JEL exemplar)
 * @param {string} input.exemplarTitle Display label for the anchor (e.g. "List et al. JEL 61(2) 2023")
 * @param {object[]} [input.priorSections] Already-drafted sections with {number, heading, summary}
 * @param {object[]} [input.context]   Institutional / descriptive sources (Wikipedia etc.) the drafter may cite for background facts (names, dates, design). Cited as [wiki:Title], NOT as [workId]. Empirical findings must still cite [workId] from evidence.
 * @returns {{ system: string, user: string }}
 */
export function buildSectionPrompt({
  outline,
  section,
  evidence,
  exemplarText,
  exemplarTitle,
  priorSections = [],
  context = [],
}) {
  const designs = Array.isArray(section.expectedDesigns)
    ? section.expectedDesigns.join(", ")
    : "(unspecified)";

  const system = [
    "You are the Section Drafter Agent for the Horizon Scanner JEL Survey pipeline.",
    "You write ONE section at a time of a multi-section JEL-style survey article.",
    "The full article is 15,000-20,000 words; this section is ~" + section.targetWords + " words.",
    "",
    "REGISTER: Match the voice of real Journal of Economic Literature surveys.",
    "The VOICE ANCHOR in the user block is a representative excerpt — match its",
    "tone, sentence rhythm, paragraph length, and citation density.",
    "",
    "CITATION RULES (CRITICAL — violations make the draft worthless):",
    "- For empirical claims (effect sizes, study designs, sample sizes, findings):",
    "  cite ONLY [workId] tokens from the EVIDENCE block.",
    "- For descriptive / institutional facts (program names, launch dates,",
    "  conditionality design, scale, sponsoring agency): you MAY cite the CONTEXT",
    "  block with [wiki:Title] form. NEVER pin a descriptive fact about a program",
    "  to a [workId] in EVIDENCE — those papers evaluate programs, they do not",
    "  document program histories. Either cite [wiki:Title] from CONTEXT, or write",
    "  the descriptive sentence without a bracketed citation.",
    "- Every empirical claim MUST carry at least one [workId] citation from EVIDENCE.",
    "- The exact [workId] string from the EVIDENCE block is the ONLY valid empirical",
    "  citation. Do NOT use [Author Year], [ss:DIGITS], [doi:...], raw DOIs in",
    "  brackets, or any other variation.",
    "- If a workId looks like '10.3386/w23285' or '10.2139/ssrn.5169611', cite it",
    "  exactly as '[10.3386/w23285]' — never as '[ss:23285]'.",
    "- Do NOT invent papers, findings, sample sizes, authors, or workIds.",
    "- If you would cite a paper that isn't in EVIDENCE, drop the claim or rephrase",
    "  as general background prose without a bracketed citation.",
    "",
    "CONTENT RULES:",
    "- Heading: " + section.heading,
    "- Target length: " + section.targetWords + " words (±20% acceptable).",
    "- Expected designs for this section: " + designs + ".",
    "  Lead with the strongest designs available in EVIDENCE. If a design is absent,",
    "  acknowledge the gap honestly rather than inflating other studies.",
    "- For empirical sections, organize by claim/finding, not by author biography.",
    "- For theoretical sections, ground concepts in cited empirical illustrations.",
    "- The 'scope' field of THIS SECTION (in the user block) is the binding spec.",
    "  Stay inside it; do not drift into adjacent sections' territory.",
    "",
    "STRUCTURE:",
    "- Open with a topic-anchored paragraph that frames what the section will cover.",
    "- Body in 3-7 paragraphs, each making one claim or covering one sub-theme.",
    "- Close with one transitional sentence pointing to the next section's territory",
    "  (UNLESS this is the last section — then close with a forward-looking line).",
    "- DO NOT include the section heading or number in the body — those are added",
    "  during assembly.",
    "",
    "OUTPUT FORMAT:",
    "Return JSON only. No prose before or after. No markdown code fences.",
    "Schema:",
    "{",
    '  "sectionNumber": "string (e.g. \\"1\\", \\"2.1\\")",',
    '  "heading": "string (the section heading verbatim)",',
    '  "body": "string (the drafted prose; can contain markdown emphasis but no headings)",',
    '  "wordCount": number (your count of words in body),',
    '  "citedWorkIds": ["array of unique [workId] tokens you cited (without brackets)"],',
    '  "uncoveredAreas": ["array of sub-topics from the scope you could not cover due to evidence gaps"]',
    "}",
  ].join("\n");

  // ---- USER BLOCK ----

  const outlineLines = [
    "ARTICLE OUTLINE (for context — your section must fit this arc):",
    `Title: ${outline.title}`,
    `Abstract: ${outline.abstract}`,
    "",
    "Sections:",
    ...outline.sections.map((s) =>
      `  ${s.number}. ${s.heading}  [${s.targetWords}w, ${(s.expectedDesigns ?? []).join("/")}]`,
    ),
  ];

  const priorBlock = priorSections.length > 0
    ? [
        "",
        "PRIOR-SECTION SUMMARIES (already drafted — do not repeat):",
        ...priorSections.map((p) =>
          `  ${p.number}. ${p.heading}\n     ${(p.summary ?? "").slice(0, 400)}${(p.summary ?? "").length > 400 ? "..." : ""}`,
        ),
      ]
    : [];

  const thisSection = [
    "",
    "THIS SECTION (the one you are drafting):",
    `  Number: ${section.number}`,
    `  Heading: ${section.heading}`,
    `  Scope: ${section.scope}`,
    `  Target words: ${section.targetWords}`,
    `  Expected designs: ${designs}`,
  ];

  const contextBlock = context.length > 0
    ? [
        "",
        `CONTEXT BLOCK (${context.length} institutional / descriptive sources — cite as [wiki:Title]):`,
        "",
        ...context.map((c) => formatContextEntry(c)),
      ]
    : [];

  const evidenceBlock = [
    "",
    `EVIDENCE BLOCK (${evidence.length} papers — cite ONLY these workIds for empirical claims):`,
    "",
    ...evidence.map((p) => formatEvidenceEntry(p)),
  ];

  const voiceAnchor = [
    "",
    `VOICE ANCHOR (excerpt from ${exemplarTitle} — match this tone and citation density):`,
    "",
    exemplarText,
  ];

  const user = [
    ...outlineLines,
    ...priorBlock,
    ...thisSection,
    ...contextBlock,
    ...evidenceBlock,
    ...voiceAnchor,
    "",
    "Draft section " + section.number + " now. Return JSON only.",
  ].join("\n");

  return { system, user };
}

function formatContextEntry(c) {
  const slug = String(c.title || c.slug || "").replace(/\s+/g, "_");
  const desc = c.description ? ` — ${c.description}` : "";
  const extract = c.extract ? `\n  ${c.extract.replace(/\s+/g, " ").trim()}` : "";
  return `[wiki:${slug}] ${c.title}${desc}${extract}`;
}

function formatEvidenceEntry(p) {
  const c = p.card;
  const authors = p.authors && p.authors.length > 0
    ? `${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}`
    : "Unknown authors";
  const year = p.year ?? "n.d.";
  const venue = p.venue ?? "(no venue)";
  const lines = [
    `[${p.workId}] "${p.title}" — ${authors}, ${year}. ${venue}.`,
  ];
  const design = c?.design ?? p.methodologyDesign;
  if (design) lines.push(`  Design: ${design}.`);
  if (p.smsLevel != null) lines.push(`  SMS level: ${p.smsLevel} (1=descriptive, 5=RCT).`);
  if (c) {
    if (c.intervention) lines.push(`  Intervention: ${c.intervention}.`);
    if (c.outcome) lines.push(`  Outcome: ${c.outcome}.`);
    if (c.effectDirection) lines.push(`  Effect: ${c.effectDirection}${c.effectSizeText ? ` (${c.effectSizeText})` : ""}.`);
    if (c.sampleSize) lines.push(`  Sample: ${c.sampleSize}.`);
    if (c.identificationStrategy) lines.push(`  Identification: ${c.identificationStrategy}.`);
    if (c.country && c.country.length > 0) {
      lines.push(`  Country: ${Array.isArray(c.country) ? c.country.join(", ") : c.country}.`);
    } else if (p.geography && p.geography.length > 0) {
      lines.push(`  Geography: ${Array.isArray(p.geography) ? p.geography.join(", ") : p.geography}.`);
    }
    if (c.mechanism) lines.push(`  Mechanism: ${c.mechanism}.`);
    if (c.limitations && c.limitations.length > 0) {
      lines.push(`  Limitations: ${Array.isArray(c.limitations) ? c.limitations.join("; ") : c.limitations}.`);
    }
    if (c.findingShort) lines.push(`  Finding: ${c.findingShort}.`);
  } else {
    lines.push(`  (No structured extraction available — rely on title, design, and venue only.)`);
  }
  return lines.join("\n");
}
