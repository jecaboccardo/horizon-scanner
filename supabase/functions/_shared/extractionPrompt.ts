export const EXTRACTION_PROMPT_VERSION = "v1.2";

export const EXTRACTION_SYSTEM_PROMPT = `You are extracting a structured evidence card from a research paper for a policy analyst's evidence database. Fidelity matters more than completeness: it is better to leave a field NULL than to invent or infer.

Output a single JSON object matching the schema. No prose, no markdown, no comments.

HARD RULES — non-negotiable:

1. GROUNDING. Every non-null field must be traceable to text in the source. If you cannot quote the supporting passage in source_text, leave the field NULL and add the field name to ungrounded_fields.

2. CAUSAL LANGUAGE. Never use "caused", "led to", "increased", "reduced", or other causal verbs for observational studies. Use "associated with", "correlated with", "predicted by". Causal verbs are reserved for RCTs, RDDs, IVs, and well-controlled DiDs.

3. TREATMENT/CONTROL. If both are not identifiable in the source, write "unclear" — never invent.

4. EFFECT DIRECTION. Derive from source_text quote, not inference. Output exactly one of these strings: "positive" | "negative" | "null" | "mixed" | "unclear". Never output a long phrase like "positive for X but negative for Y" — use "mixed" instead. "no significant effect" or "n.s." → "null" (the string, not JSON null) even if a point estimate exists. If the abstract reports findings without giving direction, use "unclear", not blank.

5. EFFECT TYPE. Extract exact unit (percentage_points, percent, SD, OR, RR, HR, absolute). Unclear → "unclear".

6. STUDY DESIGN. Pick exactly one: RCT | quasi-experimental | observational | qualitative | review | descriptive. quasi-experimental = DiD, IV, RDD, matching, synthetic control. observational = regression with controls but no identification strategy.

7. CONFIDENCE. Computed by the consumer of this output using a scoring formula — do not include a "confidence" field in your JSON output.

8. MULTI-FINDING FLAG. true if paper reports >1 distinct outcome, tests >1 treatment arm, or shows substantially different effects across subgroups.

9. NO HALLUCINATED CONTEXT. Do not assume "rural", "developing country", "low-income" unless source explicitly states.

10. LANGUAGE. Extract in source language. Do not translate.

OUTPUT SCHEMA (JSON):
{
  "study_design": "RCT|quasi-experimental|observational|qualitative|review|descriptive",
  "comparison_type": "experimental|quasi-experimental|observational|none",
  "country": ["string"],
  "region": ["string"],
  "setting": "urban|rural|mixed|unclear|null",
  "population_group": "string|null",
  "analysis_unit": "individual|household|firm|school|region|country|null",
  "age_range": "string|null",
  "income_group": "low|middle|high|mixed|unclear|null",
  "intervention": "string",
  "outcome": "string",
  "secondary_outcomes": ["string"],
  "treatment_group": "string|unclear",
  "control_group": "string|unclear",
  "effect_direction": "positive|negative|null|mixed|unclear",
  "effect_size_text": "string|null",
  "effect_size_numeric": "number|null",
  "effect_type": "percentage_points|percent|SD|OR|RR|HR|absolute|unclear|null",
  "baseline_level": "string|null",
  "statistical_significance": "string|null",
  "sample_size": "integer|null",
  "sample_size_text": "string|null",
  "time_horizon": "string|null",
  "data_source": "survey|administrative|mixed|experimental|unclear|null",
  "identification_strategy": "string|null",
  "limitations": ["string"],
  "heterogeneity": "string|null",
  "secondary_findings": "string|null",
  "mechanism": "string|null",
  "external_validity_note": "string|null",
  "multi_finding_flag": "boolean",
  "source_section": "abstract|results|conclusion|table|mixed",
  "source_text": "string (verbatim quote from source)",
  "ungrounded_fields": ["string"],
  "finding_short": "string (30-300 words)"
}`;

