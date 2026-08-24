// scripts/jel-survey/build-evidence-coding.mjs
//
// JEL Skill #2 — Evidence Coding Sheet builder.
//
// For a pinned JEL query, joins the search_run's evidence (and optionally
// candidate) work IDs with their works + evidence_cards rows, aggregates by
// design/country/decade/effect-direction, and writes a structured sheet to
// reports/evidence-coding-<query-id>-<YYYY-MM-DD>.json.
//
// The output is the input to JEL Skill #4 (section drafter): it lets the
// drafter slice papers by design ("identification-debates" section) and by
// country/decade ("stylized-facts", "external-validity-lac"), and surfaces
// which papers lack structured extraction so they can be enqueued for Qwen.
//
// Usage:
//   node scripts/jel-survey/build-evidence-coding.mjs --query <id>
//   node scripts/jel-survey/build-evidence-coding.mjs --all
//   node scripts/jel-survey/build-evidence-coding.mjs --query <id> --candidates
//   node scripts/jel-survey/build-evidence-coding.mjs --query <id> --enqueue-missing
//
// Flags:
//   --query <id>        Query id from evals/jel-survey-queries.json
//   --all               Build for all queries with a pinned search_run_id
//   --candidates        Include candidate (non-evidence) papers too (default: evidence only)
//   --enqueue-missing   Insert work_ids without a card into extraction_queue
//   --out-dir <path>    Override reports/ output directory
//   --help

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const FIXTURE_PATH = resolve(ROOT, "evals/jel-survey-queries.json");
const DEFAULT_OUT_DIR = resolve(ROOT, "reports");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { queryId: null, all: false, candidates: false, enqueueMissing: false, outDir: DEFAULT_OUT_DIR, help: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--query") { out.queryId = next; i++; }
    else if (flag === "--all") { out.all = true; }
    else if (flag === "--candidates") { out.candidates = true; }
    else if (flag === "--enqueue-missing") { out.enqueueMissing = true; }
    else if (flag === "--out-dir") { out.outDir = resolve(next); i++; }
    else if (flag === "--help" || flag === "-h") { out.help = true; }
  }
  return out;
}

function usage() {
  console.log(`
Usage: node scripts/jel-survey/build-evidence-coding.mjs --query <id> [flags]
       node scripts/jel-survey/build-evidence-coding.mjs --all

Flags:
  --query <id>        Query id from evals/jel-survey-queries.json
  --all               Build for all queries with a pinned search_run_id
  --candidates        Include candidate (non-evidence) papers (default: evidence only)
  --enqueue-missing   Insert work_ids without a card into extraction_queue
  --out-dir <path>    Override reports/ output directory
  --help              Show this message
`);
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function decadeOf(year) {
  if (!year || typeof year !== "number") return "unknown";
  const start = Math.floor(year / 10) * 10;
  return `${start}-${start + 9}`;
}

// Card uses lowercase ("observational"); works.methodology_design uses Title-case
// ("Observational"). Collapse to one canonical label so buckets don't split.
function normalizeDesign(raw) {
  if (!raw) return "unknown";
  const s = String(raw).trim().toLowerCase();
  if (s === "rct" || s === "randomized" || s.includes("random")) return "RCT";
  if (s === "did" || s.includes("difference-in-differences") || s.includes("difference in differences")) return "DiD";
  if (s === "iv" || s.includes("instrumental")) return "IV";
  if (s === "rdd" || s.includes("regression discontinuity")) return "RDD";
  if (s === "matching" || s.includes("propensity")) return "matching";
  if (s.includes("quasi")) return "quasi-experimental";
  if (s.includes("observ")) return "observational";
  if (s.includes("qualitative")) return "qualitative";
  if (s.includes("review") || s.includes("meta")) return "review";
  if (s.includes("simulation") || s.includes("structural")) return "simulation";
  if (s.includes("theor")) return "theoretical";
  if (s.includes("descriptive")) return "descriptive";
  return s;
}

function bucketByKey(papers, keyFn) {
  const buckets = {};
  for (const p of papers) {
    const keys = keyFn(p);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const key = k ?? "unknown";
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(p.workId);
    }
  }
  return buckets;
}

