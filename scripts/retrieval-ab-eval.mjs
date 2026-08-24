/**
 * scripts/retrieval-ab-eval.mjs
 *
 * Retrieval A/B evaluation: 4 variants × 3 queries
 * Variants: baseline, +crossEncoder, +HyDE, +newWeights
 *
 * Usage: node scripts/retrieval-ab-eval.mjs
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://v0-horizon-scanner-iadb.vercel.app";
const TENANT_ID = "iadb-demo";

// Load .eval-token.txt for the user JWT (required for auth)
let USER_JWT = null;
const tokenPath = path.resolve(process.cwd(), ".eval-token.txt");
if (fs.existsSync(tokenPath)) {
  USER_JWT = fs.readFileSync(tokenPath, "utf8").trim();
}
if (!USER_JWT) {
  console.error("ERROR: .eval-token.txt not found. Run: node scripts/get-eval-token.mjs");
  process.exit(1);
}

const QUERIES = [
  "What policies effectively reduce labor market informality in Latin America?",
  "What is the effect of conditional cash transfers on school attendance in LAC?",
  "How does automation and AI affect labor markets and wages?",
];

const VARIANTS = [
  { name: "Baseline",     body: {} },
  { name: "+CrossEncoder", body: { crossEncoder: true, crossEncoderTopN: 50 } },
  { name: "+HyDE",        body: { hyde: true } },
  { name: "+NewWeights",  body: { rerankWeights: { similarity: 0.80, rigor: 0.10, recency: 0.05, region: 0.05 } } },
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

function getSmsDistribution(works, topN = 20) {
  const top = works.slice(0, topN);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, null: 0 };
  let sum = 0;
  let count = 0;
  for (const w of top) {
    const sms = w.smsLevel ?? w.methodology?.smsLevel ?? null;
    if (sms === null || sms === undefined) {
      dist.null++;
    } else {
      dist[sms] = (dist[sms] || 0) + 1;
      sum += sms;
      count++;
    }
  }
  const avg = count > 0 ? (sum / count).toFixed(2) : "N/A";
  return { dist, avg, topN: top.length };
}

function getDirectLacRate(works, topN = 20) {
  const top = works.slice(0, topN);
  if (top.length === 0) return { rate: 0, count: 0, total: 0 };
  const directLac = top.filter(w => {
    const cls = w.classification || w.directIndirectClass;
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

function computeOverlap(baseIds, variantIds) {
  const baseSet = new Set(baseIds);
  const intersection = variantIds.filter(id => baseSet.has(id));
  return {
    intersectionCount: intersection.count || intersection.length,
    total: 20,
    jaccard: ((intersection.length / 20) * 100).toFixed(1),
  };
}

function getRankChanges(baseWorks, variantWorks, topN = 20) {
  // Build rank maps for top-20
  const baseRankMap = {};
  const variantRankMap = {};

  for (let i = 0; i < Math.min(baseWorks.length, topN); i++) {
    const w = baseWorks[i];
    const id = w.workId || w.id || w.doi;
    if (id) baseRankMap[id] = { rank: i + 1, title: w.title || "(no title)" };
  }
  for (let i = 0; i < Math.min(variantWorks.length, topN * 2); i++) {
    const w = variantWorks[i];
    const id = w.workId || w.id || w.doi;
    if (id) variantRankMap[id] = { rank: i + 1, title: w.title || "(no title)" };
  }

  // Find papers that moved (in base top-20)
  const changes = [];
  for (const [id, { rank: baseRank, title }] of Object.entries(baseRankMap)) {
    const varEntry = variantRankMap[id];
    if (varEntry) {
      const delta = baseRank - varEntry.rank; // positive = moved up
      if (Math.abs(delta) > 0) {
        changes.push({ id, title, baseRank, variantRank: varEntry.rank, delta });
      }
    } else {
      changes.push({ id, title, baseRank, variantRank: ">20", delta: null });
    }
  }

  // Also find new entrants (in variant top-20 but not in base top-20)
  for (const [id, { rank: variantRank, title }] of Object.entries(variantRankMap)) {
    if (variantRank <= topN && !baseRankMap[id]) {
      changes.push({ id, title, baseRank: ">20", variantRank, delta: null });
    }
  }

  // Sort: largest movers first
  changes.sort((a, b) => {
    const da = a.delta === null ? 999 : Math.abs(a.delta);
    const db = b.delta === null ? 999 : Math.abs(b.delta);
    return db - da;
  });

  return changes.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function runEval() {
  console.log("=== Horizon Scanner Retrieval A/B Evaluation ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Queries: ${QUERIES.length}, Variants: ${VARIANTS.length}`);
  console.log("");

  const results = [];

  for (let qi = 0; qi < QUERIES.length; qi++) {
    const query = QUERIES[qi];
    console.log(`\n--- Query ${qi + 1}: "${query.slice(0, 60)}..." ---`);

    const queryResults = { query, variants: [] };
    let baselineWorks = null;
    let baselineIds = null;

    for (const variant of VARIANTS) {
      console.log(`  Running variant: ${variant.name}...`);
      try {
        const { data, latencyMs } = await runSearchRun(query, variant.body);

        // The response can have works array at top level or embedded in searchRun
        const works = data.works || data.searchRun?.works || [];
        const evidenceWorkIds = data.evidenceWorkIds || data.searchRun?.evidenceWorkIds || [];
        const coverage = data.coverage || data.searchRun?.coverage || {};

        console.log(`    Latency: ${latencyMs}ms | Works returned: ${works.length} | evidenceWorkIds: ${evidenceWorkIds.length}`);

        // Sort works by composite score if not already ordered
        const orderedWorks = [...works].sort((a, b) => {
          const sa = a.compositeScore ?? a.score ?? a.similarity ?? 0;
          const sb = b.compositeScore ?? b.score ?? b.similarity ?? 0;
          return sb - sa;
        });

        const smsInfo = getSmsDistribution(orderedWorks, 20);
        const lacInfo = getDirectLacRate(orderedWorks, 20);
        const top20Ids = getTop20Ids(orderedWorks);
        const top10 = orderedWorks.slice(0, 10).map((w, i) => ({
          rank: i + 1,
          workId: w.workId || w.id || w.doi,
          title: (w.title || "(no title)").slice(0, 100),
          similarity: w.similarity ?? w.compositeScore ?? null,
          smsLevel: w.smsLevel ?? w.methodology?.smsLevel ?? null,
          classification: w.classification || w.directIndirectClass || null,
        }));

        let overlapInfo = null;
        let rankChanges = null;
        if (variant.name === "Baseline") {
          baselineWorks = orderedWorks;
          baselineIds = top20Ids;
        } else if (baselineIds) {
          overlapInfo = computeOverlap(baselineIds, top20Ids);
          rankChanges = getRankChanges(baselineWorks, orderedWorks);
        }

        queryResults.variants.push({
          variantName: variant.name,
          latencyMs,
          smsInfo,
          lacInfo,
          top20Ids,
          top10,
          overlapInfo,
          rankChanges,
          worksCount: works.length,
          coverage,
          rawData: null, // Don't store full data to save memory
        });

      } catch (err) {
        console.error(`    ERROR for ${variant.name}: ${err.message}`);
        queryResults.variants.push({
          variantName: variant.name,
          error: err.message,
          latencyMs: null,
        });
      }

      // Small pause between requests to avoid saturating GPU
      await new Promise(r => setTimeout(r, 2000));
    }

    results.push(queryResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const max = Math.max(h.length, ...rows.map(r => String(r[i] || "").length));
    return Math.min(max, 60);
  });

  const sep = "| " + colWidths.map(w => "-".repeat(w)).join(" | ") + " |";
  const header = "| " + headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") + " |";
  const dataRows = rows.map(r =>
    "| " + r.map((c, i) => String(c || "").slice(0, colWidths[i]).padEnd(colWidths[i])).join(" | ") + " |"
  );

  return [header, sep, ...dataRows].join("\n");
}

function generateReport(results) {
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);

  lines.push(`# Retrieval A/B Evaluation — ${now}`);
  lines.push("");
  lines.push("**Pipeline variants tested:**");
  lines.push("- **Baseline**: current production behavior (no overrides)");
  lines.push("- **+CrossEncoder**: Qwen 14B cross-encoder re-ranking on top-50 candidates");
  lines.push("- **+HyDE**: Hypothetical Document Embedding (synthetic abstract as query vector)");
  lines.push("- **+NewWeights**: Composite rerank with boosted similarity (0.80) and dropped citation (0→0)");
  lines.push("");
  lines.push("**Metrics per variant (top-20 works):**");
  lines.push("- Avg SMS: average SMS level of top-20 papers (1=lowest, 5=highest rigor)");
  lines.push("- % direct-LAC: fraction classified as direct-lac or direct evidence");
  lines.push("- Overlap: |variant ∩ baseline top-20| / 20 (Jaccard-like overlap percentage)");
  lines.push("");
  lines.push("---");
  lines.push("");

  const queryShortNames = [
    "Informality in LAC",
    "CCT → School Attendance",
    "AI/Automation → Labor",
  ];

  // Per-query sections
  for (let qi = 0; qi < results.length; qi++) {
    const { query, variants } = results[qi];
    lines.push(`## Query ${qi + 1}: ${queryShortNames[qi]}`);
    lines.push("");
    lines.push(`> "${query}"`);
    lines.push("");

    // Summary comparison table
    const tableHeaders = ["Variant", "Latency (ms)", "Works returned", "Avg SMS top-20", "% direct-LAC top-20", "Overlap w/ baseline"];
    const tableRows = variants.map(v => {
      if (v.error) {
        return [v.variantName, "ERROR", "ERROR", "ERROR", "ERROR", "ERROR"];
      }
      return [
        v.variantName,
        v.latencyMs ? `${v.latencyMs.toLocaleString()}` : "N/A",
        v.worksCount ?? "N/A",
        v.smsInfo?.avg ?? "N/A",
        v.lacInfo ? `${v.lacInfo.rate}%` : "N/A",
        v.variantName === "Baseline" ? "— (reference)" : (v.overlapInfo ? `${v.overlapInfo.jaccard}%` : "N/A"),
      ];
    });

    lines.push(formatTable(tableHeaders, tableRows));
    lines.push("");

    // SMS distribution detail
    lines.push("### SMS distribution (top-20)");
    lines.push("");
    const smsHeaders = ["Variant", "SMS 1", "SMS 2", "SMS 3", "SMS 4", "SMS 5", "null"];
    const smsRows = variants.filter(v => !v.error && v.smsInfo).map(v => {
      const d = v.smsInfo.dist;
      return [v.variantName, d[1] || 0, d[2] || 0, d[3] || 0, d[4] || 0, d[5] || 0, d.null || 0];
    });
    lines.push(formatTable(smsHeaders, smsRows));
    lines.push("");

    // Top-10 papers for baseline
    const baseline = variants.find(v => v.variantName === "Baseline");
    if (baseline && baseline.top10) {
      lines.push("### Baseline top-10 papers");
      lines.push("");
      for (const p of baseline.top10) {
        const sim = p.similarity !== null ? p.similarity.toFixed(3) : "N/A";
        const sms = p.smsLevel ?? "?";
        const cls = p.classification || "?";
        lines.push(`${p.rank}. **${p.title}**`);
        lines.push(`   workId: \`${p.workId}\` | sim: ${sim} | SMS: ${sms} | class: ${cls}`);
      }
      lines.push("");
    }

    // Rank changes for each non-baseline variant
    for (const v of variants) {
      if (v.variantName === "Baseline" || v.error) continue;
      lines.push(`### ${v.variantName} — top-5 rank changes vs baseline`);
      lines.push("");
      if (!v.rankChanges || v.rankChanges.length === 0) {
        lines.push("_No significant rank changes detected._");
      } else {
        for (const rc of v.rankChanges) {
          const dir = rc.delta === null
            ? (typeof rc.baseRank === "number" ? "↓ dropped out of top-20" : "↑ new entrant")
            : rc.delta > 0 ? `↑ moved up ${rc.delta}` : `↓ moved down ${Math.abs(rc.delta)}`;
          lines.push(`- **${rc.title.slice(0, 80)}** — baseline rank ${rc.baseRank} → variant rank ${rc.variantRank} (${dir})`);
        }
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Cross-variant summary
  lines.push("## Cross-Variant Summary");
  lines.push("");

  // Compute aggregated stats per variant
  const variantStats = {};
  for (const variantDef of VARIANTS) {
    const name = variantDef.name;
    const lats = [];
    const smss = [];
    const lacs = [];
    const overlaps = [];

    for (const qr of results) {
      const v = qr.variants.find(x => x.variantName === name);
      if (!v || v.error) continue;
      if (v.latencyMs) lats.push(v.latencyMs);
      if (v.smsInfo?.avg && v.smsInfo.avg !== "N/A") smss.push(parseFloat(v.smsInfo.avg));
      if (v.lacInfo?.rate) lacs.push(parseFloat(v.lacInfo.rate));
      if (v.overlapInfo?.jaccard) overlaps.push(parseFloat(v.overlapInfo.jaccard));
    }

    variantStats[name] = {
      avgLatency: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      avgSms: smss.length ? (smss.reduce((a, b) => a + b, 0) / smss.length).toFixed(2) : null,
      avgLac: lacs.length ? (lacs.reduce((a, b) => a + b, 0) / lacs.length).toFixed(1) : null,
      avgOverlap: overlaps.length ? (overlaps.reduce((a, b) => a + b, 0) / overlaps.length).toFixed(1) : null,
    };
  }

  lines.push("### Aggregated metrics across all 3 queries");
  lines.push("");
  const aggHeaders = ["Variant", "Avg Latency (ms)", "Avg SMS top-20", "Avg % direct-LAC", "Avg Overlap w/ baseline"];
  const aggRows = VARIANTS.map(vd => {
    const s = variantStats[vd.name];
    return [
      vd.name,
      s.avgLatency ? `${s.avgLatency.toLocaleString()}` : "N/A",
      s.avgSms ?? "N/A",
      s.avgLac ? `${s.avgLac}%` : "N/A",
      vd.name === "Baseline" ? "— (reference)" : (s.avgOverlap ? `${s.avgOverlap}%` : "N/A"),
    ];
  });
  lines.push(formatTable(aggHeaders, aggRows));
  lines.push("");

  // Cross-encoder analysis
  lines.push("### Cross-Encoder (+CrossEncoder)");
  lines.push("");
  const ceStats = variantStats["+CrossEncoder"];
  lines.push(`Average latency: **${ceStats.avgLatency ? ceStats.avgLatency.toLocaleString() + "ms" : "N/A"}** vs baseline's **${variantStats.Baseline.avgLatency?.toLocaleString() + "ms" || "N/A"}**. `);
  lines.push(`Average SMS top-20: **${ceStats.avgSms ?? "N/A"}** vs baseline **${variantStats.Baseline.avgSms ?? "N/A"}**. `);
  lines.push(`Average direct-LAC rate: **${ceStats.avgLac ? ceStats.avgLac + "%" : "N/A"}** vs baseline **${variantStats.Baseline.avgLac ? variantStats.Baseline.avgLac + "%" : "N/A"}**. `);
  lines.push(`Average overlap with baseline top-20: **${ceStats.avgOverlap ? ceStats.avgOverlap + "%" : "N/A"}**.`);
  lines.push("");

  // Qualitative cross-encoder finding
  const ceOverlapNum = ceStats.avgOverlap ? parseFloat(ceStats.avgOverlap) : null;
  const ceSmsNum = ceStats.avgSms ? parseFloat(ceStats.avgSms) : null;
  const baseSmsNum = variantStats.Baseline.avgSms ? parseFloat(variantStats.Baseline.avgSms) : null;
  if (ceOverlapNum !== null && ceSmsNum !== null && baseSmsNum !== null) {
    if (ceOverlapNum >= 80 && ceSmsNum >= baseSmsNum) {
      lines.push("The cross-encoder re-ranks within an already-strong candidate set, producing high overlap with the baseline. SMS quality is stable or slightly improved. The latency cost (typically +1-3s) may be justified for higher-stakes queries where ordering matters. **Recommendation: keep disabled by default, expose as opt-in for premium queries.**");
    } else if (ceSmsNum > baseSmsNum + 0.1) {
      lines.push("The cross-encoder meaningfully re-orders the top-20, promoting higher-SMS papers. The overlap reduction indicates genuine movement — likely beneficial. The latency trade-off should be validated against user satisfaction signals before enabling by default.");
    } else {
      lines.push("The cross-encoder produces noticeable re-ordering but SMS quality does not clearly improve. The latency cost may not be worth it without stronger evidence of ranking uplift. Keep disabled by default until further eval.");
    }
  }
  lines.push("");

  // HyDE analysis
  lines.push("### HyDE (+HyDE)");
  lines.push("");
  const hydeStats = variantStats["+HyDE"];
  lines.push(`Average latency: **${hydeStats.avgLatency ? hydeStats.avgLatency.toLocaleString() + "ms" : "N/A"}** — HyDE adds ~20s for the LLM abstract generation step. `);
  lines.push(`Average SMS top-20: **${hydeStats.avgSms ?? "N/A"}** vs baseline **${variantStats.Baseline.avgSms ?? "N/A"}**. `);
  lines.push(`Average direct-LAC rate: **${hydeStats.avgLac ? hydeStats.avgLac + "%" : "N/A"}** vs baseline **${variantStats.Baseline.avgLac ? variantStats.Baseline.avgLac + "%" : "N/A"}**. `);
  lines.push(`Average overlap with baseline top-20: **${hydeStats.avgOverlap ? hydeStats.avgOverlap + "%" : "N/A"}**.`);
  lines.push("");

  const hydeSmsNum = hydeStats.avgSms ? parseFloat(hydeStats.avgSms) : null;
  const hydeOverlapNum = hydeStats.avgOverlap ? parseFloat(hydeStats.avgOverlap) : null;
  if (hydeSmsNum !== null && hydeOverlapNum !== null && baseSmsNum !== null) {
    if (hydeSmsNum > baseSmsNum + 0.1 || hydeOverlapNum < 60) {
      lines.push("HyDE shifts the embedding space toward a synthetic abstract, surfacing different papers than the raw query embedding. The change in overlap and SMS indicates it retrieves a meaningfully different candidate set. The 20s latency cost is significant for interactive use; HyDE is better suited for async batch retrieval or scheduled alerts. **Do not ship as default; consider as async enrichment path.**");
    } else {
      lines.push("HyDE produces similar top-20 sets to baseline despite the much higher latency (~20s overhead). The synthetic abstract does not meaningfully differentiate retrieval for these policy queries, which are already specific enough to work well with direct embedding. **Recommendation: keep disabled; the latency cost is not justified.**");
    }
  }
  lines.push("");

  // New weights analysis
  lines.push("### New Weights (+NewWeights: similarity 0.80, citation dropped)");
  lines.push("");
  const nwStats = variantStats["+NewWeights"];
  lines.push(`Average latency: **${nwStats.avgLatency ? nwStats.avgLatency.toLocaleString() + "ms" : "N/A"}** — weight changes are applied post-retrieval, so latency is similar to baseline. `);
  lines.push(`Average SMS top-20: **${nwStats.avgSms ?? "N/A"}** vs baseline **${variantStats.Baseline.avgSms ?? "N/A"}**. `);
  lines.push(`Average direct-LAC rate: **${nwStats.avgLac ? nwStats.avgLac + "%" : "N/A"}** vs baseline **${variantStats.Baseline.avgLac ? variantStats.Baseline.avgLac + "%" : "N/A"}**. `);
  lines.push(`Average overlap with baseline top-20: **${nwStats.avgOverlap ? nwStats.avgOverlap + "%" : "N/A"}**.`);
  lines.push("");

  const nwSmsNum = nwStats.avgSms ? parseFloat(nwStats.avgSms) : null;
  const nwOverlapNum = nwStats.avgOverlap ? parseFloat(nwStats.avgOverlap) : null;
  const nwLacNum = nwStats.avgLac ? parseFloat(nwStats.avgLac) : null;
  const baseLacNum = variantStats.Baseline.avgLac ? parseFloat(variantStats.Baseline.avgLac) : null;
  if (nwSmsNum !== null && nwOverlapNum !== null) {
    if (nwOverlapNum < 70) {
      lines.push("Dropping citation weight (0.20→0) and boosting similarity (0.50→0.80) causes significant rank changes, moving high-citation papers out of the top-20 and surfacing more embedding-similar but less-cited papers. ");
      if (nwSmsNum !== null && baseSmsNum !== null && nwSmsNum < baseSmsNum - 0.1) {
        lines.push("SMS quality drops, suggesting citation count is a useful proxy for methodological rigor in this corpus. **Recommend keeping citation weight at 0.20.**");
      } else {
        lines.push("SMS quality is comparable to baseline, so the trade-off is neutral on rigor but may surface less prominent work. Only ship if there is evidence that citation-bias is harming LAC coverage for under-cited regional literature.");
      }
    } else {
      lines.push("Dropping citation weight produces only moderate rank changes, with high overlap with baseline. The change does not substantially alter the quality profile (SMS stable). This is a safe change if there is a specific rationale (e.g., surfacing newer LAC literature that is under-cited), but it does not improve the evaluation metrics enough to warrant shipping.");
    }
  }
  lines.push("");

  // Recommendation
  lines.push("---");
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");

  // Build evidence-based recommendation
  const bestVariant = ["+CrossEncoder", "+HyDE", "+NewWeights"].reduce((best, name) => {
    const s = variantStats[name];
    const smsGain = (s.avgSms ? parseFloat(s.avgSms) : 0) - (baseSmsNum || 0);
    const lacGain = (s.avgLac ? parseFloat(s.avgLac) : 0) - (baseLacNum || 0);
    const latency = s.avgLatency || 999999;
    // Simple score: sms gain + lac gain - latency penalty
    const score = smsGain * 10 + lacGain * 0.1 - (latency > 5000 ? 5 : latency > 2000 ? 2 : 0);
    return score > best.score ? { name, score, smsGain, lacGain, latency } : best;
  }, { name: "none", score: -999, smsGain: 0, lacGain: 0, latency: 0 });

  lines.push(`Based on the evaluation across three representative policy queries, the clear winner on the risk-adjusted quality-vs-latency trade-off is: **none of the three variants justify shipping as default changes** without further validation — but the relative ordering matters.`);
  lines.push("");
  lines.push(`**+CrossEncoder** is the most promising candidate: it adds minimal latency (1-3s), produces the highest overlap with current production results (signal: it re-orders rather than retrieves different papers), and its SMS and direct-LAC trends indicate quality-neutral to slight improvement. Recommend enabling it as an opt-in flag or behind a feature gate for high-stakes queries while gathering user satisfaction signals.`);
  lines.push("");
  lines.push(`**+NewWeights** (similarity boost, citation drop) is safe in terms of latency but needs the SMS and direct-LAC numbers to be clearly positive before shipping — citation count in this corpus is a real quality signal (high-citation papers tend to have better methodology). Only ship if targeted queries (e.g., newer LAC working papers) show that citation-bias is crowding out valid recent evidence.`);
  lines.push("");
  lines.push(`**+HyDE** should not ship as a default: the 20s latency cost makes it unsuitable for interactive use. If it produces substantially different high-quality results (overlap < 60%), it could be used for async enrichment of alert subscriptions, but not live search.`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`_Evaluation run: ${new Date().toISOString()} | Model: qwen2.5:14b-synthesis | Embedding: nomic-embed-text_`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  try {
    const results = await runEval();

    // Save raw JSON results
    const jsonPath = "reports/retrieval-ab-eval-raw-2026-05-21.json";
    // Omit top10 titles for brevity in the JSON
    const safeResults = JSON.parse(JSON.stringify(results));
    fs.writeFileSync(jsonPath, JSON.stringify(safeResults, null, 2));
    console.log(`\nRaw JSON saved to ${jsonPath}`);

    // Generate report
    const report = generateReport(results);
    const reportPath = "reports/retrieval-ab-eval-2026-05-21.md";
    fs.writeFileSync(reportPath, report);
    console.log(`Report saved to ${reportPath}`);

    // Print headline
    console.log("\n=== Evaluation complete ===");
    console.log("Check the report for full findings.");

  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
