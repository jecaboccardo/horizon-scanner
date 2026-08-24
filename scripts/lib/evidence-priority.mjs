import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EVIDENCE_PRIORITY_SELECT = [
  "id",
  "title",
  "abstract",
  "canonical_doi",
  "venue",
  "year",
  "citation_count",
  "sms_level",
  "methodology_design",
  "causal_strength",
  "abs_rating",
  "repec_percentile",
  "publication_type",
  "source_family",
  "venue_kind",
  "corpus_source",
  "source",
  "open_access_pdf_url",
  "url",
  "raw_data",
  "geography",
  "fields_of_study",
  "scl_topics",
].join(",");

const ECON_SOURCE_FAMILIES = new Set([
  "IADB",
  "World Bank",
  "NBER",
  "SSRN",
  "IZA",
  "CEPR",
  "RePEc",
  "OECD",
]);

const ECON_INSTITUTIONS = new Set([
  "IDB",
  "IADB",
  "World Bank",
  "OECD",
  "IMF",
  "ECLAC",
  "CEPAL",
  "NBER",
  "IZA",
  "CEPR",
  "RePEc",
]);

const LAC_TERMS = [
  "latin america", "latin american", "america latina", "américa latina", "latam", "lac",
  "caribbean", "caribe", "argentina", "bolivia", "brazil", "brasil", "chile",
  "colombia", "costa rica", "dominican republic", "ecuador", "el salvador",
  "guatemala", "haiti", "honduras", "jamaica", "mexico", "méxico", "nicaragua",
  "panama", "paraguay", "peru", "perú", "uruguay", "venezuela", "iadb", "idb",
];

const ECON_KEYWORD_GROUPS = [
  /\b(econom(?:y|ic|ics|ist|etric|etrics)|macroeconom|microeconom|development economics)\b/i,
  /\b(labo[u]?r|employment|unemployment|wage|earnings|worker|firm|productivity|human capital)\b/i,
  /\b(poverty|inequality|income distribution|social mobility|redistribution|welfare)\b/i,
  /\b(education|schooling|teacher|student achievement|learning outcomes)\b/i,
  /\b(health economics|health expenditure|health insurance|health policy|public health policy)\b/i,
  /\b(trade|tariff|export|import|globalization|migration|immigration|remittance)\b/i,
  /\b(tax|fiscal|public finance|cash transfer|social protection|pension|subsidy)\b/i,
  /\b(agricultur(?:e|al)|land titling|credit|financial inclusion|microfinance)\b/i,
  /\b(randomized|randomised|rct|difference[-\s]?in[-\s]?differences|diff[-\s]?in[-\s]?diff|instrumental variable|regression discontinuity|natural experiment|panel data)\b/i,
];

const ECON_VENUE_PATTERNS = [
  /\bamerican economic review\b/i,
  /\bquarterly journal of economics\b/i,
  /\beconometrica\b/i,
  /\bjournal of political economy\b/i,
  /\breview of economic studies\b/i,
  /\bjournal of economic literature\b/i,
  /\bjournal of economic perspectives\b/i,
  /\breview of economics and statistics\b/i,
  /\beconomic journal\b/i,
  /\bjournal of development economics\b/i,
  /\bworld development\b/i,
  /\bjournal of public economics\b/i,
  /\bjournal of labor economics\b/i,
  /\blabour economics\b/i,
  /\beconomics of education review\b/i,
  /\bjournal of health economics\b/i,
  /\bhealth economics\b/i,
  /\bjournal of human resources\b/i,
  /\bjournal of international economics\b/i,
  /\bjournal of econometrics\b/i,
  /\bjournal of urban economics\b/i,
  /\bjournal of economic behavior\b/i,
  /\bjournal of population economics\b/i,
  /\bjournal of policy analysis and management\b/i,
  /\bpolicy research working paper\b/i,
  /\bnber working paper\b/i,
  /\biza discussion paper\b/i,
  /\bcepr discussion paper\b/i,
  /\brepec\b/i,
  /\bcepal review\b/i,
  /\blatin american economic review\b/i,
  /\blatin american research review\b/i,
];

const BIOMED_PATTERNS = [
  /\b(cancer|oncology|tumou?r|chemotherapy|radiotherapy|immunotherapy)\b/i,
  /\b(neurology|neuroscience|stroke|alzheimer|parkinson|epilepsy)\b/i,
  /\b(surgery|surgical|anesthesia|anaesthesia|intensive care|icu)\b/i,
  /\b(molecular|protein|genetic|genomic|cellular|biomarker|receptor)\b/i,
  /\b(patient|clinical trial|disease|diagnosis|treatment arm|placebo)\b/i,
];

export function normDoi(value) {
  if (!value) return "";
  return String(value).toLowerCase().trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
}

