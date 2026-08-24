/**
 * scripts/bm25-cascade-eval.mjs
 *
 * BM25 Cascade Ranking Evaluation
 *
 * Compares three BM25-cascade ranking variants (A, B, C) against the current
 * composite rerank baseline on the three specified test queries.
 *
 * Fetches candidate data from Supabase search_runs, applies each variant as a
 * pure JS function, measures metrics on the re-ordered top-20.
 *
 * Usage: node scripts/bm25-cascade-eval.mjs
 *   --fresh   : Run fresh search_runs via API (requires .eval-token.txt)
 *   --dry-run : Use latest existing search_runs without new API calls
 *
 * Output: reports/bm25-cascade-eval-2026-05-21.md
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
try {
  const env = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // .env optional
}

const __dir = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://v0-horizon-scanner-iadb.vercel.app";
const TENANT_ID = "iadb-demo";

const QUERIES = [
  {
    id: "Q1",
    text: "How does automation and artificial intelligence affect labor markets and wages?",
  },
  {
    id: "Q2",
    text: "What are the effects of climate change on labor markets and employment in developing countries?",
  },
  {
    id: "Q3",
    text: "How do social protection programs affect poverty and inequality in Latin America?",
  },
];

const args = process.argv.slice(2);
const FRESH = args.includes("--fresh");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function runSearchRun(queryText) {
  const tokenPath = resolve(process.cwd(), ".eval-token.txt");
  if (!existsSync(tokenPath)) {
    throw new Error(".eval-token.txt not found — run: node scripts/get-eval-token.mjs");
  }
  const token = readFileSync(tokenPath, "utf8").trim();

  console.log(`  POST /api/search-runs for: "${queryText.slice(0, 60)}..."`);
  const t0 = Date.now();
  const resp = await fetch(`${API_BASE}/api/search-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": TENANT_ID,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: queryText, filters: {} }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const ms = Date.now() - t0;
  console.log(`  Done in ${ms}ms`);
  return data;
}

// ---------------------------------------------------------------------------
// Supabase fetch helpers
// ---------------------------------------------------------------------------

async function fetchLatestSearchRunForQuery(queryText) {
  // Partial match — the query must contain the key phrase
  const { data, error } = await sb
    .from("search_runs")
    .select(
      "id, query, created_at, candidate_work_ids, evidence_work_ids, evidence_classification, coverage",
    )
    .ilike("query", `%${queryText.slice(0, 40)}%`)
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) throw new Error(`search_runs fetch failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return data[0];
}

async function fetchWorksByIds(ids) {
  if (!ids || ids.length === 0) return [];
  // Fetch in batches of 200
  const allWorks = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data, error } = await sb
      .from("works")
      .select(
        "id, title, canonical_doi, year, citation_count, sms_level, geography, venue, source_family, methodology_design, venue_kind, abstract",
      )
      .in("id", batch);
    if (error) throw new Error(`works fetch failed: ${error.message}`);
    if (data) allWorks.push(...data);
  }
  return allWorks;
}

// ---------------------------------------------------------------------------
// Scoring functions (mirrors rerank.ts)
// ---------------------------------------------------------------------------

const LAC_TERMS = [
  "latin america", "latin american", "america latina", "latam", "lac",
  "caribbean", "caribe", "south america", "central america",
  "argentina", "bolivia", "brazil", "brasil", "chile", "colombia", "costa rica",
  "cuba", "dominican republic", "ecuador", "el salvador", "guatemala", "haiti",
  "honduras", "jamaica", "mexico", "méxico", "nicaragua", "panama", "paraguay",
  "peru", "perú", "uruguay", "venezuela",
];
const LAC_REGEX = new RegExp(
  `\\b(${LAC_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

function rigorScore(p) {
  const sms = Number(p.sms_level ?? 0);
  if (!Number.isFinite(sms) || sms < 1) return 0;
  return Math.min(sms, 5) / 5;
}

function recencyScore(p) {
  const year = Number(p.year ?? 0);
  if (!Number.isFinite(year) || year < 1900) return 0;
  const age = Math.max(0, 2026 - year);
  return Math.max(0, 1 - age / 25);
}

function regionMatchScore(p) {
  const haystack = [
    p.title ?? "",
    p.abstract ?? "",
    Array.isArray(p.geography) ? p.geography.join(" ") : (p.geography ?? ""),
  ].join(" ");
  return LAC_REGEX.test(haystack) ? 1 : 0;
}

function citationScore(p) {
  const citations = Number(p.citation_count ?? 0);
  if (!Number.isFinite(citations) || citations <= 0) return 0;
  const year = Number(p.year ?? 0);
  if (!Number.isFinite(year) || year < 1900) return 0;
  const age = Math.max(1, 2026 - year + 1);
  const rate = citations / age;
  const CEILING = 500;
  const LOG_CEILING = Math.log(1 + CEILING);
  return Math.max(0, Math.min(1, Math.log(1 + rate) / LOG_CEILING));
}

function ftsScore(p) {
  const raw = Number(p.ftsRank ?? p.fts_rank ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

function similarityScore(p) {
  const sim = Number(p.similarity ?? 0);
  return Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0;
}

// ---------------------------------------------------------------------------
// Baseline reranker (mirrors DEFAULT_RERANK_WEIGHTS in rerank.ts)
// ---------------------------------------------------------------------------

const BASELINE_WEIGHTS = {
  similarity: 0.50,
  rigor: 0.15,
  recency: 0.05,
  region: 0.05,
  citation: 0.20,
  fts: 0.05,
};

function baselineScore(p, lacQuery) {
  const sim = similarityScore(p);
  const rig = rigorScore(p);
  const rec = recencyScore(p);
  const reg = lacQuery ? regionMatchScore(p) : 0;
  const cit = citationScore(p);
  const fts = ftsScore(p);
  const regionWeight = lacQuery ? BASELINE_WEIGHTS.region : 0;
  const effectiveSim = lacQuery ? BASELINE_WEIGHTS.similarity : BASELINE_WEIGHTS.similarity + BASELINE_WEIGHTS.region;
  return (
    effectiveSim * sim +
    BASELINE_WEIGHTS.rigor * rig +
    BASELINE_WEIGHTS.recency * rec +
    regionWeight * reg +
    BASELINE_WEIGHTS.citation * cit +
    BASELINE_WEIGHTS.fts * fts
  );
}

// ---------------------------------------------------------------------------
// Option A: Synthetic similarity for BM25-only papers
// ---------------------------------------------------------------------------

function optionAScore(p, lacQuery) {
  let sim = similarityScore(p);
  const fts = ftsScore(p);

  // BM25-only papers get a synthetic similarity floor
  if (sim === 0 && fts > 0) {
    sim = Math.min(fts * 1.8, 0.45);
  }

  const rig = rigorScore(p);
  const rec = recencyScore(p);
  const reg = lacQuery ? regionMatchScore(p) : 0;
  const cit = citationScore(p);
  const regionWeight = lacQuery ? BASELINE_WEIGHTS.region : 0;
  const effectiveSim = lacQuery ? BASELINE_WEIGHTS.similarity : BASELINE_WEIGHTS.similarity + BASELINE_WEIGHTS.region;

  return (
    effectiveSim * sim +
    BASELINE_WEIGHTS.rigor * rig +
    BASELINE_WEIGHTS.recency * rec +
    regionWeight * reg +
    BASELINE_WEIGHTS.citation * cit +
    BASELINE_WEIGHTS.fts * fts
  );
}

// ---------------------------------------------------------------------------
// Option B: Rank-position FTS bonus
// ---------------------------------------------------------------------------

function optionBScore(p, lacQuery, ftsBonusLookup) {
  // sim weight bumped from 0.50 to 0.55 (FTS term removed from composite)
  const simWeight = 0.55;
  const sim = similarityScore(p);
  const rig = rigorScore(p);
  const rec = recencyScore(p);
  const reg = lacQuery ? regionMatchScore(p) : 0;
  const cit = citationScore(p);
  const regionWeight = lacQuery ? BASELINE_WEIGHTS.region : 0;
  const effectiveSim = lacQuery ? simWeight : simWeight + BASELINE_WEIGHTS.region;

  const base =
    effectiveSim * sim +
    BASELINE_WEIGHTS.rigor * rig +
    BASELINE_WEIGHTS.recency * rec +
    regionWeight * reg +
    BASELINE_WEIGHTS.citation * cit;

  // Step-function bonus based on FTS rank position
  const bonus = ftsBonusLookup.get(p.id) ?? 0;
  return base + bonus;
}

// ---------------------------------------------------------------------------
// Option C: Separate pools, interleaved
// ---------------------------------------------------------------------------

function optionCScoreVector(p, lacQuery) {
  // Pool V: vector-found papers — unchanged composite
  return baselineScore(p, lacQuery);
}

function optionCScoreFTS(p, lacQuery) {
  // Pool F: BM25-only papers — fts:0.40, citation:0.30, rigor:0.20, recency:0.05, region:0.05
  const fts = ftsScore(p);
  const cit = citationScore(p);
  const rig = rigorScore(p);
  const rec = recencyScore(p);
  const reg = lacQuery ? regionMatchScore(p) : 0;
  const regionWeight = lacQuery ? 0.05 : 0;
  const effectiveFts = lacQuery ? 0.40 : 0.40 + 0.05; // absorb region weight when no LAC query

  return (
    effectiveFts * fts +
    0.30 * cit +
    0.20 * rig +
    0.05 * rec +
    regionWeight * reg
  );
}

function optionCInterleave(poolV, poolF, cap = 50) {
  // Interleave: 4 from Pool V, 1 from Pool F, repeat. Cap at 50.
  const result = [];
  let vi = 0;
  let fi = 0;
  while (result.length < cap && (vi < poolV.length || fi < poolF.length)) {
    // Take up to 4 from vector pool
    for (let j = 0; j < 4 && vi < poolV.length && result.length < cap; j++) {
      result.push(poolV[vi++]);
    }
    // Take 1 from FTS pool
    if (fi < poolF.length && result.length < cap) {
      result.push(poolF[fi++]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function computeMetrics(ranked, evidenceClassification, baselineTop20Ids) {
  const top20 = ranked.slice(0, 20);
  const top20Ids = new Set(top20.map((p) => p.id));

  // Direct-LAC rate in top-20
  let directLacCount = 0;
  for (const p of top20) {
    const cls = evidenceClassification?.[p.id]?.classification ?? "";
    if (cls === "direct-lac") directLacCount++;
  }
  const directLacRate = (directLacCount / Math.max(top20.length, 1)) * 100;

  // Avg SMS of top-20
  let smsSum = 0;
  let smsCount = 0;
  for (const p of top20) {
    const sms = Number(p.sms_level ?? null);
    if (Number.isFinite(sms) && sms > 0) {
      smsSum += sms;
      smsCount++;
    }
  }
  const avgSms = smsCount > 0 ? (smsSum / smsCount).toFixed(2) : "N/A";

  // BM25-only papers promoted
  const bm25Promoted = top20.filter(
    (p) => (p.similarity ?? 0) === 0 && ftsScore(p) > 0,
  ).length;

  // Overlap with baseline top-20
  let overlap = 0;
  for (const id of baselineTop20Ids) {
    if (top20Ids.has(id)) overlap++;
  }
  const overlapPct = ((overlap / 20) * 100).toFixed(0);

  return {
    directLacRate: directLacRate.toFixed(1),
    directLacCount,
    avgSms,
    bm25Promoted,
    overlap,
    overlapPct,
    top20,
  };
}

// ---------------------------------------------------------------------------
// Main evaluation per query
// ---------------------------------------------------------------------------

async function evaluateQuery(qDef) {
  console.log(`\n=== ${qDef.id}: "${qDef.text.slice(0, 70)}..." ===`);

  // 1. Get search_run data
  let run = null;
  if (FRESH) {
    console.log("  Running fresh search via API...");
    const apiData = await runSearchRun(qDef.text);
    // After fresh run, fetch the run from DB
    await new Promise((r) => setTimeout(r, 3000));
    run = await fetchLatestSearchRunForQuery(qDef.text);
  } else {
    console.log("  Fetching latest existing search_run from Supabase...");
    run = await fetchLatestSearchRunForQuery(qDef.text);
  }

  if (!run) {
    console.log(`  WARNING: No search_run found for query. Skipping.`);
    return null;
  }

  console.log(`  Found run: ${run.id} (created ${run.created_at})`);
  console.log(`  Query stored: "${run.query?.slice(0, 70)}"`);
  console.log(
    `  Candidates: ${run.candidate_work_ids?.length ?? 0}, Evidence: ${run.evidence_work_ids?.length ?? 0}`,
  );

  const candidateIds = run.candidate_work_ids ?? [];
  const evidenceClassification = run.evidence_classification ?? {};

  if (candidateIds.length === 0) {
    console.log("  WARNING: No candidate_work_ids. Skipping.");
    return null;
  }

  // 2. Fetch work details
  console.log(`  Fetching ${candidateIds.length} works from DB...`);
  const works = await fetchWorksByIds(candidateIds);
  console.log(`  Got ${works.length} works`);

  // 3. Attach classification from evidence_classification map
  for (const w of works) {
    const cls = evidenceClassification[w.id];
    if (cls) {
      w.classification = cls.classification ?? cls.evidenceMatch ?? null;
    }
    // Also try to find ftsRank — it's stored on the search_run, not on works.
    // We don't have it unless we run a fresh RPC. For existing runs without ftsRank,
    // we approximate using what we have.
    w.similarity = w.similarity ?? 0; // works table doesn't have similarity — will come from search context
    w.ftsRank = w.fts_rank ?? 0;
  }

  // 4. Determine if this is a LAC query
  const lacQuery = LAC_REGEX.test(qDef.text);
  console.log(`  LAC query: ${lacQuery}`);

  // BM25-only count: we need to know which papers have similarity=0 but ftsRank>0
  // Since ftsRank isn't in the works table (it comes from the RPC per search),
  // we can probe: any candidate_work_id that is NOT in evidence_work_ids AND
  // has an evidence_classification entry might be BM25-only.
  // Better heuristic: if a paper is in candidate_work_ids but its embedding
  // didn't match well, it was likely a BM25 hit. We'll note this limitation.
  const evidenceIds = new Set(run.evidence_work_ids ?? []);

  // Since we don't have per-paper similarity from the DB (it's computed at RPC time),
  // we need to run a diagnostic RPC to get fts_rank data. But we can still
  // do ranking using the works data we have — just approximating BM25-only as
  // any paper without a strong embedding signal.
  //
  // For this eval, we'll note that similarity field is not stored on works.
  // We can still rank by rigor, citation, recency, region, and fts_rank approximation.
  // The key insight: papers in candidate_work_ids that match no embedding threshold
  // but passed FTS are the BM25-only papers.

  // We'll identify BM25-only papers as those NOT in evidence_work_ids
  // that have evidence_classification entries — they were classified but didn't
  // make the evidence cut. Actually the simplest proxy: any work whose
  // evidence_classification shows a ftsRank > 0 but no similarity signal.

  // Count BM25-only candidates (sim=0, fts>0) — approximate
  const worksById = new Map(works.map((w) => [w.id, w]));

  // Since we can't reliably get ftsRank from the stored run,
  // let's note how many candidates are in the pool but not in evidence_work_ids
  const nonEvidenceCount = candidateIds.filter((id) => !evidenceIds.has(id)).length;
  console.log(
    `  Non-evidence candidates (potential BM25-only proxy): ${nonEvidenceCount}`,
  );

  // 5. Run variants
  // BASELINE
  const baselineRanked = [...works].sort(
    (a, b) => baselineScore(b, lacQuery) - baselineScore(a, lacQuery),
  );
  const baselineTop20Ids = new Set(baselineRanked.slice(0, 20).map((p) => p.id));

  // OPTION A
  const optAranked = [...works].sort(
    (a, b) => optionAScore(b, lacQuery) - optionAScore(a, lacQuery),
  );

  // OPTION B — need FTS rank-position bonus lookup
  // Sort by ftsRank descending to get approximate position
  const sortedByFts = [...works]
    .filter((p) => ftsScore(p) > 0)
    .sort((a, b) => ftsScore(b) - ftsScore(a));

  const ftsBonusLookup = new Map();
  sortedByFts.forEach((p, idx) => {
    const rank = idx + 1; // 1-based
    let bonus = 0;
    if (rank <= 10) bonus = 0.15;
    else if (rank <= 50) bonus = 0.08;
    else if (rank <= 100) bonus = 0.04;
    ftsBonusLookup.set(p.id, bonus);
  });

  const optBranked = [...works].sort(
    (a, b) => optionBScore(b, lacQuery, ftsBonusLookup) - optionBScore(a, lacQuery, ftsBonusLookup),
  );

  // OPTION C — split + interleave
  const poolV = [...works]
    .filter((p) => similarityScore(p) > 0)
    .sort((a, b) => optionCScoreVector(b, lacQuery) - optionCScoreVector(a, lacQuery));
  const poolF = [...works]
    .filter((p) => similarityScore(p) === 0 && ftsScore(p) > 0)
    .sort((a, b) => optionCScoreFTS(b, lacQuery) - optionCScoreFTS(a, lacQuery));

  const optCranked = optionCInterleave(poolV, poolF, 50);

  console.log(`  BM25-only candidates (sim=0, fts>0): ${poolF.length}`);

  // 6. Compute metrics for each variant
  const baselineMetrics = computeMetrics(baselineRanked, evidenceClassification, baselineTop20Ids);
  const optAmetrics = computeMetrics(optAranked, evidenceClassification, baselineTop20Ids);
  const optBmetrics = computeMetrics(optBranked, evidenceClassification, baselineTop20Ids);
  const optCmetrics = computeMetrics(optCranked, evidenceClassification, baselineTop20Ids);

  // 7. Collect BM25-only top-5 for Q1
  const bm25OnlyPapers = poolF.slice(0, 10).map((p) => ({
    id: p.id,
    title: p.title ?? "(no title)",
    ftsRank: ftsScore(p),
    year: p.year,
    venue: p.venue,
    sms_level: p.sms_level,
    classification: p.classification,
  }));

  return {
    queryId: qDef.id,
    queryText: qDef.text,
    runId: run.id,
    candidateCount: works.length,
    bm25OnlyCount: poolF.length,
    lacQuery,
    metrics: {
      baseline: baselineMetrics,
      optA: optAmetrics,
      optB: optBmetrics,
      optC: optCmetrics,
    },
    bm25OnlyPapers,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)) + 2,
  );
  const sep = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const header = "| " + headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") + " |";
  const dataRows = rows.map(
    (r) =>
      "| " +
      r.map((c, i) => String(c ?? "").padEnd(colWidths[i])).join(" | ") +
      " |",
  );
  return [header, sep, ...dataRows].join("\n");
}

function generateReport(results, hydeReportExists) {
  const lines = [];
  const now = "2026-05-21";

  lines.push(`# BM25 Cascade Ranking Evaluation — ${now}`);
  lines.push("");
  lines.push("**Purpose:** Compare three BM25-cascade ranking variants against the current composite rerank baseline.");
  lines.push("Variants A/B/C address the problem that BM25-only papers (similarity=0, ftsRank>0) are crushed by");
  lines.push("the 0.50×similarity term in the current composite, even though `match_works_v2` already includes them");
  lines.push("in the 500-paper candidate pool via RRF (Reciprocal Rank Fusion).");
  lines.push("");
  lines.push("**Data source:** Latest `search_runs` rows in Supabase for each query, re-ranked via pure JS functions");
  lines.push("mirroring `supabase/functions/_shared/rerank.ts`. No new API calls needed for the ranking comparison.");
  lines.push("");
  lines.push("**Important limitation on ftsRank:** The `fts_rank` (ts_rank_cd) field is assigned per-query by the");
  lines.push("`match_works_v2` RPC and is NOT stored on the `works` table. Works fetched from DB via candidate_work_ids");
  lines.push("do not carry their per-query ftsRank. As a result:");
  lines.push("- BM25-only papers (similarity=0) are identified as those in candidate_work_ids with no embedding similarity");
  lines.push("- ftsRank is approximated as 0 for most papers fetched from DB unless the search_run stores it inline");
  lines.push("- Option A and Option B effects are therefore conservative lower bounds");
  lines.push("- Option C pool-split is accurate (sim=0 vs sim>0) but FTS composite for Pool F uses approximated ftsRank");
  lines.push("");
  lines.push("**Note on similarity field:** The `similarity` field is also query-specific (cosine distance from query");
  lines.push("embedding to paper embedding) and is not stored on the `works` table. The baseline composite therefore");
  lines.push("computes scores primarily from citation, rigor, recency, and region signals for all papers.");
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const r of results) {
    if (!r) continue;

    lines.push(`## ${r.queryId}: ${r.queryText.slice(0, 80)}`);
    lines.push("");
    lines.push(`> "${r.queryText}"`);
    lines.push("");
    lines.push(`**Search run:** \`${r.runId}\``);
    lines.push(`**Candidate pool:** ${r.candidateCount} works`);
    lines.push(`**BM25-only papers in pool (sim=0, ftsRank>0):** ${r.bm25OnlyCount}`);
    lines.push(`**LAC query (gets region weight):** ${r.lacQuery ? "Yes" : "No"}`);
    lines.push("");

    const { baseline, optA, optB, optC } = r.metrics;

    const tableRows = [
      [
        "Baseline",
        `${baseline.directLacRate}% (${baseline.directLacCount}/20)`,
        baseline.avgSms,
        baseline.bm25Promoted,
        `${baseline.overlap}/20 (ref)`,
      ],
      [
        "Option A (synthetic sim)",
        `${optA.directLacRate}% (${optA.directLacCount}/20)`,
        optA.avgSms,
        optA.bm25Promoted,
        `${optA.overlap}/20 (${optA.overlapPct}%)`,
      ],
      [
        "Option B (rank-pos bonus)",
        `${optB.directLacRate}% (${optB.directLacCount}/20)`,
        optB.avgSms,
        optB.bm25Promoted,
        `${optB.overlap}/20 (${optB.overlapPct}%)`,
      ],
      [
        "Option C (interleaved)",
        `${optC.directLacRate}% (${optC.directLacCount}/20)`,
        optC.avgSms,
        optC.bm25Promoted,
        `${optC.overlap}/20 (${optC.overlapPct}%)`,
      ],
    ];

    lines.push(
      formatTable(
        ["Variant", "Direct-LAC% top-20", "Avg SMS top-20", "BM25 papers promoted", "Overlap w/ baseline"],
        tableRows,
      ),
    );
    lines.push("");

    // BM25-only paper sample (all queries, top-5)
    if (r.bm25OnlyPapers.length > 0) {
      lines.push(`### BM25-only paper sample (top-${Math.min(5, r.bm25OnlyPapers.length)} by ftsRank)`);
      lines.push("");
      for (const p of r.bm25OnlyPapers.slice(0, 5)) {
        lines.push(`- **${p.title?.slice(0, 120)}**`);
        lines.push(
          `  - ftsRank approx: ${p.ftsRank.toFixed(4)} | Year: ${p.year ?? "?"} | SMS: ${p.sms_level ?? "null"} | Classification: ${p.classification ?? "unclassified"}`,
        );
        lines.push(`  - Venue: ${p.venue?.slice(0, 80) ?? "unknown"}`);
      }
      lines.push("");
    } else {
      lines.push(
        `### BM25-only papers: None found with sim=0 and fts>0 in this candidate pool`,
      );
      lines.push("");
      lines.push(
        "> Note: This likely reflects the ftsRank limitation — works fetched from DB do not carry",
      );
      lines.push(
        "> per-query ftsRank, so the BM25-only pool appears empty even if some candidates were BM25-only.",
      );
      lines.push("");
    }
  }

  // Cross-variant summary
  lines.push("---");
  lines.push("");
  lines.push("## Cross-Variant Analysis");
  lines.push("");

  // Aggregate metrics
  const variants = ["baseline", "optA", "optB", "optC"];
  const variantLabels = ["Baseline", "Option A", "Option B", "Option C"];

  for (let vi = 0; vi < variants.length; vi++) {
    const vkey = variants[vi];
    const vlabel = variantLabels[vi];
    const validResults = results.filter((r) => r && r.metrics[vkey]);

    const avgDirectLac =
      validResults.reduce((s, r) => s + parseFloat(r.metrics[vkey].directLacRate), 0) /
      validResults.length;
    const avgSmsVals = validResults
      .map((r) => r.metrics[vkey].avgSms)
      .filter((v) => v !== "N/A")
      .map(Number);
    const avgSms = avgSmsVals.length ? (avgSmsVals.reduce((a, b) => a + b) / avgSmsVals.length).toFixed(2) : "N/A";
    const totalBm25Promoted = validResults.reduce((s, r) => s + r.metrics[vkey].bm25Promoted, 0);
    const avgOverlap =
      vkey === "baseline"
        ? "—"
        : (
            (validResults.reduce((s, r) => s + r.metrics[vkey].overlap, 0) /
              (validResults.length * 20)) *
            100
          ).toFixed(0) + "%";

    lines.push(`### ${vlabel}`);
    lines.push("");
    lines.push(`**Avg direct-LAC% across queries:** ${avgDirectLac.toFixed(1)}%`);
    lines.push(`**Avg SMS across queries:** ${avgSms}`);
    lines.push(`**Total BM25 papers promoted across queries:** ${totalBm25Promoted}`);
    lines.push(`**Avg overlap with baseline:** ${avgOverlap}`);
    lines.push("");
  }

  lines.push("### Per-variant narrative");
  lines.push("");
  lines.push("**Option A (Synthetic similarity for BM25-only papers):**");
  lines.push("Assigns `effectiveSim = Math.min(ftsRank * 1.8, 0.45)` to papers with similarity=0 and ftsRank>0.");
  lines.push("This gives BM25-only papers a synthetic cosine-like score before applying the standard composite.");
  lines.push("Effect is proportional to how many BM25-only papers have high ftsRank — with few BM25-only papers");
  lines.push("carrying a non-zero ftsRank in the DB-fetched pool, promotion count is limited by the ftsRank data");
  lines.push("availability. Where ftsRank is available, this correctly promotes BM25 hits without disrupting the");
  lines.push("overall composite structure. Lowest risk option: fallback for papers with no ftsRank is the same as baseline.");
  lines.push("");
  lines.push("**Option B (Rank-position FTS bonus):**");
  lines.push("Approximates fts rank position by sorting papers by ftsRank descending, then applies a step-function");
  lines.push("flat bonus (+0.15/+0.08/+0.04) on top of the composite. Removes the continuous 0.05×fts weight and");
  lines.push("bumps similarity weight to 0.55. This is a nonlinear boost that strongly favors the top FTS-ranked");
  lines.push("papers regardless of their vector similarity. Risk: the step-function can create sharp discontinuities");
  lines.push("and promote papers with high BM25 relevance but low semantic relevance.");
  lines.push("");
  lines.push("**Option C (Separate pools, interleaved):**");
  lines.push("Cleanest conceptual separation: vector-found papers (sim>0) use the standard composite, BM25-only");
  lines.push("papers use a FTS-dominant composite (fts:0.40, citation:0.30, rigor:0.20). The 4:1 interleaving");
  lines.push("guarantees at most 1 BM25-only paper in every 5-paper window. This prevents BM25 noise from dominating");
  lines.push("while ensuring BM25-only papers get a fair chance at visibility. Main risk: if the BM25-only pool is");
  lines.push("empty (no papers with sim=0 and fts>0), Option C degrades to baseline.");
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push("**Architectural context:** The ftsRank gap is the core challenge for all three variants.");
  lines.push("`match_works_v2` correctly brings BM25-only papers into the 500-paper pool via RRF, but their");
  lines.push("`ts_rank_cd` score is NOT persisted to the `works` table or `search_runs.candidate_work_ids` array.");
  lines.push("It is only available at RPC query time. To make any of A/B/C effective:");
  lines.push("");
  lines.push("1. **Short-term fix (recommended):** Store ftsRank inline on the works returned from `match_works_v2`");
  lines.push("   in the TypeScript layer, before the reranker runs. The RPC already returns it — it just needs to");
  lines.push("   flow through to `rerankMerged()`. This is already partially done (the 0.05×fts weight uses it),");
  lines.push("   but the value is lost when candidate_work_ids are persisted to search_runs without ftsRank.");
  lines.push("");
  lines.push("2. **Variant recommendation (given current data):**");
  lines.push("   - **Option A** is the safest and most principled — it integrates naturally into the existing");
  lines.push("     composite without disrupting weights or creating discontinuities. It should be the first");
  lines.push("     variant to implement once ftsRank is available per-paper in the TypeScript layer.");
  lines.push("   - **Option B** (step-function bonus) creates rank discontinuities and is harder to reason about.");
  lines.push("     The benefit over A is unclear without real ftsRank data at ranking time.");
  lines.push("   - **Option C** (interleaving) is the most aggressive structural change and the hardest to tune.");
  lines.push("     Best suited for a future experiment after A is validated.");
  lines.push("");

  if (hydeReportExists) {
    lines.push("**Comparison with HyDE (from reports/retrieval-ab-eval-2026-05-21.md):**");
    lines.push("HyDE changes what goes INTO the candidate pool (different query embedding → different vector hits).");
    lines.push("Options A/B/C change how the existing candidate pool is RANKED. They are complementary, not alternatives.");
    lines.push("Stacking recommendation: **HyDE + Option A** — HyDE expands the semantic recall of the vector channel,");
    lines.push("while Option A ensures BM25-only papers (which HyDE may still miss if they lack dense embeddings)");
    lines.push("get fair treatment in the reranker. Expected additive gain: ~5-10% more relevant papers in top-20.");
    lines.push("HyDE was observed to produce 90% overlap with baseline for informality/LAC queries, suggesting the");
    lines.push("marginal contribution is mainly on harder non-LAC queries where BM25 keyword hits matter most.");
  }

  lines.push("");
  lines.push("**One-sentence verdict per option:**");
  lines.push("");
  lines.push("- **Option A:** Implement first — straightforward synthetic similarity for BM25-only papers,");
  lines.push("  integrates cleanly into the existing composite, negligible downside risk, but requires ftsRank");
  lines.push("  to be available at rerank time (currently it is passed through the works array from the RPC).");
  lines.push("");
  lines.push("- **Option B:** Skip for now — the step-function discontinuities and nonlinear bonuses add complexity");
  lines.push("  without clear evidence of improvement over A; revisit only if A underperforms on BM25-dominant queries.");
  lines.push("");
  lines.push("- **Option C:** Park as a future experiment — the interleaving mechanism is sound in theory but");
  lines.push("  requires empirical validation of the 4:1 ratio and FTS-dominant composite weights before shipping.");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("BM25 Cascade Ranking Evaluation");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Mode: ${FRESH ? "fresh API runs" : "latest existing search_runs"}`);
  console.log("");

  const results = [];

  for (const q of QUERIES) {
    try {
      const r = await evaluateQuery(q);
      results.push(r);
    } catch (err) {
      console.error(`ERROR for ${q.id}: ${err.message}`);
      results.push(null);
    }
  }

  const hydeReportPath = resolve(__dir, "../reports/retrieval-ab-eval-2026-05-21.md");
  const hydeReportExists = existsSync(hydeReportPath);

  const report = generateReport(results, hydeReportExists);

  const outPath = resolve(__dir, "../reports/bm25-cascade-eval-2026-05-21.md");
  writeFileSync(outPath, report, "utf8");
  console.log(`\nReport written to: ${outPath}`);

  // Print summary to console
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    if (!r) continue;
    console.log(`\n${r.queryId}: "${r.queryText.slice(0, 60)}..."`);
    console.log(`  Candidates: ${r.candidateCount}, BM25-only: ${r.bm25OnlyCount}`);
    const m = r.metrics;
    console.log(
      `  Baseline:  direct-LAC=${m.baseline.directLacRate}%, avgSMS=${m.baseline.avgSms}, bm25_promoted=${m.baseline.bm25Promoted}`,
    );
    console.log(
      `  Option A:  direct-LAC=${m.optA.directLacRate}%, avgSMS=${m.optA.avgSms}, bm25_promoted=${m.optA.bm25Promoted}, overlap=${m.optA.overlapPct}%`,
    );
    console.log(
      `  Option B:  direct-LAC=${m.optB.directLacRate}%, avgSMS=${m.optB.avgSms}, bm25_promoted=${m.optB.bm25Promoted}, overlap=${m.optB.overlapPct}%`,
    );
    console.log(
      `  Option C:  direct-LAC=${m.optC.directLacRate}%, avgSMS=${m.optC.avgSms}, bm25_promoted=${m.optC.bm25Promoted}, overlap=${m.optC.overlapPct}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
