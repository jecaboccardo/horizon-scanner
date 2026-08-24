import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_PROMPT_VERSION,
  buildExtractionUserPrompt,
  VERIFICATION_SYSTEM_PROMPT,
  buildVerificationUserPrompt,
} from "./extractionPrompt.ts";
import { qwenGenerateJSON } from "./qwenClient.ts";
import { deriveConfidence } from "./confidence.ts";

export interface ExtractionInput {
  work_id: string;
  title: string;
  abstract: string;
  methodology_design?: string | null;
  results_chunk?: string | null;
  conclusion_chunk?: string | null;
  source_language?: string;
}

export interface RawCard {
  study_design: string | null;
  comparison_type: string | null;
  country: string[];
  region: string[];
  setting: string | null;
  population_group: string | null;
  analysis_unit: string | null;
  age_range: string | null;
  income_group: string | null;
  intervention: string;
  outcome: string;
  secondary_outcomes: string[];
  treatment_group: string;
  control_group: string;
  effect_direction: string | null;
  effect_size_text: string | null;
  effect_size_numeric: number | null;
  effect_type: string | null;
  baseline_level: string | null;
  statistical_significance: string | null;
  sample_size: number | null;
  sample_size_text: string | null;
  time_horizon: string | null;
  data_source: string | null;
  identification_strategy: string | null;
  limitations: string[];
  heterogeneity: string | null;
  secondary_findings: string | null;
  mechanism: string | null;
  external_validity_note: string | null;
  multi_finding_flag: boolean;
  source_section: string;
  source_text: string;
  ungrounded_fields: string[];
  finding_short: string;
}

export interface EvidenceCard extends RawCard {
  work_id: string;
  confidence: "high" | "medium" | "low";
  confidence_score: number;
  extracted_by: string;
  extraction_prompt_version: string;
  extraction_tier: 1 | 2 | 3;
  needs_review: boolean;
  source_language: string;
}

export interface VerificationResult {
  valid: boolean;
  issues: string[];
}

// Normalize effect_direction to the valid enum: positive | negative | null | mixed | unclear
// Qwen sometimes returns capitalized, directional words, or multi-sentence descriptions.
export function normalizeDirection(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (s === "positive" || s === "negative" || s === "null" || s === "mixed" || s === "unclear") {
    return s;
  }
  // Long compound description → mixed
  if (s.length > 30 && s.includes("positive") && (s.includes("negative") || s.includes("null") || s.includes("no significant"))) {
    return "mixed";
  }
  const negWords = ["decrease", "declin", "reduc", "lower", "fell", "drop", "worsen"];
  const posWords = ["increase", "improv", "higher", "rose", "rise", "gain", "grow"];
  const nullWords = ["no significant", "no effect", "insignificant", "not significant", "no detectable"];
  if (nullWords.some(w => s.includes(w))) return "null";
  if (negWords.some(w => s.includes(w)) && !posWords.some(w => s.includes(w))) return "negative";
  if (posWords.some(w => s.includes(w)) && !negWords.some(w => s.includes(w))) return "positive";
  return "unclear";
}

// Critical fields that must be present for Tier 1 to be considered sufficient.
// If any are missing/unclear AND a PDF is available, escalate to Tier 2.
export function criticalFieldsMissing(card: RawCard, design: string | null): boolean {
  if (!card.effect_size_text) return true;
  if (card.treatment_group === "unclear" || card.control_group === "unclear") return true;
  if (
    (design === "RCT" || design === "quasi-experimental") &&
    !card.statistical_significance
  ) return true;
  if (card.effect_direction === "unclear") return true;
  return false;
}

export async function extractEvidenceCard(
  input: ExtractionInput,
  opts: { skipVerification?: boolean } = {},
): Promise<EvidenceCard> {
  const tier: 1 | 2 = input.results_chunk || input.conclusion_chunk ? 2 : 1;

  const userPrompt = buildExtractionUserPrompt({
    title: input.title,
    abstract: input.abstract,
    methodologyDesign: input.methodology_design ?? null,
    resultsChunk: input.results_chunk ?? null,
    conclusionChunk: input.conclusion_chunk ?? null,
  });

  const raw = await qwenGenerateJSON<RawCard>(userPrompt, {
    system: EXTRACTION_SYSTEM_PROMPT,
    numCtx: 16384,
    temperature: 0.1,
  });

  // Derive confidence from structured fields
  const conf = deriveConfidence({
    study_design: raw.study_design,
    sample_size: raw.sample_size,
    effect_direction: raw.effect_direction,
    effect_size_text: raw.effect_size_text,
    statistical_significance: raw.statistical_significance,
    treatment_group: raw.treatment_group,
    control_group: raw.control_group,
  });

  // Low confidence or thin abstract always flags for review
  let needs_review = conf.band === "low";

  // Two-pass verification (mandatory unless skipped for testing)
  if (!opts.skipVerification) {
    try {
      const verify = await qwenGenerateJSON<VerificationResult>(
        buildVerificationUserPrompt(raw, raw.source_text ?? ""),
        {
          system: VERIFICATION_SYSTEM_PROMPT,
          numCtx: 8192,
          temperature: 0,
        },
      );
      if (!verify.valid) {
        needs_review = true;
      }
    } catch {
      // Verification call failed — flag for review, don't abort extraction
      needs_review = true;
    }
  }

  return {
    ...raw,
    effect_direction: normalizeDirection(raw.effect_direction),
    work_id: input.work_id,
    confidence: conf.band,
    confidence_score: conf.score,
    extracted_by: process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? "qwen2.5:14b-synthesis",
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
    extraction_tier: tier,
    needs_review,
    source_language: input.source_language ?? "en",
  };
}
