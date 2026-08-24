import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateIssues,
  selectCandidatePool,
  assignCorpusGaps,
  buildTriageBatchPrompt,
  parseTriage,
  parseTriageBatch,
  buildRewritePrompt,
  buildCorrectorReport,
  buildDryRunMarkdown,
  endsCleanly,
} from "./corrector.ts";

Deno.test("aggregateIssues groups findings by section number", () => {
  const findings = {
    auditReport: { claims: [
      { workId: "w1", section: "§3", sentence: "X causes Y.", verdict: "unsupported", reason: "no support" },
      { workId: "w2", section: "§3", sentence: "Z holds.", verdict: "supported", reason: "" },
    ]},
    reviewReport: {
      unsupportedClaims: [{ section: "§4", claim: "A beats B.", reason: "overstated" }],
      offTopicThemes: [{ theme: "crypto", section: "§5", reason: "not in corpus" }],
      corpusGaps: [{ workId: "w9", reason: "should cite" }],
    },
    krisReport: { mismatches: [{ id: "w7", localTitle: "L", oaTitle: "O" }] },
    coherenceReport: { issues: [
      { type: "repetition", sections: ["§3", "§6"], description: "repeat", suggestion: "trim §6" },
    ]},
    daRevisions: [{ section: "§4", instruction: "engage the selection-bias critique" }],
  };
  const cited = new Map([["w7", { section: "§2" }]]);
  const map = aggregateIssues(findings, cited);

  assertEquals(map.get("3")!.some((i) => i.type === "unsupported" && i.workId === "w1"), true);
  assertEquals(map.get("3")!.some((i) => i.workId === "w2"), false);
  assertEquals(map.get("4")!.some((i) => i.type === "unsupported"), true);
  assertEquals(map.get("4")!.some((i) => i.type === "daRevision"), true);
  assertEquals(map.get("5")!.some((i) => i.type === "offTopic"), true);
  assertEquals(map.get("2")!.some((i) => i.type === "krisMismatch" && i.workId === "w7"), true);
  assertEquals(map.get("3")!.some((i) => i.type === "coherence"), true);
  assertEquals(map.get("6")!.some((i) => i.type === "coherence"), true);
  assertEquals([...map.values()].flat().some((i) => i.type === "corpusGap"), false);
});

Deno.test("selectCandidatePool returns cited + top keyword-overlap uncited", () => {
  const section = { number: "3", heading: "Teacher quality and learning", scope: "effect of teacher quality on test scores" };
  const cited = ["w1"];
  const papers = [
    { workId: "w1", title: "Teacher value-added", abstract: "teacher quality raises test scores" },
    { workId: "w2", title: "Class size and learning", abstract: "smaller classes improve scores" },
    { workId: "w3", title: "Crypto markets", abstract: "bitcoin volatility" },
  ];
  const pool = selectCandidatePool(section, cited, papers, 2);
  assertEquals(pool.includes("w1"), true);
  assertEquals(pool.includes("w2"), true);
  assertEquals(pool.includes("w3"), false);
});

Deno.test("assignCorpusGaps maps a gap to the best-fit section or null", () => {
  const sections = [
    { number: "3", heading: "Teacher quality", scope: "teachers" },
    { number: "5", heading: "Class size", scope: "class size effects" },
  ];
  const gaps = [
    { workId: "w2", title: "Class size and learning", abstract: "smaller classes improve scores", reason: "" },
    { workId: "w9", title: "Crypto markets", abstract: "bitcoin", reason: "" },
  ];
  const assigned = assignCorpusGaps(gaps, sections, 0.15);
  assertEquals(assigned.find((a) => a.workId === "w2")!.section, "5");
  assertEquals(assigned.find((a) => a.workId === "w9")!.section, null);
});

Deno.test("buildTriageBatchPrompt numbers claims + shares candidate evidence + action menu", () => {
  const { system, user } = buildTriageBatchPrompt(
    [{ type: "unsupported", sentence: "Teacher quality doubles test scores.", detail: "overstated" },
     { type: "krisMismatch", detail: 'local "L" vs OpenAlex "O"' }],
    [{ workId: "w1", title: "Teacher VA", abstract: "teacher quality modestly raises scores" },
     { workId: "w2", title: "Class size", abstract: "smaller classes help" }],
  );
  assertEquals(system.includes("keep"), true);
  assertEquals(system.includes("re-attribute"), true);
  assertEquals(system.includes("NUMBERED LIST"), true);
  assertEquals(user.includes('1. FLAGGED CLAIM: "Teacher quality doubles test scores."'), true);
  assertEquals(user.includes("2. FLAGGED CLAIM:"), true);
  assertEquals(user.includes("[w1]"), true);
});

Deno.test("parseTriage normalizes action + targetWorkId", () => {
  assertEquals(parseTriage({ action: "soften", rationale: "weaker" }).action, "soften");
  assertEquals(parseTriage({ action: "re-attribute", targetWorkId: "w2" }).targetWorkId, "w2");
  assertEquals(parseTriage(null).action, "keep");
  assertEquals(parseTriage({ action: "nonsense" }).action, "keep");
});

