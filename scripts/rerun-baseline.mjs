import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? "https://llm.iotaimpact.com").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const CHAT_ENDPOINT = `${LLM_BASE_URL}/v1/chat/completions`;
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen2.5:14b-synthesis";

if (!LLM_API_KEY) {
  console.error("Missing LLM_API_KEY (LiteLLM proxy requires Bearer auth)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const SYSTEM = readFileSync("supabase/functions/_shared/extractionPrompt.ts", "utf8")
  .match(/export const EXTRACTION_SYSTEM_PROMPT = `([\s\S]*?)`;/)?.[1] ?? "";

async function qwen(prompt) {
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
        { role: "user", content: prompt },
      ],
      stream: false,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const d = await res.json();
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`No content: ${JSON.stringify(d).slice(0, 200)}`);
  try { return JSON.parse(content); }
  catch { return JSON.parse(String(content).replace(/^```(?:json)?\s*/i,"").replace(/```\s*$/,"").trim()); }
}

function normalizeDirection(raw) {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (["positive","negative","null","mixed","unclear"].includes(s)) return s;
  if (s.length > 30 && s.includes("positive") && (s.includes("negative") || s.includes("null") || s.includes("no significant"))) return "mixed";
  const neg = ["decrease","declin","reduc","lower","fell","drop","worsen"];
  const pos = ["increase","improv","higher","rose","rise","gain","grow"];
  const nul = ["no significant","no effect","insignificant","not significant","no detectable"];
  if (nul.some(w => s.includes(w))) return "null";
  if (neg.some(w => s.includes(w)) && !pos.some(w => s.includes(w))) return "negative";
  if (pos.some(w => s.includes(w)) && !neg.some(w => s.includes(w))) return "positive";
  return "unclear";
}

// Extract the FEW_SHOTS block from the prompt file
const promptFile = readFileSync("supabase/functions/_shared/extractionPrompt.ts", "utf8");
const fewShotsMatch = promptFile.match(/const FEW_SHOTS = `([\s\S]*?)`;/);
const FEW_SHOTS = fewShotsMatch?.[1] ?? "";

function buildPrompt(title, abstract, design) {
  return `${FEW_SHOTS}

NOW EXTRACT FOR THIS PAPER:

Title: ${title}
Abstract: ${abstract}
Methodology design (pre-classified, may be wrong): ${design ?? "unknown"}

Extract the evidence card. Output JSON only.`;
}

const list = JSON.parse(readFileSync("/tmp/rerun-papers.json","utf8"));
const results = [];

for (const entry of list) {
  const { data: work } = await supabase.from("works").select("id,title,abstract,methodology_design").eq("id", entry.work_id).single();
  if (!work?.abstract) { console.warn("skip no abstract:", entry.work_id); continue; }
  
  console.log(`\n⏳ ${entry.category} (${entry.work_id.slice(-25)})`);
  const card = await qwen(buildPrompt(work.title, work.abstract, work.methodology_design));
  card.effect_direction = normalizeDirection(card.effect_direction);
  
  console.log(`  design: ${card.study_design}`);
  console.log(`  direction: ${card.effect_direction}`);
  console.log(`  treatment: ${card.treatment_group?.slice(0,60)}`);
  
  results.push({ entry, card });
}

writeFileSync("/tmp/rerun-cards.json", JSON.stringify(results, null, 2));
console.log("\n=== Done ===");
