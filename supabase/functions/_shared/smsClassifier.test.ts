import { assertEquals } from "jsr:@std/assert";
import { classifyPaper } from "./smsClassifier.ts";

Deno.test("keyword scan never asserts SMS > 3 (RCT phrase caps at 3)", () => {
  const r = classifyPaper({
    title: "Effects of a program",
    abstract: "We run a randomized controlled trial with treatment and control groups.",
  });
  assertEquals(r.smsLevel, 3);
  assertEquals(r.design, "RCT"); // design hint kept
  assertEquals(r.confidence, "low");
});

Deno.test("DiD phrase caps at 3 with an abstract", () => {
  const r = classifyPaper({
    title: "Policy shock",
    abstract: "Using a difference-in-differences design across states, we estimate...",
  });
  assertEquals(r.smsLevel, 3);
  assertEquals(r.design, "DiD");
});

Deno.test("no abstract → title-only high-tier match caps at SMS 2", () => {
  const r = classifyPaper({
    title: "A natural experiment on earthquakes and regression discontinuity",
    abstract: null,
  });
  assertEquals(r.smsLevel, 2);
  assertEquals(r.confidence, "low");
});

Deno.test("no abstract → moderate keyword also capped at 2", () => {
  const r = classifyPaper({
    title: "Panel data evidence on fixed effects estimation",
    abstract: "",
  });
  assertEquals(r.smsLevel, 2);
});

Deno.test("low-tier keyword with abstract is unchanged (SMS 1, no cap)", () => {
  const r = classifyPaper({
    title: "A qualitative study",
    abstract: "This qualitative case study describes interviews with officials.",
  });
  assertEquals(r.smsLevel, 1);
  assertEquals(r.design, "Qualitative");
});

Deno.test("SMS 2 correlational with abstract is not damped", () => {
  const r = classifyPaper({
    title: "Determinants of spending",
    abstract: "We document a correlation using OLS cross-sectional regression.",
  });
  assertEquals(r.smsLevel, 2);
});

Deno.test("no keywords → unclassified null", () => {
  const r = classifyPaper({ title: "An essay", abstract: "Some thoughts on policy." });
  assertEquals(r.smsLevel, null);
});
