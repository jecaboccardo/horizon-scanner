#!/usr/bin/env node
/**
 * Call explain_match_works RPC and print the EXPLAIN ANALYZE plan.
 * Use to figure out whether match_works latency is dominated by HNSW
 * scan, FTS, the FULL OUTER JOIN, or the post-JOIN works lookup.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = env.LLM_BASE_URL ?? "https://llm.iotaimpact.com";
const LLM_KEY = env.LLM_API_KEY ?? env.OPENAI_API_KEY;
const EMBED_MODEL = env.OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:8b";

async function embed(text) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: "search_query: " + text }),
  });
  const j = await r.json();
  return j?.data?.[0]?.embedding;
}

const QUERIES = [
  "What does high-quality evidence say about AI and labor in Latin America?",
  "gender violence and labor outcomes in Latin America",
];

for (const q of QUERIES) {
  console.log(`\n${"=".repeat(80)}\nQUERY: ${q}\n${"=".repeat(80)}`);
  const t0 = Date.now();
  const qv = await embed(q);
  console.log(`embed: ${Date.now() - t0}ms (dim=${qv?.length})`);

  const t1 = Date.now();
  const { data, error } = await sb.rpc("explain_match_works", {
    query_embedding: qv,
    query_text: q,
    match_threshold: 0.40,
    match_count: 200,
  });
  const ms = Date.now() - t1;
  if (error) { console.log("ERROR:", error.message); continue; }
  console.log(`\nEXPLAIN ANALYZE (rpc wall-clock=${ms}ms):\n`);
  for (const row of (data ?? [])) {
    const line = typeof row === "string" ? row : (row?.explain_match_works ?? JSON.stringify(row));
    console.log(line);
  }
}
