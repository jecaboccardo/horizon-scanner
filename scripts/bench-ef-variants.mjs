#!/usr/bin/env node
/**
 * A/B test match_works at ef_search = 200, 1000, 2000. Same query.
 * Reports per-variant: latency, result count, and top-20 overlap vs current
 * production match_works (which has ef_search=200) so we can see whether
 * widening the HNSW beam recovers candidates.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LLM = env.LLM_BASE_URL ?? "https://llm.iotaimpact.com";
const KEY = env.LLM_API_KEY ?? env.OPENAI_API_KEY;
const MODEL = env.OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:8b";

async function embed(text) {
  const r = await fetch(`${LLM}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: "search_query: " + text }),
  });
  const j = await r.json();
  return j?.data?.[0]?.embedding;
}

const QUERY = "What does high-quality evidence say about AI and labor in Latin America?";
const qv = await embed(QUERY);
console.log(`Query: "${QUERY}"`);
console.log(`Embedded (dim=${qv.length})\n`);

const variants = [
  { name: "ef_search=200  (prod)", fn: "match_works",        count: 500 },
  { name: "ef_search=1000         ", fn: "match_works_ef1000", count: 500 },
  { name: "ef_search=2000         ", fn: "match_works_ef2000", count: 500 },
];

const results = {};
for (const v of variants) {
  const runs = [];
  let ids;
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const { data, error } = await sb.rpc(v.fn, {
      query_embedding: qv,
      query_text: QUERY,
      match_threshold: 0.55,
      match_count: v.count,
    });
    const ms = Date.now() - t0;
    if (error) { console.log(`ERR ${v.fn}: ${error.message}`); break; }
    runs.push({ ms, rows: data.length });
    if (i === 1) ids = data.map((r) => r.id);
  }
  results[v.name] = { runs, top20: ids?.slice(0, 20) ?? [], allIds: ids ?? [] };
  console.log(`${v.name}  run1=${String(runs[0]?.ms).padStart(5)}ms (${String(runs[0]?.rows).padStart(4)} rows)  run2=${String(runs[1]?.ms).padStart(5)}ms (${String(runs[1]?.rows).padStart(4)} rows)`);
}

// Compute top-20 overlap pairs
const names = variants.map((v) => v.name);
console.log("\nTop-20 overlap (out of 20):");
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = new Set(results[names[i]].top20);
    const b = new Set(results[names[j]].top20);
    const overlap = [...a].filter((x) => b.has(x)).length;
    console.log(`  ${names[i]}  vs  ${names[j]}  =  ${overlap}/20`);
  }
}

// Compare full sets too
console.log("\nFull result set overlap (out of ~ result count):");
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = new Set(results[names[i]].allIds);
    const b = new Set(results[names[j]].allIds);
    const overlap = [...a].filter((x) => b.has(x)).length;
    console.log(`  ${names[i]}  vs  ${names[j]}  =  ${overlap} shared (a=${a.size}, b=${b.size})`);
  }
}
