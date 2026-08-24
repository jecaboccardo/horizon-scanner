#!/usr/bin/env node
/**
 * Phase 2: HyDE threshold sweep.
 *
 * For each threshold in [baseline, 0.30, 0.35, 0.40, 0.45], run all 3 eval
 * queries against prod via session-minted token. Capture for each canary:
 *   - in raw candidates? (recall metric M1)
 *   - in evidence top-20? (recall metric M2)
 *   - classification bucket
 *   - surfacedFromHyde? hydeSimilarity?
 *   - per-facet sims
 *
 * "baseline" = HyDE off — control for the A/B.
 *
 * Pre-registered metrics:
 *   M1: q02 canon raw-candidate recall (target ≥1/3, ideal 3/3)
 *   M2: q02 canon top-20 recall (target ≥1/3)
 *   M3: q01 top-20 quality unchanged
 *   M4: q03 top-20 quality unchanged
 *   M5: median latency delta
 *   M6: # HyDE-only candidates excluded by classifier
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const PROD_API = process.env.PROD_API_BASE || process.env.PROD_API_BASE || 'http://localhost:3002';

const QUERIES = [
  { id: "q01", query: "what is impact of monetary incentives attracting teachers to hard to staff schools" },
  { id: "q02", query: "what is the impact of gender violence on labor outcomes" },
  { id: "q03", query: "what is the impact of AI on labor markets in Latin America" },
];

const CANARIES = {
  q02: [
    { doi: "10.2139/ssrn.3892571", title: "Bhalotra 2021" },
    { doi: "10.1111/ecoj.12246", title: "Anderberg 2016" },
    { doi: "10.1257/aer.100.4.1847", title: "Aizer 2010" },
  ],
};

const SWEEP = [
  { label: "hyde-off",     body: { hyde: false } },
  { label: "hyde-default", body: {} },
];

async function mintToken() {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "horizon-scanner@iadb.org",
  });
  if (error) throw error;
  const sb2 = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  const { data: v, error: vErr } = await sb2.auth.verifyOtp({
    type: "magiclink",
    token_hash: data?.properties?.hashed_token,
  });
  if (vErr) throw vErr;
  return v.session.access_token;
}

async function runOne(token, q, hydeBody) {
  const body = {
    query: q.query,
    filters: {
      topics: [], methodology: [], regions: [], sourceIds: [], tiers: [],
      timePeriod: "all", startDate: "", endDate: "", includeSignals: false,
    },
    ...hydeBody,
  };
  const t0 = Date.now();
  const r = await fetch(`${PROD_API}/api/search-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-tenant-id": "iadb-demo",
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { error: "non-json", body: text.slice(0, 300) }; }
  return { status: r.status, run: j, ms };
}

async function fetchRunDetails(runId) {
  const { data } = await sb
    .from("search_runs")
    .select("id, candidate_work_ids, evidence_work_ids, evidence_classification, coverage")
    .eq("id", runId)
    .single();
  return data;
}

function findCanaries(run, canaryList) {
  const out = [];
  for (const c of canaryList) {
    const candIdx = (run.candidate_work_ids ?? []).indexOf(c.doi);
    const evIdx = (run.evidence_work_ids ?? []).indexOf(c.doi);
    const cls = run.evidence_classification?.[c.doi] ?? null;
    out.push({
      title: c.title,
      doi: c.doi,
      inCandidates: candIdx >= 0 ? candIdx + 1 : null,
      inEvidence: evIdx >= 0 ? evIdx + 1 : null,
      classification: cls?.classification ?? cls?.evidenceMatch ?? null,
      surfacedFromHyde: cls?.surfacedFromHyde ?? false,
      hydeSimilarity: cls?.hydeSimilarity ?? null,
      facetScores: cls?.facetScores ?? null,
    });
  }
  return out;
}

(async () => {
  console.log("Minting token...");
  const token = await mintToken();
  console.log("Token minted.\n");

  const results = {};

  for (const sweep of SWEEP) {
    console.log("=".repeat(72));
    console.log(`SWEEP: ${sweep.label}`);
    console.log("=".repeat(72));
    results[sweep.label] = {};

    for (const q of QUERIES) {
      console.log(`\n--- ${q.id}: ${q.query.slice(0, 60)} ---`);
      const { status, run, ms } = await runOne(token, q, sweep.body);
      if (status !== 201 && status !== 200) {
        console.log(`  ERROR ${status}: ${JSON.stringify(run).slice(0, 200)}`);
        results[sweep.label][q.id] = { error: run };
        continue;
      }
      const details = await fetchRunDetails(run.id);
      console.log(`  runId=${run.id.slice(0, 8)} latency=${ms}ms coverage=${JSON.stringify(details.coverage)}`);

      let canaryHits = null;
      if (CANARIES[q.id]) {
        canaryHits = findCanaries(details, CANARIES[q.id]);
        for (const h of canaryHits) {
          const where =
            h.inEvidence ? `EV@${h.inEvidence}` :
            h.inCandidates ? `CAND@${h.inCandidates}` :
            "MISS";
          const tags = [];
          if (h.surfacedFromHyde) tags.push(`hydeSim=${h.hydeSimilarity?.toFixed(3) ?? "-"}`);
          if (h.classification) tags.push(h.classification);
          if (h.facetScores) tags.push(`facets=${Object.entries(h.facetScores).map(([k, v]) => `${k.slice(0,4)}=${v.toFixed(2)}`).join(",")}`);
          console.log(`    ${where.padEnd(10)} ${h.title.padEnd(20)} ${tags.join(" ")}`);
        }
      }
      results[sweep.label][q.id] = {
        runId: run.id,
        latencyMs: ms,
        coverage: details.coverage,
        canaries: canaryHits,
      };
    }
    console.log();
  }

  fs.writeFileSync(
    new URL("../evals/runs/2026-05-09-hyde-sweep-raw.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );

  // Summary table
  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY — q02 canary recall");
  console.log("=".repeat(72));
  console.log("Sweep                  | candidates | top-20 | latency(ms)");
  console.log("-".repeat(72));
  for (const sweepLabel of Object.keys(results)) {
    const q02 = results[sweepLabel].q02;
    if (!q02 || q02.error) continue;
    const inCand = q02.canaries?.filter((c) => c.inCandidates).length ?? 0;
    const inEv = q02.canaries?.filter((c) => c.inEvidence).length ?? 0;
    console.log(`${sweepLabel.padEnd(22)} | ${String(inCand).padStart(3)}/3      | ${String(inEv).padStart(3)}/3  | ${q02.latencyMs}`);
  }

  console.log("\nSaved to evals/runs/2026-05-09-hyde-sweep-raw.json");
})();