function normTitle(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(work) {
  return [
    work.title,
    work.abstract,
    work.venue,
    work.source,
    work.corpus_source,
    work.url,
    Array.isArray(work.geography) ? work.geography.join(" ") : "",
    Array.isArray(work.fields_of_study) ? work.fields_of_study.join(" ") : "",
    Array.isArray(work.scl_topics) ? work.scl_topics.join(" ") : "",
  ].filter(Boolean).join(" ");
}

let goldSignalsCache = null;

export function loadGoldSignals(root = process.cwd()) {
  if (goldSignalsCache) return goldSignalsCache;

  const doiSet = new Set();
  const titleSet = new Set();
  const path = join(root, "evals", "queries.json");
  const evals = JSON.parse(readFileSync(path, "utf8"));

  for (const query of evals.queries ?? []) {
    for (const label of Object.values(query.labels ?? {})) {
      const doi = normDoi(label?.doi);
      if (doi) doiSet.add(doi);
      const title = normTitle(label?.title);
      if (title) titleSet.add(title);
    }
    for (const canary of query.canary_papers ?? []) {
      const doi = normDoi(canary?.doi_hint);
      if (doi) doiSet.add(doi);
      const title = normTitle(canary?.title);
      if (title) titleSet.add(title);
    }
  }

  goldSignalsCache = { doiSet, titleSet };
  return goldSignalsCache;
}

function goldHit(work, goldSignals) {
  const doi = normDoi(work.canonical_doi);
  if (doi && goldSignals.doiSet.has(doi)) return true;
  const title = normTitle(work.title);
  if (!title) return false;
  return goldSignals.titleSet.has(title);
}

function hasLac(text) {
  const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return LAC_TERMS.some((term) =>
    folded.includes(term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())
  );
}

function sourceFamilyScore(work, reasons) {
  const sf = String(work.source_family ?? "");
  if (!ECON_SOURCE_FAMILIES.has(sf)) return 0;
  if (sf === "IADB" || sf === "World Bank" || sf === "NBER") {
    reasons.push(`source:${sf}`);
    return 5;
  }
  reasons.push(`source:${sf}`);
  return 4;
}

function institutionScore(work, reasons) {
  const inst = String(work.raw_data?.institution ?? "");
  if (!ECON_INSTITUTIONS.has(inst)) return 0;
  if (inst === "IDB" || inst === "IADB" || inst === "World Bank") {
    reasons.push(`institution:${inst}`);
    return 4;
  }
  reasons.push(`institution:${inst}`);
  return 2;
}

export function computeEvidencePriority(work, basePriority = 0, options = {}) {
  const goldSignals = options.goldSignals ?? loadGoldSignals();
  const text = textOf(work);
  const reasons = [];
  let econScore = 0;

  if (goldHit(work, goldSignals)) {
    econScore += 25;
    reasons.push("gold/canary");
  }

  econScore += sourceFamilyScore(work, reasons);
  econScore += institutionScore(work, reasons);

  const venue = String(work.venue ?? "");
  if (ECON_VENUE_PATTERNS.some((pattern) => pattern.test(venue))) {
    econScore += 5;
    reasons.push("econ-venue");
  }

  let keywordHits = 0;
  for (const pattern of ECON_KEYWORD_GROUPS) {
    if (pattern.test(text)) keywordHits++;
  }
  if (keywordHits > 0) {
    econScore += Math.min(4, keywordHits * 0.9);
    reasons.push(`econ-terms:${keywordHits}`);
  }

  if (hasLac(text)) {
    econScore += 1.5;
    reasons.push("lac");
  }

  if (["working_paper", "discussion_paper", "report"].includes(work.publication_type)) {
    econScore += 0.8;
  }

  if (work.abs_rating === "4*" || work.abs_rating === "4") econScore += 2.5;
  else if (work.abs_rating === "3") econScore += 1.5;

  const repec = Number(work.repec_percentile);
  if (Number.isFinite(repec) && repec > 0) {
    econScore += repec >= 95 ? 1.5 : repec >= 75 ? 1.0 : 0.4;
  }

  const sms = Number(work.sms_level);
  if (Number.isFinite(sms)) {
    if (sms >= 5) econScore += 1.4;
    else if (sms >= 4) econScore += 1.0;
    else if (sms >= 3) econScore += 0.5;
    else if (sms > 0) econScore -= 0.5;
  }

  if (String(work.methodology_design ?? "").toLowerCase() === "review") {
    econScore += 0.8;
  }

  const year = Number(work.year);
  if (Number.isFinite(year)) {
    if (year >= 2020) econScore += 1.0;
    else if (year >= 2010) econScore += 0.5;
  }

  const hasExplicitEconAnchor = reasons.some((reason) =>
    reason.startsWith("gold/") ||
    reason.startsWith("source:") ||
    reason.startsWith("institution:") ||
    reason === "econ-venue" ||
    reason.startsWith("econ-terms:")
  );
  const biomedicalHits = BIOMED_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (biomedicalHits > 0 && !hasExplicitEconAnchor) {
    econScore -= Math.min(7, biomedicalHits * 2.5);
    reasons.push(`non-econ-biomed:${biomedicalHits}`);
  }

  const finalPriority = Math.max(0.1, Number(basePriority ?? 0) + econScore);
  return {
    basePriority: Number(basePriority ?? 0),
    econScore,
    finalPriority,
    reasons,
  };
}

export function isEconEligible(scored, minEconScore = 3) {
  return scored.econScore >= minEconScore || scored.reasons.includes("gold/canary");
}