Deno.test("parseTriageBatch remaps by 1-based index and defaults missing/bad entries to keep", () => {
  const out = parseTriageBatch({ triages: [
    { index: 2, action: "remove", rationale: "no support" },
    { index: 1, action: "re-attribute", targetWorkId: "w2", rationale: "wrong paper" },
    { index: 99, action: "remove" },          // out of range — ignored
    { index: "x", action: "remove" },         // bad index — ignored
  ] }, 3);
  assertEquals(out.length, 3);
  assertEquals(out[0].action, "re-attribute");
  assertEquals(out[0].targetWorkId, "w2");
  assertEquals(out[1].action, "remove");
  assertEquals(out[2].action, "keep");        // no entry → keep
  // total failure (null response) → all keep
  assertEquals(parseTriageBatch(null, 2).map((t) => t.action), ["keep", "keep"]);
  // bare-array response (no "triages" wrapper) still parses
  assertEquals(parseTriageBatch([{ index: 1, action: "soften" }], 1)[0].action, "soften");
});

Deno.test("buildRewritePrompt carries actions, related-section context, and HARD RULES", () => {
  const { system, user } = buildRewritePrompt(
    { number: "3", heading: "Teacher quality", body: "Teacher quality doubles scores [w1]." },
    [{ issue: { type: "unsupported", sentence: "Teacher quality doubles scores.", detail: "overstated" },
       triage: { action: "soften", rationale: "w1 supports modest effect" } }],
    [{ workId: "w1", title: "Teacher VA", abstract: "modest gains" }],
    "Class size also matters [w2].",
  );
  assertEquals(system.includes("PLAIN PROSE"), true);
  assertEquals(system.includes("Minimal change"), true);
  assertEquals(user.includes("soften"), true);
  assertEquals(user.includes("Class size also matters"), true);
});

Deno.test("buildCorrectorReport tallies by type and lists remaining", () => {
  const perSection = [
    { number: "3", before: "old [w1].", after: "new softened [w1].", actions: [
        { issue: { type: "unsupported", detail: "x" }, triage: { action: "soften" }, resolved: true },
        { issue: { type: "krisMismatch", detail: "y" }, triage: { action: "remove" }, resolved: false },
      ] },
    { number: "9", before: "same body", after: "same body", actions: [
        { issue: { type: "coherence", detail: "z" }, triage: { action: "fix" }, resolved: true },
      ] },
  ];
  const r = buildCorrectorReport(perSection as any);
  // §9 body unchanged (before === after) — must be excluded from sectionsRewritten
  assertEquals(r.sectionsRewritten, ["3"]);
  assertEquals(r.byType.unsupported.found, 1);
  assertEquals(r.byType.unsupported.resolved, 1);
  assertEquals(r.byType.krisMismatch.remaining, 1);
  assertEquals(r.remainingIssues.length, 1);
});

Deno.test("buildDryRunMarkdown shows before/after diff + triage per section", () => {
  const md = buildDryRunMarkdown("paperX", [
    { number: "3", heading: "T", before: "old [w1].", after: "old softened [w1].",
      actions: [{ issue: { type: "unsupported", detail: "overstated" }, triage: { action: "soften", rationale: "weaker" }, resolved: true }],
      citationsAdded: [], citationsDropped: [] },
  ] as any, { sectionsRewritten: ["3"] } as any);
  assertEquals(md.includes("§3"), true);
  assertEquals(md.includes("soften"), true);
  assertEquals(md.includes("old softened"), true);
});

Deno.test("endsCleanly flags cut-off bodies", () => {
  assertEquals(endsCleanly("A complete sentence."), true);
  assertEquals(endsCleanly("Ends with a citation (Smith 2020) [10.1/x]"), true); // ends with ]
  assertEquals(endsCleanly("Further insights come from"), false); // truncated
  assertEquals(endsCleanly("  trailing space.  "), true);
});

Deno.test("buildRewritePrompt includes [workId]-retention rule in both branches", () => {
  const rule = "NEVER reduce a cited claim to plain author-year text by dropping its [workId]";
  const truncated = buildRewritePrompt(
    { number: "6", heading: "Regional Focus", body: "LAC evidence shows" },
    [{ issue: { type: "truncated", detail: "cut off" } }],
    [{ workId: "w1", title: "T", abstract: "a" }],
  );
  assertEquals(truncated.system.includes(rule), true);
  const normal = buildRewritePrompt(
    { number: "3", heading: "X", body: "y [w1]." },
    [{ issue: { type: "unsupported", sentence: "s", detail: "d" }, triage: { action: "soften", rationale: "r" } }],
    [{ workId: "w1", title: "T", abstract: "a" }],
  );
  assertEquals(normal.system.includes(rule), true);
});

Deno.test("buildRewritePrompt switches to completion mode for a truncated issue", () => {
  const truncated = buildRewritePrompt(
    { number: "6", heading: "Regional Focus", body: "LAC evidence shows" },
    [{ issue: { type: "truncated", detail: "cut off" } }],
    [{ workId: "w1", title: "T", abstract: "a" }],
  );
  assertEquals(truncated.system.includes("CUT OFF") || truncated.system.includes("COMPLETING"), true);
  // non-truncation case keeps minimal-change wording
  const normal = buildRewritePrompt(
    { number: "3", heading: "X", body: "y" },
    [{ issue: { type: "unsupported", sentence: "s", detail: "d" }, triage: { action: "soften", rationale: "r" } }],
    [{ workId: "w1", title: "T", abstract: "a" }],
  );
  assertEquals(normal.system.includes("Minimal change"), true);
});
