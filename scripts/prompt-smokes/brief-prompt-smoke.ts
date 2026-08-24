// Offline smoke for the 2026-07-06 brief-prompt dedup: build the brief user
// prompt from 50 fixture rows and verify (1) each abstract appears exactly ONCE,
// (2) design + DIRECT/INDIRECT tags ride the single EVIDENCE line, (3) titles
// are not re-serialized by any prompt family. Guards against reintroducing the
// duplicated evidence blocks that doubled brief input tokens (~21k → ~9k).
//
// Run: deno run --allow-all --env-file=.env --config server-deno/deno.json scripts/prompt-smokes/brief-prompt-smoke.ts
import { buildUserPrompt } from "../../supabase/functions/_shared/geminiClient.ts";
import { promptFamilies } from "../../supabase/functions/_shared/prompts.ts";

const rows = Array.from({ length: 50 }, (_, i) => ({
  workId: `10.1234/paper.${i}`,
  title: `Effects of Intervention ${i} on Learning Outcomes`,
  sourceName: "Journal of Development Economics",
  year: 2015 + (i % 10),
  smsLevel: (i % 5) + 1,
  finding: `UNIQUE_ABSTRACT_${i} ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(8),
  authors: [`Author${i} A.`, `Coauthor${i} B.`],
  methodologyBadge: ["RCT", "DiD", "IV", "Observational", "RDD"][i % 5],
  causalStrength: "moderate",
  geography: ["Brazil"],
  evidenceMatch: (["direct-lac", "direct-global", "indirect"] as const)[i % 3],
}));

const coverage = { universeCount: 480000, retrievedCount: 400, admissibleCount: 120, evidenceCount: 50, signalCount: 0 };
const promptInputs = {
  queryPlanning: promptFamilies.queryPlanning({ query: "test query", filters: {} }),
  synthesis: promptFamilies.synthesis({
    query: "test query",
    evidenceRows: rows.map((r) => ({ workId: r.workId, finding: r.finding, evidenceMatch: r.evidenceMatch })),
    coverage,
    persona: "policy",
  }),
};
const prompt = buildUserPrompt("test query", rows as never, coverage, promptInputs);

// Each unique abstract marker must appear exactly once (no duplication).
let dupes = 0, missing = 0;
for (let i = 0; i < 50; i++) {
  const n = prompt.split(`UNIQUE_ABSTRACT_${i} `).length - 1;
  if (n === 0) missing++;
  if (n > 1) dupes++;
}
// Each title must appear exactly once (previously 3x via sourceScreening/methodologyTagging).
let titleDupes = 0;
for (let i = 0; i < 50; i++) {
  const n = prompt.split(`Effects of Intervention ${i} on Learning Outcomes`).length - 1;
  if (n > 1) titleDupes++;
}
const tagOk = prompt.includes("[DIRECT-LAC] Finding:") && prompt.includes("[INDIRECT] Finding:");
const designOk = prompt.includes(", SMS 1, RCT.");
console.log(JSON.stringify({
  promptChars: prompt.length,
  approxTokens: Math.round(prompt.length / 4),
  abstractsMissing: missing,
  abstractsDuplicated: dupes,
  titlesDuplicated: titleDupes,
  tagOnEvidenceLine: tagOk,
  designOnEvidenceLine: designOk,
}, null, 2));
if (missing || dupes || titleDupes || !tagOk || !designOk) {
  console.error("SMOKE FAILED");
  Deno.exit(1);
}
console.log("SMOKE OK");