function countByKey(papers, keyFn) {
  const counts = {};
  for (const p of papers) {
    const keys = keyFn(p);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const key = k ?? "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Card normalization — flatten DB columns into a smaller, drafter-friendly shape
// ---------------------------------------------------------------------------

function normalizeCard(card) {
  if (!card) return null;
  return {
    design: card.study_design ?? null,
    comparisonType: card.comparison_type ?? null,
    intervention: card.intervention ?? null,
    outcome: card.outcome ?? null,
    secondaryOutcomes: card.secondary_outcomes ?? null,
    effectDirection: card.effect_direction ?? null,
    effectSizeText: card.effect_size_text ?? null,
    effectSizeNumeric: card.effect_size_numeric ?? null,
    effectType: card.effect_type ?? null,
    statisticalSignificance: card.statistical_significance ?? null,
    sampleSize: card.sample_size ?? card.sample_size_text ?? null,
    timeHorizon: card.time_horizon ?? null,
    identificationStrategy: card.identification_strategy ?? null,
    country: card.country ?? null,
    region: card.region ?? null,
    setting: card.setting ?? null,
    populationGroup: card.population_group ?? null,
    incomeGroup: card.income_group ?? null,
    limitations: card.limitations ?? null,
    heterogeneity: card.heterogeneity ?? null,
    mechanism: card.mechanism ?? null,
    externalValidityNote: card.external_validity_note ?? null,
    confidence: card.confidence ?? null,
    confidenceScore: card.confidence_score ?? null,
    sourceSection: card.source_section ?? null,
    findingShort: card.finding_short ?? null,
    multiFindingFlag: card.multi_finding_flag ?? false,
    ungroundedFields: card.ungrounded_fields ?? null,
  };
}

// ---------------------------------------------------------------------------
// Build sheet for one query
// ---------------------------------------------------------------------------

async function buildSheet(query, opts) {
  const runId = query.pinnedSearchRunId;
  if (!runId) throw new Error(`Query ${query.id} has no pinnedSearchRunId — run pin-eval-search-runs first.`);

  console.log(`[coding] ${query.id} → run ${runId}`);

  const { data: run, error: runErr } = await sb
    .from("search_runs")
    .select("id, query, intent, filters, candidate_work_ids, evidence_work_ids, signal_work_ids, coverage, query_facets, created_at")
    .eq("id", runId)
    .single();
  if (runErr) throw new Error(`search_run fetch failed: ${runErr.message}`);

  const evIds = run.evidence_work_ids ?? [];
  const candIds = run.candidate_work_ids ?? [];
  const workIds = opts.candidates ? Array.from(new Set([...evIds, ...candIds])) : evIds;
  console.log(`[coding]   ${evIds.length} evidence, ${candIds.length} candidates, fetching ${workIds.length} work rows`);

  // Fetch works + cards in batches (Postgres `in` operator limit safety).
  async function chunkedSelect(table, columns, ids, idColumn = "id") {
    const out = [];
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { data, error } = await sb.from(table).select(columns).in(idColumn, slice);
      if (error) throw new Error(`${table} chunk ${i}: ${error.message}`);
      out.push(...(data ?? []));
    }
    return out;
  }

  const works = await chunkedSelect(
    "works",
    "id, title, authors, year, venue, journal_issn, canonical_doi, url, open_access_pdf_url, sms_level, methodology_design, causal_strength, abs_rating, repec_percentile, publication_type, geography, fields_of_study",
    workIds,
  );
  const cards = await chunkedSelect(
    "evidence_cards",
    "work_id, study_design, comparison_type, intervention, outcome, secondary_outcomes, effect_direction, effect_size_text, effect_size_numeric, effect_type, statistical_significance, sample_size, sample_size_text, time_horizon, identification_strategy, country, region, setting, population_group, income_group, limitations, heterogeneity, mechanism, external_validity_note, confidence, confidence_score, source_section, finding_short, multi_finding_flag, ungrounded_fields",
    workIds,
    "work_id",
  );

  const cardById = new Map(cards.map((c) => [c.work_id, c]));
  const workById = new Map(works.map((w) => [w.id, w]));

  // Build paper records, ordered by evidence first, candidates second.
  const orderedIds = opts.candidates
    ? [...evIds, ...candIds.filter((id) => !evIds.includes(id))]
    : evIds;

  const papers = orderedIds.map((id) => {
    const w = workById.get(id);
    const c = cardById.get(id);
    const card = normalizeCard(c);
    return {
      workId: id,
      title: w?.title ?? null,
      authors: w?.authors ?? null,
      year: w?.year ?? null,
      venue: w?.venue ?? null,
      journalIssn: w?.journal_issn ?? null,
      canonicalDoi: w?.canonical_doi ?? null,
      url: w?.url ?? w?.open_access_pdf_url ?? null,
      smsLevel: w?.sms_level ?? null,
      methodologyDesign: w?.methodology_design ?? null,
      causalStrength: w?.causal_strength ?? null,
      absRating: w?.abs_rating ?? null,
      repecPercentile: w?.repec_percentile ?? null,
      publicationType: w?.publication_type ?? null,
      geography: w?.geography ?? null,
      isEvidence: evIds.includes(id),
      hasCard: !!card,
      hasOpenAccessPdf: !!w?.open_access_pdf_url,
      card,
    };
  });

  // Aggregations — design from card if available, else from work.methodology_design.
  const evidencePapers = papers.filter((p) => p.isEvidence);
  const designKey = (p) => normalizeDesign(p.card?.design ?? p.methodologyDesign);
  const countryKey = (p) => p.card?.country ?? p.geography ?? "unknown";
  const decadeKey = (p) => decadeOf(p.year);
  const effectKey = (p) => p.card?.effectDirection ?? "uncoded";

  const summary = {
    evidenceCount: evidencePapers.length,
    candidateCount: papers.length - evidencePapers.length,
    withCard: evidencePapers.filter((p) => p.hasCard).length,
    withoutCard: evidencePapers.filter((p) => !p.hasCard).length,
    designBreakdown: countByKey(evidencePapers, designKey),
    geographyBreakdown: countByKey(evidencePapers, countryKey),
    decadeBreakdown: countByKey(evidencePapers, decadeKey),
    effectDirectionBreakdown: countByKey(evidencePapers, effectKey),
  };

  const indexes = {
    byDesign: bucketByKey(evidencePapers, designKey),
    byGeography: bucketByKey(evidencePapers, countryKey),
    byDecade: bucketByKey(evidencePapers, decadeKey),
    byEffectDirection: bucketByKey(evidencePapers, effectKey),
    missingCard: evidencePapers.filter((p) => !p.hasCard).map((p) => p.workId),
  };

  console.log(`[coding]   summary: ${summary.withCard}/${summary.evidenceCount} have cards`);
  console.log(`[coding]   designs: ${JSON.stringify(summary.designBreakdown)}`);

  return {
    queryId: query.id,
    searchRunId: runId,
    query: run.query,
    intent: query.intent ?? run.intent,
    filters: run.filters,
    queryFacets: run.query_facets,
    designProfile: query.designProfile ?? null,
    citationProfile: query.citationProfile ?? null,
    coverage: run.coverage,
    searchRunCreatedAt: run.created_at,
    generatedAt: new Date().toISOString(),
    summary,
    indexes,
    papers,
  };
}

// ---------------------------------------------------------------------------
// Enqueue missing cards into extraction_queue
// ---------------------------------------------------------------------------

async function enqueueMissing(workIds) {
  if (workIds.length === 0) return { inserted: 0, alreadyQueued: 0 };
  const rows = workIds.map((id, i) => ({
    work_id: id,
    priority_score: 100 - i / workIds.length, // small per-position decay so order is preserved
    state: "queued",
    tier: 1,
  }));
  // Upsert with ignoreDuplicates so existing rows aren't trampled.
  const { data, error } = await sb
    .from("extraction_queue")
    .upsert(rows, { onConflict: "work_id", ignoreDuplicates: true })
    .select("work_id");
  if (error) throw new Error(`extraction_queue upsert: ${error.message}`);
  const inserted = data?.length ?? 0;
  return { inserted, alreadyQueued: workIds.length - inserted };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.queryId && !args.all)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const allQueries = fixture.queries ?? [];
  const targets = args.all
    ? allQueries.filter((q) => q.pinnedSearchRunId)
    : allQueries.filter((q) => q.id === args.queryId);

  if (targets.length === 0) {
    console.error(args.all
      ? "No queries have a pinnedSearchRunId — run pin-eval-search-runs first."
      : `No query matches --query=${args.queryId} (or it lacks a pinnedSearchRunId).`);
    process.exit(1);
  }

  await mkdir(args.outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  for (const q of targets) {
    const sheet = await buildSheet(q, args);
    const outPath = resolve(args.outDir, `evidence-coding-${q.id}-${today}.json`);
    await writeFile(outPath, JSON.stringify(sheet, null, 2) + "\n");
    console.log(`[coding]   wrote ${outPath}`);

    if (args.enqueueMissing && sheet.indexes.missingCard.length > 0) {
      const res = await enqueueMissing(sheet.indexes.missingCard);
      console.log(`[coding]   enqueued ${res.inserted} (already queued: ${res.alreadyQueued})`);
    }
  }

  console.log(`\nDone. Built ${targets.length} coding sheet${targets.length !== 1 ? "s" : ""}.`);
}

main().catch((err) => {
  console.error("[coding] fatal:", err);
  process.exit(1);
});
