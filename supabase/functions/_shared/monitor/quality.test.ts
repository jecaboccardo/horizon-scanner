import { assertEquals } from "jsr:@std/assert";
import { checkProse, findDuplicates, checkAddedPapers, computeRelevance } from "./quality.ts";

Deno.test("checkProse flags bullets, headers, scratchpad, reference dumps", () => {
  const issues = checkProse("p1", [
    { title: "Intro", body: "This is clean prose about labor markets. It reads normally." },
    { title: "Mechanisms", body: "- bullet one\n- bullet two\n- bullet three" },
    { title: "Scratch", body: "Scratchpad: let me think about this first." },
    { title: "Refs", body: "Findings hold.\nReferences:\nSmith 2020. Jones 2019. Lee 2021." },
    { title: "Head", body: "## Heading leaked\nSome text." },
  ]);
  const byS = Object.fromEntries(issues.map((i) => [i.section, i.kinds]));
  assertEquals(byS["Intro"], undefined);
  assertEquals(byS["Mechanisms"].includes("bullets"), true);
  assertEquals(byS["Scratch"].includes("scratchpad"), true);
  assertEquals(byS["Refs"].includes("reference_dump"), true);
  assertEquals(byS["Head"].includes("markdown_header"), true);
});

Deno.test("findDuplicates catches title/year/first-author twins", () => {
  const dups = findDuplicates([
    { id: "oa:W1", title: "Minimum Wages and Employment", year: 1994, authors: ["Card, David", "Krueger, Alan"] },
    { id: "oa:W2", title: "Minimum wages and employment.", year: 1994, authors: ["Card, D."] },
    { id: "oa:W3", title: "Totally Different Paper", year: 2010, authors: ["Smith, J."] },
  ]);
  assertEquals(dups.length, 1);
  assertEquals([dups[0].a, dups[0].b].sort(), ["oa:W1", "oa:W2"]);
});

Deno.test("checkAddedPapers flags uploaded-but-missing-from-brief", () => {
  const res = checkAddedPapers(
    [{ ref: "10.1/x", label: "Paper X" }, { ref: "10.1/y", label: "Paper Y" }],
    new Set(["10.1/x", "10.1/y"]),
    new Set(["10.1/x"]),
  );
  assertEquals(res.find((r) => r.ref === "10.1/y")!.inBrief, false);
  assertEquals(res.find((r) => r.ref === "10.1/y")!.inTable, true);
});

Deno.test("computeRelevance derives off-ratio + below-floor", () => {
  const r = computeRelevance({
    runId: "s1", topCosine: 0.41, meanCosine: 0.3,
    segments: { W1: "core", W2: "off", W3: "off", W4: "context" },
    offTitles: { W2: "Irrelevant A", W3: "Irrelevant B" },
    floor: 0.45,
  });
  assertEquals(r.coreCount, 1);
  assertEquals(Math.round(r.offRatio! * 100), 50);
  assertEquals(r.belowFloor, true);
  assertEquals(r.offTitles.length, 2);
});
