#!/usr/bin/env node
/**
 * Ingest LAC + Iberian health-policy journals identified as gaps in the
 * 2026-04-30 reference-list audit. Targets:
 *   - Journal of Ambulatory Care Management (0 in corpus)
 *   - Population Medicine (0 in corpus)
 *   - 10 Spanish/Portuguese health-policy outlets widely cited in IADB work
 *
 * Tags rows with corpus_source='lac_health_policy', source='openalex'.
 * Pre-computes SMS regex tags (with Spanish + Portuguese terms) + scl_topics.
 * Embedding pass deferred to backfill-fast.mjs.
 *
 * Usage:
 *   node scripts/import-lac-health-policy.mjs                # all 12, last 15y
 *   node scripts/import-lac-health-policy.mjs --dry-run      # count only
 *   node scripts/import-lac-health-policy.mjs --years 25     # extend window
 *
 * Shared ingest logic lives in scripts/lib/openalex-journal-ingester.mjs.
 */

import { config } from "dotenv";
import { ingestJournals } from "./lib/openalex-journal-ingester.mjs";

config();

// Resolved via OpenAlex /sources?filter=issn:... on 2026-04-30
const JOURNALS = [
  { id: "S2756004672", name: "Journal of Ambulatory Care Management",         tag: "gap-zero"   },
  { id: "S4210217879", name: "Population Medicine",                            tag: "gap-zero"   },
  { id: "S150269880",  name: "Salud Pública de México",                        tag: "lac-es"     },
  { id: "S118474221",  name: "Cadernos de Saúde Pública",                      tag: "lac-pt"     },
  { id: "S53297675",   name: "Ciência & Saúde Coletiva",                       tag: "lac-pt"     },
  { id: "S4210196923", name: "Revista Panamericana de Salud Pública",          tag: "lac-es"     },
  { id: "S131584251",  name: "Salud Colectiva",                                tag: "lac-es"     },
  { id: "S4210174478", name: "Revista de Salud Pública (Colombia)",            tag: "lac-es"     },
  { id: "S4210172956", name: "Gaceta Sanitaria",                               tag: "iberian-es" },
  { id: "S4210225962", name: "Revista Brasileira de Saúde Materno Infantil",   tag: "lac-pt"     },
  { id: "S164583999",  name: "Revista de Saúde Pública",                       tag: "lac-pt"     },
  { id: "S16625986",   name: "Salud Mental",                                   tag: "lac-es"     },
];

// SMS patterns extended with Spanish and Portuguese terms for LAC/Iberian
// health-policy literature, which often publishes in those languages.
const SMS_PATTERNS_MULTILINGUAL = [
  { design: "RCT",           level: 5, re: /\b(randomized|randomised|rct|random assignment|randomly assigned|ensayo aleatorizado|ensaio aleatorizado)\b/i },
  { design: "DiD",           level: 4, re: /\b(difference[- ]in[- ]differences?|diff[- ]in[- ]diff|did estimator|double difference|diferenças? em diferenças?|diferencias? en diferencias?)\b/i },
  { design: "IV",            level: 4, re: /\b(instrumental variables?|two[- ]stage least squares|2sls|iv estimator|variables? instrumentales?|variáveis? instrumentais?)\b/i },
  { design: "RDD",           level: 4, re: /\b(regression[- ]discontinuity|rdd|regresión discontinua|regressão descontínua)\b/i },
  { design: "Synthetic",     level: 4, re: /\b(synthetic control|control sintético|controle sintético)\b/i },
  { design: "PSM",           level: 3, re: /\b(propensity[- ]score|matching estimator|puntaje de propensión|escore de propensão)\b/i },
  { design: "Observational", level: 2, re: /\b(observational|cross[- ]sectional|panel data|fixed effects|observacional|transversal|datos de panel|dados de painel)\b/i },
  { design: "Qualitative",   level: 1, re: /\b(qualitative|case study|ethnograph|interview|focus group|cualitativ|estudio de caso|qualitativ|estudo de caso)\b/i },
];

ingestJournals({
  journals: JOURNALS,
  corpusSource: "lac_health_policy",
  bannerTitle: "LAC Health-Policy Journal Ingest",
  labelFor: (j) => (j.tag ?? "").padEnd(10),
  rawDataExtras: (paper) => ({ journal_tag: paper.journal.tag }),
  smsPatterns: SMS_PATTERNS_MULTILINGUAL,
}).catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
