export interface ConfidenceInput {
  study_design: string | null;
  sample_size: number | null;
  effect_direction: string | null;
  effect_size_text: string | null;
  statistical_significance: string | null;
  treatment_group: string | null;
  control_group: string | null;
}

export interface ConfidenceResult {
  score: number;
  band: "high" | "medium" | "low";
}

const QUASI_EXPERIMENTAL_DESIGNS = new Set([
  "did",
  "diff-in-diff",
  "difference-in-differences",
  "iv",
  "instrumental variable",
  "instrumental variables",
  "rdd",
  "regression discontinuity",
  "regression discontinuity design",
  "matching",
  "propensity score matching",
  "synthetic control",
  "quasi-experimental",
]);

function baseDesignScore(design: string | null): number {
  if (design === null) return 1;
  const d = design.trim().toLowerCase();
  if (d === "rct" || d === "randomized controlled trial") return 4;
  if (d === "review" || d === "systematic review" || d === "meta-analysis") return 3;
  if (QUASI_EXPERIMENTAL_DESIGNS.has(d)) return 3;
  if (d === "observational") return 2;
  if (d === "qualitative") return 2;
  if (d === "descriptive") return 1;
  // unknown
  return 1;
}

function isQuasiOrRCT(design: string | null): boolean {
  if (design === null) return false;
  const d = design.trim().toLowerCase();
  return d === "rct" || d === "randomized controlled trial" || QUASI_EXPERIMENTAL_DESIGNS.has(d);
}

function sampleAdj(sample_size: number | null, design: string | null): number {
  if (sample_size === null) return -1;
  if (sample_size >= 5000) return 1;
  if (sample_size >= 500) return 0;
  if (sample_size >= 100) {
    // penalty only for RCT or quasi-experimental; other designs stay 0
    return isQuasiOrRCT(design) ? -1 : 0;
  }
  return -2;
}

function isExplicit(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() !== "unclear";
}

function clarityAdj(
  effect_direction: string | null,
  effect_size_text: string | null,
  statistical_significance: string | null,
): number {
  const hasDirection = isExplicit(effect_direction);
  const hasSize = isExplicit(effect_size_text);
  const hasSig = isExplicit(statistical_significance);

  if (!hasDirection) return -2;
  if (hasDirection && hasSize && hasSig) return 1;
  if (hasDirection && hasSize) return 0;
  // direction only
  return -1;
}

function controlAdj(treatment_group: string | null, control_group: string | null): number {
  const hasTreatment = isExplicit(treatment_group);
  const hasControl = isExplicit(control_group);
  if (hasTreatment && hasControl) return 0;
  if (hasTreatment || hasControl) return -1;
  return -2;
}

function bandFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

export function deriveConfidence(input: ConfidenceInput): ConfidenceResult {
  const score =
    baseDesignScore(input.study_design) +
    sampleAdj(input.sample_size, input.study_design) +
    clarityAdj(input.effect_direction, input.effect_size_text, input.statistical_significance) +
    controlAdj(input.treatment_group, input.control_group);

  return {
    score,
    band: bandFromScore(score),
  };
}
