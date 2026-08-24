#!/usr/bin/env node
/**
 * Hit prod /api/search-runs for the 3 canary queries via session minting,
 * print top-20 with DOIs to verify synonym-bridging fix.
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

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;
const PROD_API = "https://v0-horizon-scanner-iadb.vercel.app";

const QUERIES = [
  { id: "q01", query: "what is impact of monetary incentives attracting teachers to hard to staff schools" },
  { id: "q02", query: "what is the impact of gender violence on labor outcomes" },
  { id: "q03", query: "what is the impact of AI on labor markets in Latin America" },
];

const CANARY = {
  q02: [
    { doi: "10.2139/ssrn.3892571", title: "Bhalotra 2021 — Job Displacement, UB and DV" },
    { doi: "10.1111/ecoj.12246", title: "Anderberg 2016 — Unemployment and DV" },
    { doi: "10.1257/aer.100.4.1847", title: "Aizer 2010 — Wage Gap and DV" },
  ],
};

async function mintToken() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "horizon-scanner@iadb.org",
  });
  if (error) throw error;
  const sb = createClient(SUPABASE_URL, ANON_KEY);
  const { data: v, error: vErr } = await sb.auth.verifyOtp({
    type: "magiclink",
    token_hash: data?.properties?.hashed_token,
  });
  if (vErr) throw vErr;
  return v.session.access_token;
}

async function runOne(token, q) {
  const body = {
    query: q.query,
    filters: {
      topics: [],
      methodology: [],
      regions: [],
      sourceIds: [],
      tiers: [],
      timePeriod: "all",
      startDate: "",
      endDate: "",
      includeSignals: false,
    },
  };
  const r = await fetch(`${PROD_API}/api/search-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-tenant-id": "iadb-demo",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return { status: r.status, run: j };
}

function extractTop20(run) {
  const ids = run?.evidenceWorkIds ?? run?.candidateWorkIds ?? [];
  const works = run?.works ?? [];
  const byId = new Map(works.map((w) => [w.id, w]));
  return ids.slice(0, 20).map((id, i) => {
    const w = byId.get(id) ?? {};
    return {
      rank: i + 1,
      id,
      doi: w.doi ?? w.canonicalDoi ?? null,
      title: (w.title ?? "").slice(0, 100),
      year: w.year ?? null,
    };
  });
}

(async () => {
  console.log("Minting token...");
  const token = await mintToken();
  console.log("Token minted.\n");

  const out = {};
  for (const q of QUERIES) {
    console.log(`=== ${q.id}: ${q.query} ===`);
    const t0 = Date.now();
    const { status, run } = await runOne(token, q);
    const ms = Date.now() - t0;
    console.log(`  status=${status} ms=${ms}`);
    if (status !== 201 && status !== 200) {
      console.log(`  ERROR: ${JSON.stringify(run).slice(0, 300)}`);
      out[q.id] = { error: run };
      continue;
    }
    const top = extractTop20(run);
    out[q.id] = {
      query: q.query,
      facets: run.queryFacets ?? null,
      top20: top,
      coverage: run.coverage,
      runId: run.id,
    };
    for (const r of top) {
      console.log(`   ${String(r.rank).padStart(2)}. [${r.doi ?? "no-doi"}] ${r.title}`);
    }
    if (CANARY[q.id]) {
      console.log("  Canary check:");
      for (const c of CANARY[q.id]) {
        const hit = top.find((r) => r.doi === c.doi);
        console.log(`    ${hit ? `HIT @${hit.rank}` : "MISS"} ${c.doi} ${c.title}`);
      }
    }
    console.log();
  }

  fs.writeFileSync(
    new URL("../evals/runs/2026-05-08-synonym-bridging-fix-raw.json", import.meta.url),
    JSON.stringify(out, null, 2),
  );
  console.log("Saved raw results to evals/runs/2026-05-08-synonym-bridging-fix-raw.json");
})();
