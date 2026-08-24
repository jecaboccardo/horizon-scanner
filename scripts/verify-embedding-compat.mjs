#!/usr/bin/env node
/**
 * Verify whether nomic-embed-text-vllm produces vectors compatible with the
 * existing corpus (embedded via nomic-embed-text on Ollama).
 *
 * Embeds the same 5 sample texts with both models, computes cosine similarity
 * between the resulting vectors, and prints a pass/fail verdict.
 *
 * Compatibility verdict (per-text cosine sim between OLD and NEW vector):
 *   ≥ 0.999  → IDENTICAL — safe to swap, no re-embed needed
 *   ≥ 0.99   → NEAR-IDENTICAL — likely safe, some retrieval drift possible
 *   ≥ 0.95   → SIMILAR — retrieval quality WILL degrade; re-embed recommended
 *   < 0.95   → INCOMPATIBLE — query vs corpus space mismatch; must re-embed
 *               all 256k papers before swapping
 *
 * Usage:
 *   LLM_API_KEY=sk-... node scripts/verify-embedding-compat.mjs
 *
 * Optional env:
 *   LLM_BASE_URL (default https://llm.iotaimpact.com)
 *   OLD_MODEL    (default nomic-embed-text)
 *   NEW_MODEL    (default nomic-embed-text-vllm)
 */

const BASE = process.env.LLM_BASE_URL ?? "https://llm.iotaimpact.com";
const KEY = process.env.LLM_API_KEY;
const OLD = process.env.OLD_MODEL ?? "nomic-embed-text";
const NEW = process.env.NEW_MODEL ?? "nomic-embed-text-vllm";

if (!KEY) {
  console.error("ERROR: set LLM_API_KEY");
  process.exit(1);
}

const SAMPLES = [
  "search_query: artificial intelligence and labor market outcomes in Latin America",
  "search_query: gender gaps in education attainment across the Caribbean",
  "search_document: This paper studies the effect of automation on Brazilian manufacturing employment using a difference-in-differences design across 1995-2015.",
  "search_document: Evaluamos el impacto de transferencias condicionadas en la asistencia escolar en hogares de bajos ingresos en México.",
  "search_query: randomized controlled trial cash transfers fertility",
];

async function embed(model, text) {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data?.[0]?.embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function verdict(s) {
  if (s >= 0.999) return "IDENTICAL — safe to swap";
  if (s >= 0.99)  return "NEAR-IDENTICAL — likely safe";
  if (s >= 0.95)  return "SIMILAR — re-embed recommended";
  return "INCOMPATIBLE — must re-embed corpus";
}

console.log(`Comparing ${OLD} vs ${NEW} on ${BASE}\n`);

const sims = [];
for (const text of SAMPLES) {
  try {
    const [oldVec, newVec] = await Promise.all([embed(OLD, text), embed(NEW, text)]);
    if (!oldVec || !newVec) {
      console.log(`  ✗ ${text.slice(0, 60)}… → empty vector`);
      continue;
    }
    if (oldVec.length !== newVec.length) {
      console.log(`  ✗ DIMENSION MISMATCH: ${OLD}=${oldVec.length} vs ${NEW}=${newVec.length}`);
      console.log(`    → CANNOT SWAP. Different vector spaces.`);
      process.exit(2);
    }
    const sim = cosine(oldVec, newVec);
    sims.push(sim);
    console.log(`  cos=${sim.toFixed(5)}  "${text.slice(0, 60)}…"`);
  } catch (err) {
    console.log(`  ✗ ${text.slice(0, 60)}… → ${err.message}`);
  }
}

if (sims.length === 0) {
  console.log("\nNo successful comparisons. Check model names + API key.");
  process.exit(1);
}

const min = Math.min(...sims);
const avg = sims.reduce((a, b) => a + b) / sims.length;

console.log(`\nResults across ${sims.length} samples:`);
console.log(`  min cosine: ${min.toFixed(5)}`);
console.log(`  avg cosine: ${avg.toFixed(5)}`);
console.log(`\nVerdict: ${verdict(min)}`);
if (min < 0.95) {
  console.log(`\n⚠️  DO NOT SWAP without re-embedding. Mixed-model search will degrade silently.`);
  console.log(`   Re-embedding 256k papers via LiteLLM took ~6h previously — plan accordingly.`);
}