const FEW_SHOTS = `
EXAMPLE 1 — Clean RCT, positive effect:

Title: "Conditional Cash Transfers and School Attendance: Evidence from Rural Kenya"
Abstract: "This cluster randomized controlled trial of 1,200 students aged 10-14 in 30 villages in rural Kenya tested whether conditional cash transfers to households increase school attendance. Households in 15 randomly assigned treatment villages received transfers conditional on >85% attendance; control villages received no transfer. Over 18 months, treatment villages saw an 8.4 percentage point increase in attendance (p<0.01) relative to control. Effects were stronger for girls (+11.2pp) and lower-income households."

Output:
{
  "study_design": "RCT",
  "comparison_type": "experimental",
  "country": ["Kenya"],
  "region": ["East Africa"],
  "setting": "rural",
  "population_group": "students",
  "analysis_unit": "individual",
  "age_range": "10-14",
  "income_group": "mixed",
  "intervention": "conditional cash transfer to households",
  "outcome": "school attendance",
  "secondary_outcomes": [],
  "treatment_group": "households in 15 treatment villages receiving conditional cash transfer",
  "control_group": "households in 15 control villages receiving no transfer",
  "effect_direction": "positive",
  "effect_size_text": "8.4 percentage points",
  "effect_size_numeric": 8.4,
  "effect_type": "percentage_points",
  "baseline_level": null,
  "statistical_significance": "p<0.01",
  "sample_size": 1200,
  "sample_size_text": "1,200 students aged 10-14 in 30 villages",
  "time_horizon": "18 months",
  "data_source": "experimental",
  "identification_strategy": "village-level random assignment (cluster RCT)",
  "limitations": [],
  "heterogeneity": "Effects stronger for girls (+11.2pp) and lower-income households.",
  "secondary_findings": null,
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": false,
  "source_section": "abstract",
  "source_text": "Over 18 months, treatment villages saw an 8.4 percentage point increase in attendance (p<0.01) relative to control. Effects were stronger for girls (+11.2pp) and lower-income households.",
  "ungrounded_fields": ["baseline_level","limitations","mechanism","external_validity_note"],
  "finding_short": "Cluster RCT in rural Kenya, n=1,200 students aged 10-14 across 30 villages. Conditional cash transfers to households raised school attendance by 8.4 percentage points over 18 months (p<0.01) relative to control villages with no transfer. Effects were stronger for girls (+11.2pp) and for lower-income households."
}

EXAMPLE 2 — Observational, must avoid causal language:

Title: "Minimum Wages and Youth Employment in OECD Countries, 1990-2015"
Abstract: "We exploit panel variation in minimum wages across 22 OECD countries between 1990 and 2015 to study correlations with youth employment. Using country and year fixed effects, we find a 10% increase in real minimum wages is associated with 0.4% lower youth employment-to-population ratio. The relationship is stronger in southern Europe."

Output:
{
  "study_design": "observational",
  "comparison_type": "observational",
  "country": ["multiple OECD"],
  "region": ["OECD"],
  "setting": "mixed",
  "population_group": "youth",
  "analysis_unit": "country",
  "age_range": null,
  "income_group": "high",
  "intervention": "minimum wage levels",
  "outcome": "youth employment-to-population ratio",
  "secondary_outcomes": [],
  "treatment_group": "unclear",
  "control_group": "unclear",
  "effect_direction": "negative",
  "effect_size_text": "0.4% lower employment per 10% wage increase",
  "effect_size_numeric": -0.4,
  "effect_type": "percent",
  "baseline_level": null,
  "statistical_significance": null,
  "sample_size": null,
  "sample_size_text": "22 OECD countries, 1990-2015 panel",
  "time_horizon": "1990-2015",
  "data_source": "administrative",
  "identification_strategy": "country and year fixed effects",
  "limitations": ["no identification strategy beyond fixed effects","causal interpretation cautious"],
  "heterogeneity": "Relationship stronger in southern Europe.",
  "secondary_findings": null,
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": false,
  "source_section": "abstract",
  "source_text": "a 10% increase in real minimum wages is associated with 0.4% lower youth employment-to-population ratio. The relationship is stronger in southern Europe.",
  "ungrounded_fields": ["sample_size","baseline_level","statistical_significance","mechanism","external_validity_note"],
  "finding_short": "Cross-country panel of 22 OECD countries (1990-2015) finds youth employment is associated with minimum wage levels: a 10% wage increase correlates with 0.4% lower youth employment-to-population ratio. The relationship is stronger in southern Europe. Identification relies on country/year fixed effects only; causal interpretation should be cautious."
}

EXAMPLE 3 — Multi-finding paper:

Title: "Three Approaches to Improving Reading Skills: An RCT in Brazilian Schools"
Abstract: "This RCT in 120 Brazilian primary schools (n=14,400 students) tested three interventions against a control: (A) targeted literacy curriculum, (B) numeracy-focused curriculum, (C) combined A+B. After one school year, reading scores rose +0.18 SD under A (p<0.001), +0.04 SD under B (n.s.), +0.12 SD under C (p<0.05). Math scores rose +0.12 SD under B and C, no effect under A. Attendance was unchanged across all arms."

Output:
{
  "study_design": "RCT",
  "comparison_type": "experimental",
  "country": ["Brazil"],
  "region": ["Latin America"],
  "setting": null,
  "population_group": "students",
  "analysis_unit": "school",
  "age_range": null,
  "income_group": null,
  "intervention": "literacy curriculum (Treatment A)",
  "outcome": "reading scores",
  "secondary_outcomes": ["math scores","attendance"],
  "treatment_group": "schools assigned to Treatment A (literacy curriculum)",
  "control_group": "schools assigned to control curriculum",
  "effect_direction": "positive",
  "effect_size_text": "+0.18 SD",
  "effect_size_numeric": 0.18,
  "effect_type": "SD",
  "baseline_level": null,
  "statistical_significance": "p<0.001",
  "sample_size": 14400,
  "sample_size_text": "120 schools, n=14,400 students",
  "time_horizon": "one school year",
  "data_source": "experimental",
  "identification_strategy": "school-level random assignment",
  "limitations": [],
  "heterogeneity": "Treatment B (numeracy) showed null effect on reading; Treatment C (combined) raised reading by 0.12 SD (p<0.05). Math scores improved under B and C only.",
  "secondary_findings": "Math scores: +0.12 SD under Treatment B and C, null under A. Attendance unchanged across all arms.",
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": true,
  "source_section": "abstract",
  "source_text": "reading scores rose +0.18 SD under A (p<0.001), +0.04 SD under B (n.s.), +0.12 SD under C (p<0.05). Math scores rose +0.12 SD under B and C, no effect under A. Attendance was unchanged across all arms.",
  "ungrounded_fields": ["baseline_level","mechanism","external_validity_note"],
  "finding_short": "RCT in 120 Brazilian primary schools (n=14,400 students) tested three interventions. The literacy curriculum (Treatment A) raised reading scores by 0.18 SD over one school year (p<0.001) compared to control. Treatment B (numeracy) had no effect on reading; Treatment C (combined) raised reading by 0.12 SD (p<0.05). Math scores improved under B and C only (+0.12 SD each). Attendance unchanged across all arms."
}

EXAMPLE 4 — Quasi-experimental study (DiD / IV / RDD — NOT "observational"):

Title: "Conditional Cash Transfers and Labor Supply: Regression Discontinuity Evidence from Colombia"
Abstract: "We exploit the SISBEN welfare eligibility score as a sharp cutoff for conditional cash transfer receipt in Colombia. Households just below the threshold receive transfers; those just above do not. Using administrative records for 180,000 households (2005-2015), we find CCT receipt reduces adult labor market participation by 8.3 percentage points (p<0.01). Effects are stronger for women (-12.4pp) than men (-4.1pp)."

IMPORTANT: This study uses a quasi-experimental design (regression discontinuity), NOT observational. The treatment and control groups are defined by which side of the score cutoff they fall on.

Output:
{
  "study_design": "quasi-experimental",
  "comparison_type": "quasi-experimental",
  "country": ["Colombia"],
  "region": ["Latin America"],
  "setting": "mixed",
  "population_group": "households",
  "analysis_unit": "household",
  "age_range": null,
  "income_group": "low",
  "intervention": "conditional cash transfer (CCT) receipt",
  "outcome": "adult labor market participation",
  "secondary_outcomes": [],
  "treatment_group": "households scoring just below the SISBEN threshold receiving CCT",
  "control_group": "households scoring just above the SISBEN threshold not receiving CCT",
  "effect_direction": "negative",
  "effect_size_text": "8.3 percentage points lower labor market participation",
  "effect_size_numeric": -8.3,
  "effect_type": "percentage_points",
  "baseline_level": null,
  "statistical_significance": "p<0.01",
  "sample_size": 180000,
  "sample_size_text": "180,000 households from administrative records",
  "time_horizon": "2005-2015",
  "data_source": "administrative",
  "identification_strategy": "regression discontinuity at SISBEN eligibility score cutoff",
  "limitations": [],
  "heterogeneity": "Effects stronger for women (-12.4pp) than men (-4.1pp).",
  "secondary_findings": null,
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": false,
  "source_section": "abstract",
  "source_text": "we find CCT receipt reduces adult labor market participation by 8.3 percentage points (p<0.01). Effects are stronger for women (-12.4pp) than men (-4.1pp).",
  "ungrounded_fields": ["baseline_level","mechanism","external_validity_note"],
  "finding_short": "Regression discontinuity study exploiting the SISBEN eligibility score cutoff in Colombia (n=180,000 households, 2005-2015). CCT receipt reduced adult labor market participation by 8.3 percentage points (p<0.01). Effects were stronger for women (-12.4pp) than men (-4.1pp)."
}

KEY RULE: If an abstract describes any of these methods — difference-in-differences, DiD, regression discontinuity, RDD, instrumental variables, IV, matching, synthetic control — set study_design = "quasi-experimental". NEVER set it to "observational" in these cases.

EXAMPLE 5 — Thin abstract, low confidence (study_design unknowable from abstract → null + ungrounded):

Title: "Educational Outcomes and Family Structure: A New Approach"
Abstract: "We present a new approach to estimating the relationship between family structure and educational outcomes. Results are presented and policy implications discussed."

Output:
{
  "study_design": null,
  "comparison_type": null,
  "country": [],
  "region": [],
  "setting": null,
  "population_group": null,
  "analysis_unit": null,
  "age_range": null,
  "income_group": null,
  "intervention": "family structure (unclear)",
  "outcome": "educational outcomes",
  "secondary_outcomes": [],
  "treatment_group": "unclear",
  "control_group": "unclear",
  "effect_direction": "unclear",
  "effect_size_text": null,
  "effect_size_numeric": null,
  "effect_type": null,
  "baseline_level": null,
  "statistical_significance": null,
  "sample_size": null,
  "sample_size_text": null,
  "time_horizon": null,
  "data_source": null,
  "identification_strategy": null,
  "limitations": ["thin abstract — full extraction requires results section"],
  "heterogeneity": null,
  "secondary_findings": null,
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": false,
  "source_section": "abstract",
  "source_text": "We present a new approach to estimating the relationship between family structure and educational outcomes. Results are presented and policy implications discussed.",
  "ungrounded_fields": ["study_design","setting","population_group","analysis_unit","sample_size","effect_direction","effect_size_text","statistical_significance","treatment_group","control_group","time_horizon","identification_strategy"],
  "finding_short": "Study of family structure and educational outcomes. The abstract does not summarize specific findings or methodology — full extraction requires the results section."
}

EXAMPLE 6 — Spanish-language paper (source_language="es"; classify into English schema enums but extract content in Spanish):

Title: "Transferencias monetarias condicionadas y deserción escolar: evidencia de Colombia"
Abstract: "Mediante un diseño cuasi-experimental basado en la elegibilidad por puntaje SISBEN, este estudio analiza el impacto del programa Familias en Acción sobre la deserción escolar en zonas rurales de Colombia. Los hogares elegibles (n=8,200) presentaron una tasa de deserción 3.2 puntos porcentuales menor (p<0.01) que hogares no elegibles en el periodo 2008-2015."

Output:
{
  "study_design": "quasi-experimental",
  "comparison_type": "quasi-experimental",
  "country": ["Colombia"],
  "region": ["Latin America"],
  "setting": "rural",
  "population_group": "hogares",
  "analysis_unit": "household",
  "age_range": null,
  "income_group": "low",
  "intervention": "Programa Familias en Acción (transferencia monetaria condicionada)",
  "outcome": "tasa de deserción escolar",
  "secondary_outcomes": [],
  "treatment_group": "hogares elegibles según puntaje SISBEN",
  "control_group": "hogares no elegibles",
  "effect_direction": "negative",
  "effect_size_text": "3.2 puntos porcentuales menor",
  "effect_size_numeric": -3.2,
  "effect_type": "percentage_points",
  "baseline_level": null,
  "statistical_significance": "p<0.01",
  "sample_size": 8200,
  "sample_size_text": "n=8,200 hogares",
  "time_horizon": "2008-2015",
  "data_source": "administrative",
  "identification_strategy": "discontinuidad de elegibilidad por puntaje SISBEN",
  "limitations": [],
  "heterogeneity": null,
  "secondary_findings": null,
  "mechanism": null,
  "external_validity_note": null,
  "multi_finding_flag": false,
  "source_section": "abstract",
  "source_text": "Los hogares elegibles (n=8,200) presentaron una tasa de deserción 3.2 puntos porcentuales menor (p<0.01) que hogares no elegibles en el periodo 2008-2015.",
  "ungrounded_fields": ["baseline_level","limitations","mechanism","external_validity_note"],
  "finding_short": "Estudio cuasi-experimental en Colombia (2008-2015, n=8,200 hogares) usando discontinuidad de elegibilidad SISBEN del programa Familias en Acción. Los hogares elegibles presentaron una tasa de deserción escolar 3.2 puntos porcentuales menor (p<0.01) que los hogares no elegibles.",
  "source_language": "es"
}`;

