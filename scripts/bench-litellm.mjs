// scripts/bench-litellm.mjs
// One-shot: measure LiteLLM proxy latency at realistic load + estimate worker ETA.
// Usage: node scripts/bench-litellm.mjs
import { config } from "dotenv";
import { readFileSync } from "node:fs";

config();

const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? "https://llm.iotaimpact.com").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen2.5:14b-synthesis";
const CHAT_ENDPOINT = `${LLM_BASE_URL}/v1/chat/completions`;
const BATCH_SIZE = parseInt(process.env.WORKER_BATCH_SIZE ?? "5", 10);

if (!LLM_API_KEY) { console.error("Missing LLM_API_KEY"); process.exit(1); }

// Realistic prompt (mirrors extraction-worker.mjs load — full system + few_shots + abstract)
const SHARED = readFileSync("supabase/functions/_shared/extractionPrompt.ts", "utf8");
const SYSTEM = SHARED.match(/export const EXTRACTION_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1] ?? "";
const FEW_SHOTS = SHARED.match(/const FEW_SHOTS\s*=\s*`([\s\S]*?)`;/)?.[1] ?? "";

const SAMPLE_ABSTRACT = `This randomized controlled trial evaluates the effect of a conditional cash transfer (CCT) program on school attendance and household consumption among 2,400 low-income rural households in northern Mexico (2018-2020). Households receiving CCT (n=1,200) showed a 12.4 percentage point increase in school attendance (95% CI: 8.1-16.7, p<0.001) and a 23% increase in monthly food expenditure compared to control (n=1,200). Effects were stronger for female-headed households and households with school-age daughters.`;

const USER_PROMPT = `${FEW_SHOTS}

NOW EXTRACT FOR THIS PAPER:

Title: Conditional Cash Transfers and School Attendance: Evidence from Rural Mexico
Abstract: ${SAMPLE_ABSTRACT}
Methodology design (pre-classified, may be wrong): RCT

Extract the evidence card. Output JSON only.`;

console.log(`System prompt:  ${SYSTEM.length} chars`);
console.log(`User prompt:    ${USER_PROMPT.length} chars`);
console.log(`Endpoint:       ${CHAT_ENDPOINT}`);
console.log(`Model:          ${QWEN_MODEL}`);
console.log();

async function oneCall() {
  const t0 = Date.now();
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER_PROMPT },
      ],
      stream: false,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 80)}`);
  const data = await res.json();
  return { ms: Date.now() - t0, tokens: data?.usage?.completion_tokens ?? null };
}

async function probe(n) {
  const t0 = Date.now();
  const out = await Promise.allSettled(Array.from({ length: n }, () => oneCall()));
  const wall = Date.now() - t0;
  const ok = out.filter(r => r.status === "fulfilled").map(r => r.value);
  const failed = out.filter(r => r.status === "rejected");
  const ms = ok.map(r => r.ms);
  const avg = ms.length ? Math.round(ms.reduce((a,b)=>a+b,0) / ms.length) : 0;
  const min = ms.length ? Math.min(...ms) : 0;
  const max = ms.length ? Math.max(...ms) : 0;
  const callsPerMin = ok.length / (wall / 60_000);
  console.log(`N=${String(n).padStart(2)} | wall=${(wall/1000).toFixed(1)}s | avg=${(avg/1000).toFixed(1)}s | min=${(min/1000).toFixed(1)}s | max=${(max/1000).toFixed(1)}s | ok=${ok.length} fail=${failed.length} | calls/min=${callsPerMin.toFixed(1)}`);
  if (failed[0]) console.log(`  fail: ${String(failed[0].reason?.message).slice(0,100)}`);
  return { n, wall, ok: ok.length, callsPerMin };
}

async function getQueueCount() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/extraction_queue?select=state&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: "count=exact",
      "Range-Unit": "items",
      Range: "0-0",
    },
  });
  const total = parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0", 10);
  // by state
  const byState = {};
  for (const s of ["queued", "processing", "done", "failed"]) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/extraction_queue?select=state&state=eq.${s}&limit=1`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "count=exact",
        "Range-Unit": "items",
        Range: "0-0",
      },
    });
    byState[s] = parseInt(r.headers.get("content-range")?.split("/")[1] ?? "0", 10);
  }
  return { total, byState };
}

console.log("Warming up (cold start)...");
const warm = await oneCall();
console.log(`  warm: ${(warm.ms/1000).toFixed(1)}s, ${warm.tokens} tokens out\n`);

const queue = await getQueueCount();
if (queue) {
  console.log(`Queue: total=${queue.total} | queued=${queue.byState.queued} processing=${queue.byState.processing} done=${queue.byState.done} failed=${queue.byState.failed}\n`);
}

console.log("Concurrency probe (realistic extraction-size prompts):");
const sizes = [1, 5, 10];
const data = [];
for (const n of sizes) data.push(await probe(n));

const best = data.reduce((a, b) => (b.callsPerMin > a.callsPerMin ? b : a));
console.log(`\n=== Throughput summary ===`);
console.log(`Best concurrency: N=${best.n} → ${best.callsPerMin.toFixed(1)} LLM calls/min`);
console.log(`Each paper = 2 LLM calls (extract + verify)`);
const papersPerMin = best.callsPerMin / 2;
console.log(`Effective: ~${papersPerMin.toFixed(2)} papers/min`);

if (queue) {
  const remaining = queue.byState.queued + queue.byState.processing;
  const minutes = remaining / papersPerMin;
  const hours = minutes / 60;
  const days = hours / 24;
  console.log(`\n=== ETA for queue ===`);
  console.log(`Papers remaining: ${remaining}`);
  console.log(`Single worker: ${minutes.toFixed(0)} min = ${hours.toFixed(1)} h = ${days.toFixed(1)} days`);
  console.log(`(worker batch_size=${BATCH_SIZE}, so it's already running ${BATCH_SIZE} papers in parallel — best.n=${best.n} measured)`);
}
