#!/usr/bin/env node
/**
 * Cross-encoder A/B eval.
 *
 * Two runs per query: one with crossEncoder=false (control, HyDE still on),
 * one with crossEncoder=true. Same 3 queries (q01/q02/q03) and canary DOIs as
 * eval-hyde-sweep.mjs.
 *
 * Pre-registered metrics:
 *   M1: q02 canon recall in evidence top-20 (target ≥2/3, ideal 3/3)
 *   M2: q01 top-5 quality unchanged or improved
 *   M3: q03 top-5 quality unchanged or improved
 *   M4: latency: <2s additional from cross-encoder
 *   M5: no broken queries — failure must fall back gracefully
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
const PROD_API = "https://v0-horizon-scanner-iadb.vercel.app";

const QUERIES = [
  { id: "q01", query: "what is impact of monetary incentives attracting teachers to hard to staff schools" },
  { id: "q02", query: "what is the impact of gender violence on labor outcomes" },
  { id: "q03", query: "what is the impact of AI on labor markets in Latin America" },
];

const CANARIES = {
  q02: [
    { doi: "10.1093/restud/rdaf004", title: "Bhalotra (RES)" },
    { doi: "10.1257/aer.100.4.1847", title: "Aizer 2010 (AER)" },
    { doi: "10.1111/ecoj.12246", title: "Anderberg 2016 (EJ)" },
  ],
};

// HyDE stays on for both arms (it's now the prod default since 2026-05-09).
// Only the cross-encoder flag flips.
const ARMS = [
  { label: "control (CE off)", body: { crossEncoder: false } },
  { label: "treatment (CE on)", body: { crossEncoder: true } },
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

async function runOne(token, q, armBody) {
  const body = {
    query: q.query,
    filters: {
      topics: [], methodology: [], regions: [], sourceIds: [], tiers: [],
      timePeriod: "all", startDate: "", endDate: "", includeSignals: false,
    },
    ...armBody,
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

async function fetchTopTitles(runId, n = 5) {
  const { data: run } = await sb
    .from("search_runs")
    .select("evidence_work_ids")
    .eq("id", runId)
    .single();
  const ids = (run?.evidence_work_ids ?? []).slice(0, n);
  if (ids.length === 0) return [];
  const { data: works } = await sb
    .from("works")
    .select("id, title, venue, year")
    .in("id", ids);
  // Preserve evidence order
  const byId = new Map((works ?? []).map((w) => [w.id, w]));
  return ids.map((id) => byId.get(id) ?? { id, title: "(missing)" });
}

function findCanaries(run, canaryList) {
  const out = [];
  for (const c of canaryList) {
    const candIdx = (run.candidate_work_ids ?? []).indexOf(c.doi);
    const evIdx = (run.evidence_work_ids ?? []).indexOf(c.doi);
    out.push({
      title: c.title,
      doi: c.doi,
      inCandidates: candIdx >= 0 ? candIdx + 1 : null,
      inEvidence: evIdx >= 0 ? evIdx + 1 : null,
    });
  }
  return out;
}

(async () => {
  console.log("Minting token...");
  const token = await mintToken();
  console.log("Token minted.\n");

  const results = {};

  for (const arm of ARMS) {
    console.log("=".repeat(72));
    console.log(`ARM: ${arm.label}`);
    console.log("=".repeat(72));
    results[arm.label] = {};

    for (const q of QUERIES) {
      console.log(`\n--- ${q.id}: ${q.query.slice(0, 60)} ---`);
      const { status, run, ms } = await runOne(token, q, arm.body);
      if (status !== 201 && status !== 200) {
        console.log(`  ERROR ${status}: ${JSON.stringify(run).slice(0, 200)}`);
        results[arm.label][q.id] = { error: run, latencyMs: ms };
        continue;
      }
      const details = await fetchRunDetails(run.id);
      const top5 = await fetchTopTitles(run.id, 5);
      console.log(`  runId=${run.id.slice(0, 8)} latency=${ms}ms coverage=${JSON.stringify(details.coverage)}`);
      console.log(`  top-5:`);
      top5.forEach((w, i) => console.log(`    ${i + 1}. ${(w.title ?? "").slice(0, 90)} [${w.venue ?? "?"}, ${w.year ?? "?"}]`));

      let canaryHits = null;
      if (CANARIES[q.id]) {
        canaryHits = findCanaries(details, CANARIES[q.id]);
        console.log(`  canaries:`);
        for (const h of canaryHits) {
          const where = h.inEvidence ? `EV@${h.inEvidence}` : h.inCandidates ? `CAND@${h.inCandidates}` : "MISS";
          console.log(`    ${where.padEnd(10)} ${h.title}`);
        }
      }
      results[arm.label][q.id] = {
        runId: run.id,
        latencyMs: ms,
        coverage: details.coverage,
        canaries: canaryHits,
        top5: top5.map((w) => ({ id: w.id, title: w.title, venue: w.venue, year: w.year })),
      };
    }
    console.log();
  }

  fs.writeFileSync(
    new URL("../evals/runs/2026-05-09-cross-encoder-eval.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY — q02 canon recall (M1)");
  console.log("=".repeat(72));
  console.log("Arm                      | candidates | top-20 | latency(ms)");
  console.log("-".repeat(72));
  for (const armLabel of Object.keys(results)) {
    const q02 = results[armLabel].q02;
    if (!q02 || q02.error) {
      console.log(`${armLabel.padEnd(24)} | ERROR (${q02?.error ? JSON.stringify(q02.error).slice(0,40) : "?"})`);
      continue;
    }
    const inCand = q02.canaries?.filter((c) => c.inCandidates).length ?? 0;
    const inEv = q02.canaries?.filter((c) => c.inEvidence && c.inEvidence <= 20).length ?? 0;
    console.log(`${armLabel.padEnd(24)} | ${String(inCand).padStart(3)}/3      | ${String(inEv).padStart(3)}/3  | ${q02.latencyMs}`);
  }

  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY — q02 canary positions (control vs treatment)");
  console.log("=".repeat(72));
  const ctrl = results["control (CE off)"]?.q02?.canaries ?? [];
  const trt = results["treatment (CE on)"]?.q02?.canaries ?? [];
  console.log("Canary               | control evidence | treatment evidence");
  console.log("-".repeat(72));
  for (let i = 0; i < ctrl.length; i++) {
    const c = ctrl[i];
    const t = trt[i] ?? {};
    const cPos = c.inEvidence ? `EV@${c.inEvidence}` : c.inCandidates ? `CAND@${c.inCandidates}` : "MISS";
    const tPos = t.inEvidence ? `EV@${t.inEvidence}` : t.inCandidates ? `CAND@${t.inCandidates}` : "MISS";
    console.log(`${(c.title ?? "").padEnd(20)} | ${cPos.padEnd(16)} | ${tPos}`);
  }

  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY — latency delta (M4, target <2s)");
  console.log("=".repeat(72));
  for (const q of QUERIES) {
    const c = results["control (CE off)"]?.[q.id];
    const t = results["treatment (CE on)"]?.[q.id];
    if (!c || !t || c.error || t.error) continue;
    const delta = t.latencyMs - c.latencyMs;
    console.log(`${q.id}: control=${c.latencyMs}ms  treatment=${t.latencyMs}ms  delta=${delta >= 0 ? "+" : ""}${delta}ms`);
  }

  console.log("\nSaved to evals/runs/2026-05-09-cross-encoder-eval.json");
})();