export function buildExtractionUserPrompt(input: {
  title: string;
  abstract: string;
  methodologyDesign?: string | null;
  resultsChunk?: string | null;
  conclusionChunk?: string | null;
}): string {
  const tier2 = input.resultsChunk || input.conclusionChunk;
  return `${FEW_SHOTS}

NOW EXTRACT FOR THIS PAPER:

Title: ${input.title}
Abstract: ${input.abstract}
${tier2 ? `Results section: ${input.resultsChunk ?? "(not available)"}\nConclusion section: ${input.conclusionChunk ?? "(not available)"}` : ""}
Methodology design (pre-classified, may be wrong): ${input.methodologyDesign ?? "unknown"}

Extract the evidence card. Output JSON only.`;
}

export const VERIFICATION_SYSTEM_PROMPT = `You are verifying that an extracted evidence card faithfully represents the source text. Output a single JSON object: {"valid": boolean, "issues": ["specific field name + reason"]}.

CHECK THESE FIELDS:
1. effect_direction matches what the source_text quote actually says (e.g., "no significant effect" → direction must be "null", not "positive")
2. treatment_group and control_group are explicitly identifiable in the source_text, not inferred
3. study_design matches the methodology described, not just the abstract's self-description
4. statistical_significance, if present, is consistent with effect_direction (a "p<0.05" with direction=null is inconsistent unless the abstract notes the result is null despite borderline p-value)
5. No causal language in card fields if study_design is "observational"

Output JSON only.`;

export function buildVerificationUserPrompt(card: unknown, sourceText: string): string {
  return `source_text: "${sourceText.replace(/"/g, '\\"')}"

extracted_card: ${JSON.stringify(card, null, 2)}

Verify and output JSON.`;
}
