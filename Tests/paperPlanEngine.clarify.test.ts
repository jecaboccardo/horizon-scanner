import { assert, assertEquals } from "jsr:@std/assert";
import { ensureMinQuestions, questionTopic } from "../supabase/functions/_shared/paperPlanEngine.ts";

// Minimal EvidenceDistribution stubs — only the fields ensureMinQuestions reads.
// Real shape: byDesign, bySmsBand, lac, nonLac, byDecade, total, foundational,
// recent, medianCitations.

Deno.test("ensureMinQuestions backfills to >=3 from the distribution bank", () => {
  const dist = {
    total: 100,
    byDesign: { RCT: 20, observational: 30, DiD: 15 },
    bySmsBand: { nonEmpirical: 5, low: 20, mid: 30, high: 25, unscored: 20 },
    lac: 40,
    nonLac: 60,
    byDecade: { "2010s": 30, "2000s": 20, "1990s": 10 },
    foundational: 15,
    recent: 25,
    medianCitations: 12,
  } as any;
  const out = ensureMinQuestions([], dist);
  assert(out.length >= 3 && out.length <= 5, `expected 3..5, got ${out.length}`);
  for (const q of out) {
    assert(q.q.length > 0);
    assert(Array.isArray(q.options));
  }
});

Deno.test("ensureMinQuestions keeps model questions and tops up to 3", () => {
  const dist = {
    total: 50,
    byDesign: { RCT: 50 },
    bySmsBand: { nonEmpirical: 0, low: 0, mid: 0, high: 50, unscored: 0 },
    lac: 40,
    nonLac: 10,
    byDecade: { "2010s": 50 },
    foundational: 10,
    recent: 20,
    medianCitations: 30,
  } as any;
  const model = [{ q: "Focus on credit constraints?", options: ["yes", "no"], rationale: "r" }];
  const out = ensureMinQuestions(model, dist);
  assertEquals(out[0].q, "Focus on credit constraints?");
  assert(out.length >= 3);
});

Deno.test("ensureMinQuestions does not add a second geography-topic question when model already asked one", () => {
  // Evidence has a LAC split so the bank WOULD normally add "Which geography should the paper center on?"
  const dist = {
    total: 80,
    byDesign: { RCT: 20, observational: 30, DiD: 30 },
    bySmsBand: { nonEmpirical: 0, low: 10, mid: 30, high: 30, unscored: 10 },
    lac: 45,
    nonLac: 35,
    byDecade: { "2010s": 40, "2000s": 40 },
    foundational: 20,
    recent: 15,
    medianCitations: 18,
  } as any;

  // A model question that is clearly about geography — different wording from the bank entry.
  const geographyModelQ = {
    q: "Should the paper focus on LAC or stay global?",
    options: ["LAC only", "global", "both"],
    rationale: "80% of evidence is LAC-tagged but the query is framed globally.",
  };
  const out = ensureMinQuestions([geographyModelQ], dist);

  // The output must contain NO duplicate geography-topic question.
  const geoQs = out.filter((q) => questionTopic(q.q) === "geography");
  assertEquals(geoQs.length, 1, `Expected exactly 1 geography question, got ${geoQs.length}: ${geoQs.map(q => q.q).join(" | ")}`);

  // The model question must be preserved as-is (it arrives first).
  assertEquals(out[0].q, "Should the paper focus on LAC or stay global?");

  // Overall count must still satisfy the floor/cap.
  assert(out.length >= 1 && out.length <= 5, `count ${out.length} out of range`);
});

Deno.test("questionTopic classifies questions into expected buckets", () => {
  assertEquals(questionTopic("Should the paper focus on LAC or stay global?"), "geography");
  assertEquals(questionTopic("Which geography should the paper center on?"), "geography");
  assertEquals(questionTopic("What time window should the survey emphasize?"), "time");
  assertEquals(questionTopic("Should the paper foreground causal identification or describe the broad landscape?"), "design");
  assertEquals(questionTopic("Is this written for a policy audience or an academic one?"), "audience");
  assertEquals(questionTopic("Is there a specific debate or contradiction the paper should spotlight?"), "debate");
  // Distinct open-ended questions should NOT collapse to the same key.
  const topicA = questionTopic("What are the main findings about welfare effects?");
  const topicB = questionTopic("How does the paper handle measurement error?");
  assert(topicA !== topicB, "Two distinct 'other' questions should have distinct topic keys");
});
