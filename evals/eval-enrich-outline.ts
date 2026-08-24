// evals/eval-enrich-outline.ts
//
// Enrich-mode eval for buildOutlinePrompt (Paper Studio confirmed-outline).
// Validates that when a user-confirmed outline is passed, the REAL outline-agent
// prompt + Gemini keep the sections verbatim (headings / order / count) and only
// enrich them (targetWords summing to ~target + expectedDesigns), with valid JSON.
// Also runs one free-mode control (no confirmed outline) to confirm the
// unchanged path still yields a valid 7-12 section outline.
//
// Run:
//   deno run --allow-net --allow-env --env-file=.env evals/eval-enrich-outline.ts
//
// Requires GEMINI_API_KEY in .env. ~6 cheap Gemini calls total.

import { buildOutlinePrompt, callGemini } from "../supabase/functions/_shared/jelPaperPipeline.ts";

const QUESTION = "What is the impact of teacher incentive programs on student learning?";
const TARGET = 15000;

const CONFIRMED = {
  title: "Teacher Incentive Programs and Student Learning: A Survey",
  sections: [
    { number: 1, heading: "Introduction and prior surveys", scope: "framing + how this survey positions against earlier reviews" },
    { number: 2, heading: "Experimental evidence on teacher pay", scope: "RCTs on performance pay and student outcomes" },
    { number: 3, heading: "Mechanisms: effort versus selection", scope: "why incentives work or fail — effort response vs sorting" },
    { number: 4, heading: "Research agenda and open questions", scope: "gaps and where the literature should go next" },
  ],
};

const EVIDENCE = [
  { title: "Teacher Performance Pay: Experimental Evidence from India", year: 2011, geography: ["India"], methodologyDesign: "RCT", abstract: "A two-year randomized trial of teacher performance pay across 300 schools; group and individual incentives raised test scores by 0.27 SD." },
  { title: "The Effect of Teacher Bonuses on Student Achievement", year: 2013, geography: ["United States"], methodologyDesign: "RCT", abstract: "A randomized controlled trial of teacher bonuses in a large urban district found null average effects on student achievement." },
  { title: "Incentive Pay and Teacher Sorting", year: 2018, geography: ["Mexico"], methodologyDesign: "DiD", abstract: "Difference-in-differences evidence that performance pay changed the composition of the teaching workforce via selective attrition." },
  { title: "Effort Responses to Teacher Incentives", year: 2016, geography: ["Kenya"], methodologyDesign: "RCT", abstract: "A field experiment isolating the effort channel; teachers increased attendance and lesson coverage under incentives." },
  { title: "Long-Run Effects of Pay-for-Performance in Schools", year: 2020, geography: ["Chile"], methodologyDesign: "observational", abstract: "Observational panel evidence on the persistence of incentive-pay effects on learning over a decade." },
  { title: "A Meta-Analysis of Teacher Incentive Experiments", year: 2021, geography: ["Global"], methodologyDesign: "review", abstract: "Meta-analysis of 37 experiments; average effect 0.05 SD, with strong heterogeneity by design and context." },
];

const FRAMING = { scope: { include: ["cost-effectiveness"], exclude: [] }, emphasis: { themes: ["mechanisms"], audience: "technical", targetWords: TARGET } };

function approx(sum: number, target: number, tol = 0.25) {
  return sum >= target * (1 - tol) && sum <= target * (1 + tol);
}

async function runEnrich(iter: number) {
  const { system, user } = buildOutlinePrompt(QUESTION, null, EVIDENCE as any, FRAMING as any, CONFIRMED as any, TARGET);
  const out = await callGemini(system, user, 8192);
  const secs = Array.isArray(out?.sections) ? out.sections : [];
  const headingsExpected = CONFIRMED.sections.map((s) => s.heading);
  const headingsGot = secs.map((s: any) => String(s?.heading ?? ""));
  const checks = {
    sameCount: secs.length === CONFIRMED.sections.length,
    headingsVerbatimInOrder: JSON.stringify(headingsGot) === JSON.stringify(headingsExpected),
    everyTargetWords: secs.length > 0 && secs.every((s: any) => Number.isFinite(Number(s?.targetWords)) && Number(s.targetWords) > 0),
    sumApprox: approx(secs.reduce((a: number, s: any) => a + (Number(s?.targetWords) || 0), 0), TARGET),
    everyExpectedDesigns: secs.length > 0 && secs.every((s: any) => Array.isArray(s?.expectedDesigns)),
    titleAndAbstract: typeof out?.title === "string" && typeof out?.abstract === "string" && out.abstract.length > 50,
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(`\n[enrich ${iter}] ${pass ? "PASS ✓" : "FAIL ✗"}`);
  for (const [k, v] of Object.entries(checks)) console.log(`   ${v ? "✓" : "✗"} ${k}`);
  if (!checks.headingsVerbatimInOrder) {
    console.log("   expected:", JSON.stringify(headingsExpected));
    console.log("   got     :", JSON.stringify(headingsGot));
  }
  const sum = secs.reduce((a: number, s: any) => a + (Number(s?.targetWords) || 0), 0);
  console.log(`   (sections=${secs.length}, targetWords sum=${sum})`);
  return pass;
}

async function runFreeControl() {
  const { system, user } = buildOutlinePrompt(QUESTION, null, EVIDENCE as any, FRAMING as any, null, TARGET);
  const out = await callGemini(system, user, 8192);
  const n = Array.isArray(out?.sections) ? out.sections.length : 0;
  const ok = n >= 5 && n <= 12 && typeof out?.title === "string";
  console.log(`\n[free control] ${ok ? "PASS ✓" : "FAIL ✗"} — free-built ${n} sections (expect 7-12, accept 5-12)`);
  return ok;
}

const N = 3;
let pass = 0;
for (let i = 1; i <= N; i++) {
  try { if (await runEnrich(i)) pass++; }
  catch (e) { console.log(`[enrich ${i}] ERROR`, (e as Error).message); }
}
let freeOk = false;
try { freeOk = await runFreeControl(); } catch (e) { console.log("[free control] ERROR", (e as Error).message); }

console.log(`\n──────────────────────────────────────────`);
console.log(`ENRICH MODE: ${pass}/${N} iterations passed`);
console.log(`FREE CONTROL (non-enrich unchanged): ${freeOk ? "PASS" : "FAIL"}`);
console.log(`OVERALL: ${pass === N && freeOk ? "✅ enrich mode validated" : pass >= Math.ceil(N / 2) && freeOk ? "⚠️  mostly works — review failures above" : "❌ enrich mode unreliable"}`);
