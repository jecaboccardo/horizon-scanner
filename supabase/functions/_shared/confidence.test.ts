import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveConfidence } from "./confidence.ts";

Deno.test("RCT, n=1200, all clear, controls explicit → high", () => {
  const result = deriveConfidence({
    study_design: "RCT",
    sample_size: 1200,
    effect_direction: "positive",
    effect_size_text: "8.4 percentage points",
    statistical_significance: "p<0.01",
    treatment_group: "households receiving CCT",
    control_group: "households receiving no CCT",
  });
  assertEquals(result.band, "high");
  assertEquals(result.score >= 5, true);
});

Deno.test("Descriptive, n=50, direction only → low", () => {
  const result = deriveConfidence({
    study_design: "descriptive",
    sample_size: 50,
    effect_direction: "positive",
    effect_size_text: null,
    statistical_significance: null,
    treatment_group: "unclear",
    control_group: "unclear",
  });
  assertEquals(result.band, "low");
});

Deno.test("Observational, n=2000, controls clear, sig given → medium", () => {
  const result = deriveConfidence({
    study_design: "observational",
    sample_size: 2000,
    effect_direction: "negative",
    effect_size_text: "0.4% lower",
    statistical_significance: "p<0.05",
    treatment_group: "high-wage areas",
    control_group: "low-wage areas",
  });
  assertEquals(result.band, "medium");
});

Deno.test("Unknown design + unknown sample → low", () => {
  const result = deriveConfidence({
    study_design: null,
    sample_size: null,
    effect_direction: "unclear",
    effect_size_text: null,
    statistical_significance: null,
    treatment_group: "unclear",
    control_group: "unclear",
  });
  assertEquals(result.band, "low");
});
