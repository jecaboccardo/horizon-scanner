/**
 * scripts/hyde-plus-a-eval.mjs
 *
 * HyDE + Option A comparison (build v84).
 *
 * Variants:
 *   "A-only"   : { hyde: false }  — Option A baked in, HyDE disabled
 *   "HyDE+A"   : {}               — Option A baked in, HyDE on (new default)
 *
 * Queries (same 3 used in prior evals):
 *   1. AI/automation + labor markets
 *   2. Climate change + labor markets in developing countries
 *   3. Social protection + poverty/inequality in LAC
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://v0-horizon-scanner-iadb.vercel.app";
const TENANT_ID = "iadb-demo";

const tokenPath = path.resolve(ROOT, ".eval-token.txt");
if (!fs.existsSync(tokenPath)) {
  console.error("ERROR: .eval-token.txt not found.");
  process.exit(1);
}
const USER_JWT = fs.readFileSync(tokenPath, "utf8").trim();

const QUERIES = [
  "How does automation and artificial intelligence affect labor markets and wages?",
  "What are the effects of climate change on labor markets and employment in developing countries?",
  "How do social protection programs affect poverty and inequality in Latin America?",
];

const VARIANTS = [
  { name: "A-only",  body: { hyde: false } },
  { name: "HyDE+A",  body: {} },
];

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function runSearchRun(query, bodyOverrides) {
  const t0 = Date.now();
  const response = await fetch(`${API_BASE}/api/search-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": TENANT_ID,
      "Authorization": `Bearer ${USER_JWT}`,
    },
    body: JSON.stringify({
      query,
      filters: {},
      ...bodyOverrides,
    }),
  });
  const latencyMs = Date.now() - t0;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return { data, latencyMs };
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function getDirectLacRate(works, topN = 20) {
  const top = works.slice(0, topN);
  if (top.length === 0) return { rate: "0.0", count: 0, total: 0 };
  const directLac = top.filter(w => {
    const cls = w.classification || w.directIndirectClass || w.evidenceClassification;
    return cls === "direct-lac" || cls === "direct";
  }).length;
  return {
    rate: ((directLac / top.length) * 100).toFixed(1),
    count: directLac,
    total: top.length,
  };
}

function getTop20Ids(works) {
  return works.slice(0, 20).map(w => w.workId || w.id || w.doi || w.paperId);
}

function computeOverlap(idsA, idsB) {
  const setA = new Set(idsA);
  const common = idsB.filter(id => setA.has(id));
  return {
    count: common.length,
    pct: ((common.length / 20) * 100).toFixed(1),
  };
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function runEval() {
  console.log("=== HyDE + Option A Comparison (build v84) ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Queries: ${QUERIES.length}, Variants: ${VARIANTS.length}`);
  console.log("");

  const results = [];

  for (let qi = 0; qi < QUERIES.length; qi++) {
    const query = QUERIES[qi];
    console.log(`\n--- Query ${qi + 1}: "${query.slice(0, 70)}..." ---`);

    const queryResults = { query, variants: [] };

    for (const variant of VARIANTS) {
      console.log(`  Running variant: ${variant.name}...`);
      try {
        const { data, latencyMs } = await runSearchRun(query, variant.body);

        // Extract works — handle both response shapes
        const works = data.works || data.searchRun?.works || [];
        const evidenceWorkIds = data.evidenceWorkIds || data.searchRun?.evidenceWorkIds || [];
        const coverage = data.coverage || data.searchRun?.coverage || {};

        console.log(`    Latency: ${latencyMs}ms | Works: ${works.length} | evidenceWorkIds: ${evidenceWorkIds.length}`);
        console.log(`    Coverage:`, JSON.stringify(coverage));

        // Sort by composite score (they should already be ranked, but be safe)
        const orderedWorks = [...works].sort((a, b) => {
          const sa = a.compositeScore ?? a.score ?? a.similarity ?? 0;
          const sb = b.compositeScore ?? b.score ?? b.similarity ?? 0;
          return sb - sa;
        });

        const lacInfo = getDirectLacRate(orderedWorks, 20);
        const top20Ids = getTop20Ids(orderedWorks);

        // Collect top-20 details
        const top20 = orderedWorks.slice(0, 20).map((w, i) => ({
          rank: i + 1,
          workId: w.workId || w.id || w.doi,
          title: (w.title || "(no title)").slice(0, 100),
          compositeScore: w.compositeScore ?? w.score ?? null,
          similarity: w.similarity ?? null,
          classification: w.classification || w.directIndirectClass || w.evidenceClassification || null,
          smsLevel: w.smsLevel ?? w.methodology?.smsLevel ?? null,
        }));

        queryResults.variants.push({
          variantName: variant.name,
          latencyMs,
          coverage,
          lacInfo,
          top20Ids,
          top20,
          worksCount: works.length,
          evidenceWorkIdsCount: evidenceWorkIds.length,
        });

      } catch (err) {
        console.error(`    ERROR for ${variant.name}: ${err.message}`);
        queryResults.variants.push({
          variantName: variant.name,
          error: err.message,
          latencyMs: null,
        });
      }

      // Pause between requests
      await new Promise(r => setTimeout(r, 3000));
    }

    results.push(queryResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(results) {
  const lines = [];
  const now = "2026-05-21";

  lines.push(`# HyDE + Option A Retrieval Comparison — ${now}`);
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push("**Build**: v84 (HyDE default-on; BM25-only papers get `min(ftsRank × 1.8, 0.45)` instead of 0)");
  lines.push("");
  lines.push("**Variants tested:**");
  lines.push("- **A-only** (`{ hyde: false }`): Option A baked in, HyDE disabled. This is the cleaner baseline.");
  lines.push("- **HyDE+A** (no overrides): Option A baked in, HyDE enabled. This is the new production default.");
  lines.push("");
  lines.push("**Queries:**");
  lines.push("1. How does automation and artificial intelligence affect labor markets and wages?");
  lines.push("2. What are the effects of climate change on labor markets and employment in developing countries?");
  lines.push("3. How do social protection programs affect poverty and inequality in Latin America?");
  lines.push("");
  lines.push("**Metrics:**");
  lines.push("- Wall-clock latency (ms)");
  lines.push("- admissibleCount (from `coverage` in response)");
  lines.push("- direct-LAC% in top-20 (from `classification` or `evidenceClassification` field)");
  lines.push("- Top-20 paper IDs");
  lines.push("- Overlap between the two variants' top-20");
  lines.push("");
  lines.push("---");
  lines.push("");

  const queryShortNames = [
    "AI/Automation → Labor Markets",
    "Climate Change → Labor in Developing Countries",
    "Social Protection → Poverty/Inequality in LAC",
  ];

  const allAOnly = [];
  const allHyde = [];

  for (let qi = 0; qi < results.length; qi++) {
    const { query, variants } = results[qi];
    const aOnly = variants.find(v => v.variantName === "A-only");
    const hydeA = variants.find(v => v.variantName === "HyDE+A");

    lines.push(`## Query ${qi + 1}: ${queryShortNames[qi]}`);
    lines.push("");
    lines.push(`> "${query}"`);
    lines.push("");

    // Compute overlap
    let overlapCount = "N/A";
    let overlapPct = "N/A";
    if (aOnly && !aOnly.error && hydeA && !hydeA.error) {
      const ov = computeOverlap(aOnly.top20Ids, hydeA.top20Ids);
      overlapCount = ov.count;
      overlapPct = ov.pct + "%";
    }

    // Summary table
    lines.push("| Variant | Latency (ms) | admissibleCount | Direct-LAC% top-20 | Overlap |");
    lines.push("|---------|-------------|-----------------|---------------------|---------|");

    for (const v of [aOnly, hydeA]) {
      if (!v) continue;
      if (v.error) {
        lines.push(`| ${v.variantName} | ERROR | ERROR | ERROR | ERROR |`);
        continue;
      }
      const admissible = v.coverage?.admissibleCount ?? "N/A";
      const lacPct = v.lacInfo ? `${v.lacInfo.rate}% (${v.lacInfo.count}/${v.lacInfo.total})` : "N/A";
      const ov = v.variantName === "A-only" ? "— (reference)" : `${overlapCount}/20 (${overlapPct})`;
      lines.push(`| ${v.variantName} | ${v.latencyMs?.toLocaleString() ?? "N/A"} | ${admissible} | ${lacPct} | ${ov} |`);
    }
    lines.push("");

    // Top-20 details for each variant
    for (const v of [aOnly, hydeA]) {
      if (!v || v.error) continue;
      lines.push(`### ${v.variantName} — top-20 papers`);
      lines.push("");
      lines.push("| Rank | workId | Title | Score | Sim | SMS | Class |");
      lines.push("|------|--------|-------|-------|-----|-----|-------|");
      for (const p of (v.top20 || [])) {
        const score = p.compositeScore !== null ? p.compositeScore.toFixed(3) : "N/A";
        const sim = p.similarity !== null ? p.similarity.toFixed(3) : "N/A";
        const title = (p.title || "").slice(0, 60);
        lines.push(`| ${p.rank} | \`${p.workId || "?"}\` | ${title} | ${score} | ${sim} | ${p.smsLevel ?? "?"} | ${p.classification || "?"} |`);
      }
      lines.push("");
    }

    // ID diff: new entrants and dropouts
    if (aOnly && !aOnly.error && hydeA && !hydeA.error) {
      const aSet = new Set(aOnly.top20Ids);
      const hSet = new Set(hydeA.top20Ids);
      const newEntrants = hydeA.top20Ids.filter(id => !aSet.has(id));
      const dropouts = aOnly.top20Ids.filter(id => !hSet.has(id));

      lines.push("### ID-level diff (HyDE+A vs A-only)");
      lines.push("");
      lines.push(`**New entrants in HyDE+A** (${newEntrants.length} papers not in A-only top-20):`);
      if (newEntrants.length === 0) {
        lines.push("_None — complete overlap._");
      } else {
        const hydeMap = {};
        for (const p of (hydeA.top20 || [])) hydeMap[p.workId] = p;
        for (const id of newEntrants) {
          const p = hydeMap[id];
          lines.push(`- \`${id}\` rank ${p?.rank ?? "?"}: ${(p?.title || "").slice(0, 80)} (class: ${p?.classification || "?"})`);
        }
      }
      lines.push("");
      lines.push(`**Dropped from A-only in HyDE+A** (${dropouts.length} papers):`);
      if (dropouts.length === 0) {
        lines.push("_None._");
      } else {
        const aMap = {};
        for (const p of (aOnly.top20 || [])) aMap[p.workId] = p;
        for (const id of dropouts) {
          const p = aMap[id];
          lines.push(`- \`${id}\` rank ${p?.rank ?? "?"}: ${(p?.title || "").slice(0, 80)} (class: ${p?.classification || "?"})`);
        }
      }
      lines.push("");

      if (aOnly && !aOnly.error) allAOnly.push({ q: qi + 1, v: aOnly });
      if (hydeA && !hydeA.error) allHyde.push({ q: qi + 1, v: hydeA });
    }

    lines.push("---");
    lines.push("");
  }

  // ---------------------------------------------------------------------------
  // Cross-query aggregate summary
  // ---------------------------------------------------------------------------
  lines.push("## Aggregate Summary Across All 3 Queries");
  lines.push("");

  const aLatencies = allAOnly.map(x => x.v.latencyMs).filter(Boolean);
  const hLatencies = allHyde.map(x => x.v.latencyMs).filter(Boolean);
  const aLacs = allAOnly.map(x => parseFloat(x.v.lacInfo?.rate || 0));
  const hLacs = allHyde.map(x => parseFloat(x.v.lacInfo?.rate || 0));
  const aAdmissible = allAOnly.map(x => x.v.coverage?.admissibleCount).filter(v => v != null);
  const hAdmissible = allHyde.map(x => x.v.coverage?.admissibleCount).filter(v => v != null);

  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const fmt = (v, decimals = 0) => v != null ? v.toFixed(decimals) : "N/A";

  const avgALat = avg(aLatencies);
  const avgHLat = avg(hLatencies);
  const avgALac = avg(aLacs);
  const avgHLac = avg(hLacs);
  const avgAAdm = avg(aAdmissible);
  const avgHAdm = avg(hAdmissible);

  lines.push("| Metric | A-only | HyDE+A | Delta |");
  lines.push("|--------|--------|--------|-------|");
  lines.push(`| Avg latency (ms) | ${fmt(avgALat)} | ${fmt(avgHLat)} | +${fmt(avgHLat != null && avgALat != null ? avgHLat - avgALat : null)} |`);
  lines.push(`| Avg admissibleCount | ${fmt(avgAAdm, 0)} | ${fmt(avgHAdm, 0)} | ${avgHAdm != null && avgAAdm != null ? (avgHAdm - avgAAdm > 0 ? "+" : "") + fmt(avgHAdm - avgAAdm, 0) : "N/A"} |`);
  lines.push(`| Avg direct-LAC% top-20 | ${fmt(avgALac, 1)}% | ${fmt(avgHLac, 1)}% | ${avgHLac != null && avgALac != null ? (avgHLac - avgALac > 0 ? "+" : "") + fmt(avgHLac - avgALac, 1) + "pp" : "N/A"} |`);
  lines.push("");

  // Per-query overlap table
  lines.push("| Query | Overlap (shared top-20 IDs) |");
  lines.push("|-------|-----------------------------|");
  for (let qi = 0; qi < results.length; qi++) {
    const { variants } = results[qi];
    const aOnly = variants.find(v => v.variantName === "A-only");
    const hydeA = variants.find(v => v.variantName === "HyDE+A");
    if (aOnly && !aOnly.error && hydeA && !hydeA.error) {
      const ov = computeOverlap(aOnly.top20Ids, hydeA.top20Ids);
      lines.push(`| Query ${qi + 1} (${queryShortNames[qi]}) | ${ov.count}/20 (${ov.pct}%) |`);
    } else {
      lines.push(`| Query ${qi + 1} | ERROR |`);
    }
  }
  lines.push("");

  // ---------------------------------------------------------------------------
  // Analysis paragraph
  // ---------------------------------------------------------------------------
  lines.push("## Analysis: Does HyDE Add Value on Top of Option A?");
  lines.push("");

  const hydeLacDelta = avgHLac != null && avgALac != null ? avgHLac - avgALac : null;
  const hydeLatDelta = avgHLat != null && avgALat != null ? avgHLat - avgALat : null;

  // Compute average overlap
  const overlaps = [];
  for (const { variants } of results) {
    const aOnly = variants.find(v => v.variantName === "A-only");
    const hydeA = variants.find(v => v.variantName === "HyDE+A");
    if (aOnly && !aOnly.error && hydeA && !hydeA.error) {
      const ov = computeOverlap(aOnly.top20Ids, hydeA.top20Ids);
      overlaps.push(parseFloat(ov.pct));
    }
  }
  const avgOverlap = avg(overlaps);

  if (hydeLacDelta !== null && hydeLatDelta !== null && avgOverlap !== null) {
    const lacImproved = hydeLacDelta > 2;
    const lacNeutral = Math.abs(hydeLacDelta) <= 2;
    const lacRegressed = hydeLacDelta < -2;
    const highOverlap = avgOverlap >= 75;
    const lowOverlap = avgOverlap < 60;

    let para = `HyDE adds an average latency of +${Math.round(hydeLatDelta)}ms over the A-only baseline. `;
    para += `The direct-LAC rate in the top-20 ${lacImproved ? `improved by +${hydeLacDelta.toFixed(1)}pp` : lacRegressed ? `regressed by ${hydeLacDelta.toFixed(1)}pp` : `was approximately neutral (${hydeLacDelta >= 0 ? "+" : ""}${hydeLacDelta.toFixed(1)}pp)`} with HyDE enabled. `;
    para += `Average admissibleCount went from ${fmt(avgAAdm, 0)} (A-only) to ${fmt(avgHAdm, 0)} (HyDE+A). `;
    para += `Top-20 overlap between variants averaged ${avgOverlap.toFixed(1)}% across the three queries, indicating `;
    if (highOverlap) {
      para += `high result stability — HyDE is not meaningfully diversifying the candidate set for these queries. `;
    } else if (lowOverlap) {
      para += `significant divergence — HyDE is retrieving a substantially different candidate set. `;
    } else {
      para += `moderate divergence — HyDE shifts the ranking meaningfully but not completely. `;
    }

    if (lacImproved && !highOverlap) {
      para += `The combination of improved LAC coverage and non-trivial rank divergence suggests HyDE is adding genuine retrieval signal beyond Option A alone.`;
    } else if (lacRegressed || (lacNeutral && highOverlap)) {
      para += `Given the high overlap and ${lacRegressed ? "regressed" : "flat"} LAC rate, HyDE's latency cost is not being offset by retrieval quality gains for these policy queries.`;
    } else {
      para += `The evidence is mixed: HyDE changes the ranking but the direct-LAC quality signal is ${lacImproved ? "modestly positive" : "flat"}, and the latency cost is real.`;
    }

    lines.push(para);
  } else {
    lines.push("Insufficient data to compute analysis — check errors above.");
  }
  lines.push("");

  // ---------------------------------------------------------------------------
  // Recommendation
  // ---------------------------------------------------------------------------
  lines.push("## Recommendation");
  lines.push("");

  if (avgOverlap !== null && hydeLacDelta !== null && hydeLatDelta !== null) {
    const hydeAddsLac = hydeLacDelta > 2;
    const hydeIsFast = hydeLatDelta < 5000;
    const hydeHighOverlap = avgOverlap >= 75;

    if (hydeAddsLac && !hydeHighOverlap) {
      lines.push("**Keep HyDE default-on.** It materially improves direct-LAC coverage in the top-20 and retrieves a non-overlapping candidate set, justifying the latency overhead. Monitor per-query latency to ensure p95 stays within acceptable bounds for interactive use.");
    } else if (!hydeAddsLac && hydeHighOverlap) {
      lines.push("**Consider reverting HyDE to opt-in (`ENABLE_HYDE=false` as default).** The top-20 sets are highly overlapping with the A-only baseline, meaning HyDE is not diversifying retrieval for these policy queries. The latency cost (+" + Math.round(hydeLatDelta) + "ms) is not offset by quality gains. Re-evaluate if new query types (e.g., highly technical JEL-specific queries) show greater divergence.");
    } else if (hydeAddsLac && hydeHighOverlap) {
      lines.push("**Keep HyDE default-on with monitoring.** Direct-LAC coverage improves modestly, but the high top-20 overlap suggests HyDE is re-ranking within the same candidate pool rather than expanding coverage. The marginal quality gain may not justify the latency at scale — revisit after collecting user satisfaction signals.");
    } else {
      lines.push("**Mixed evidence — default-on is acceptable but not clearly necessary.** HyDE shifts rankings without a clear LAC quality regression. Given that Option A already addresses the zero-similarity problem for BM25-only papers, HyDE is providing secondary reranking signal. Keep default-on for now, but set `ENABLE_HYDE=false` as an easy escape hatch if production latency p95 spikes.");
    }
  } else {
    lines.push("Insufficient data for a definitive recommendation.");
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`_Evaluation run: ${new Date().toISOString()} | Build: v84 | Model: qwen2.5:14b-synthesis | Embedding: nomic-embed-text_`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  try {
    const results = await runEval();

    // Save raw JSON
    const jsonPath = path.resolve(ROOT, "reports/hyde-plus-a-comparison-raw-2026-05-21.json");
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`\nRaw JSON saved to ${jsonPath}`);

    // Generate markdown report
    const report = generateReport(results);
    const reportPath = path.resolve(ROOT, "reports/hyde-plus-a-comparison-2026-05-21.md");
    fs.writeFileSync(reportPath, report);
    console.log(`Report saved to ${reportPath}`);

    console.log("\n=== Evaluation complete ===");
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
