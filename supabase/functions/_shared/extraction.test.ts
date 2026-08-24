import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { criticalFieldsMissing } from "./extraction.ts";
import type { RawCard } from "./extraction.ts";

function minimalCard(overrides: Partial<RawCard> = {}): RawCard {
  return {
    study_design: "RCT",
    comparison_type: "experimental",
    country: ["Kenya"],
    region: [],
    setting: "rural",
    population_group: "students",
    analysis_unit: "individual",
    age_range: "10-14",
    income_group: null,
    intervention: "CCT",
    outcome: "attendance",
    secondary_outcomes: [],
    treatment_group: "treatment group",
    control_group: "control group",
    effect_direction: "positive",
    effect_size_text: "8.4 percentage points",
    effect_size_numeric: 8.4,
    effect_type: "percentage_points",
    baseline_level: null,
    statistical_significance: "p<0.01",
    sample_size: 1200,
    sample_size_text: "n=1200",
    time_horizon: "18 months",
    data_source: "experimental",
    identification_strategy: "RCT",
    limitations: [],
    heterogeneity: null,
    secondary_findings: null,
    mechanism: null,
    external_validity_note: null,
    multi_finding_flag: false,
    source_section: "abstract",
    source_text: "treatment raised attendance by 8.4pp (p<0.01)",
    ungrounded_fields: [],
    finding_short: "RCT in Kenya...",
    ...overrides,
  };
}

Deno.test("criticalFieldsMissing: complete RCT card → false", () => {
  assertEquals(criticalFieldsMissing(minimalCard(), "RCT"), false);
});

Deno.test("criticalFieldsMissing: missing effect_size_text → true", () => {
  assertEquals(
    criticalFieldsMissing(minimalCard({ effect_size_text: null }), "RCT"),
    true,
  );
});

Deno.test("criticalFieldsMissing: unclear treatment_group → true", () => {
  assertEquals(
    criticalFieldsMissing(minimalCard({ treatment_group: "unclear" }), "RCT"),
    true,
  );
});

Deno.test("criticalFieldsMissing: RCT missing statistical_significance → true", () => {
  assertEquals(
    criticalFieldsMissing(minimalCard({ statistical_significance: null }), "RCT"),
    true,
  );
});

Deno.test("criticalFieldsMissing: observational missing sig → false (not required)", () => {
  assertEquals(
    criticalFieldsMissing(minimalCard({ statistical_significance: null }), "observational"),
    false,
  );
});

Deno.test("criticalFieldsMissing: unclear effect_direction → true", () => {
  assertEquals(
    criticalFieldsMissing(minimalCard({ effect_direction: "unclear" }), "RCT"),
    true,
  );
});
