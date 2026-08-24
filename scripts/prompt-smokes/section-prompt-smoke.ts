// Offline smoke for the 2026-07-06 JEL section-prompt cache split:
//  (1) system + user.prefix are BYTE-IDENTICAL across two different sections —
//      the invariant Gemini implicit caching and Claude cache_control depend on;
//      per-section content leaking into the prefix silently kills the discount
//  (2) per-section content (heading, minimums, design rule, priors) is in the suffix
//  (3) evidence-tail compression: ≤ SECTION_EVIDENCE_FULL_CAP full-detail entries
//
// Run: deno run --allow-all --env-file=.env --config server-deno/deno.json scripts/prompt-smokes/section-prompt-smoke.ts
import { buildSectionPrompt } from "../../supabase/functions/_shared/jelPaperPipeline.ts";
import { joinUserPrompt } from "../../supabase/functions/_shared/synthesisProvider.ts";

const papers = Array.from({ length: 60 }, (_, i) => ({
  workId: `10.1234/p.${i}`,
  title: `Paper ${i} on student learning`,
  authors: [`Auth${i} A.`, `Auth${i} B.`, `Auth${i} C.`, `Auth${i} D.`],
  year: 2010 + (i % 15),
  smsLevel: (i % 5) + 1,
  methodologyDesign: ["RCT", "DiD", "observational"][i % 3],
  geography: ["Brazil", "Mexico"],
  abstract: `ABSTRACT_${i} ` + "long abstract text ".repeat(30),
  citationCount: i * 3,
  hasCard: false,
  card: null,
}));

const outline = { title: "Survey of Student Learning Interventions" };
const s1 = { number: "2", heading: "Empirical Evidence", scope: "Causal studies", targetWords: 900, expectedDesigns: ["RCT", "DiD"] };
const s2 = { number: "4", heading: "Mechanisms", scope: "Why effects arise", targetWords: 700, expectedDesigns: ["observational"] };

const p1 = buildSectionPrompt(outline, s1, papers, "voice anchor text here", "Exemplar", []);
const p2 = buildSectionPrompt(outline, s2, papers, "voice anchor text here", "Exemplar", [
  { number: "2", heading: "Empirical Evidence", wordCount: 900, bodyPreview: "prior body words" },
]);

const checks = {
  systemIdentical: p1.system === p2.system,
  prefixIdentical: p1.user.prefix === p2.user.prefix,
  suffixDiffers: p1.user.suffix !== p2.user.suffix,
  suffixHasBrief: p1.user.suffix.includes("SECTION: §2 — Empirical Evidence") && p1.user.suffix.includes("SECTION CITATION REQUIREMENTS"),
  designRuleInSuffix: p1.user.suffix.includes("DESIGN CHANNEL RULE"),
  noSectionInPrefix: !p1.user.prefix.includes("SECTION: §"),
  priorOnlyInP2: !joinUserPrompt(p1.user).includes("PRIOR SECTIONS") && joinUserPrompt(p2.user).includes("PRIOR SECTIONS"),
  // Tail compression: with FULL cap 30 (default) and no _core flags, at most 30
  // entries keep their abstract; the tail renders one-line.
  tailCompressed: (() => {
    const full = (p1.user.prefix.match(/abstract: ABSTRACT_/g) ?? []).length;
    return full > 0 && full <= 30;
  })(),
  joinWorks: joinUserPrompt(p1.user) === p1.user.prefix + p1.user.suffix,
  prefixChars: p1.user.prefix.length,
  suffixChars: p1.user.suffix.length,
};
console.log(JSON.stringify(checks, null, 2));
const failed = Object.entries(checks).filter(([k, v]) => typeof v === "boolean" && !v);
if (failed.length) { console.error("SMOKE FAILED:", failed.map(([k]) => k).join(", ")); Deno.exit(1); }
console.log("SMOKE OK");
