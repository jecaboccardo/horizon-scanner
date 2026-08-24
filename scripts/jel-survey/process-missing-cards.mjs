// scripts/jel-survey/process-missing-cards.mjs
//
// One-shot card extractor for the JEL eval's missing-card rows.
//
// CT 135's extraction worker is currently broken (pins the removed
// qwen2.5:14b-synthesis model and 400s on every claim). Until DevOps
// restarts it with the new qwen2.5:14b-synthesis default, this script
// processes the missing cards directly from the laptop. It bypasses the
// claim_extraction_batch RPC so it doesn't race CT 135 — we operate on
// work_ids that are currently in `failed` state (which CT 135's worker
// ignores) and flip them to `done` only after a successful upsert.
//
// Reads the same extractionPrompt.ts as extraction-worker.mjs so cards are
// schema-compatible. Mirrors the confidence scoring + direction
// normalization from that worker.
//
// Usage:
//   node --env-file=.env scripts/jel-survey/process-missing-cards.mjs
//   node --env-file=.env scripts/jel-survey/process-missing-cards.mjs --only ai-automation-labor
//   node --env-file=.env scripts/jel-survey/process-missing-cards.mjs --limit 10
//   node --env-file=.env scripts/jel-survey/process-missing-cards.mjs --concurrency 3

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SHARED_PROMPT_PATH = resolve(ROOT, "supabase/functions/_shared/extractionPrompt.ts");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? "https://llm.iotaimpact.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const QWEN_MODEL = process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? "qwen2.5:14b-synthesis";
const QWEN_TIMEOUT_MS = 120_000;

if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
if (!LLM_API_KEY) { console.error("Missing LLM_API_KEY."); process.exit(1); }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { only: null, limit: null, offset: 0, concurrency: 2 };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i], n = argv[i + 1];
    if (f === "--only") { out.only = n; i++; }
    else if (f === "--limit") { out.limit = parseInt(n, 10); i++; }
    else if (f === "--offset") { out.offset = parseInt(n, 10); i++; }
    else if (f === "--concurrency") { out.concurrency = parseInt(n, 10); i++; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load shared prompt (parses extractionPrompt.ts as text — same approach as worker)
// ---------------------------------------------------------------------------
async function loadSharedPrompt() {
  const src = await readFile(SHARED_PROMPT_PATH, "utf8");
  const version = src.match(/EXTRACTION_PROMPT_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const system = src.match(/export const EXTRACTION_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1];
  const fewShots = src.match(/const FEW_SHOTS\s*=\s*`([\s\S]*?)`;/)?.[1];
  const verification = src.match(/export const VERIFICATION_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1];
  if (!version || !system || !fewShots || !verification) {
    throw new Error("Failed to parse extractionPrompt.ts");
  }
  return { version, system, fewShots, verification };
}

// ---------------------------------------------------------------------------
// Qwen call
// ---------------------------------------------------------------------------
async function qwenJSON(prompt, { system, temperature = 0.1 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await fetch(LLM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: QWEN_MODEL, messages, stream: false, temperature, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM no content`);
  try {
    return JSON.parse(content);
  } catch {
    return JSON.parse(String(content).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  }
}

// ---------------------------------------------------------------------------
// Helpers (mirrors extraction-worker.mjs)
// ---------------------------------------------------------------------------
const SPANISH_DIACRITICS = /[áéíóúñ¿¡]/;
const SPANISH_STOPWORDS = new Set(["el","la","los","las","de","del","y","que","en","por","con","un","una","es","son","fue","para","sobre","como","si","no","más","se","al","lo","su","sus","una","está","han","has","hay","tiene","tienen","ser","estar","evidencia","estudio","investigación","análisis","resultados","efecto","impacto","política","hogares","países"]);
function detectLanguage(text) {
  if (!text) return "en";
  if (SPANISH_DIACRITICS.test(text)) return "es";
  const tokens = text.toLowerCase().split(/[^a-záéíóúñ]+/).filter(Boolean);
  let hits = 0;
  for (const tok of tokens) if (SPANISH_STOPWORDS.has(tok)) hits++;
  return hits >= 3 ? "es" : "en";
}
function normalizeDirection(raw) {
  if (raw == null) return null;
  const s = (typeof raw === "string" ? raw : String(raw)).trim().toLowerCase();
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
function deriveConfidence({ study_design, sample_size, effect_direction, effect_size_text, statistical_significance, treatment_group, control_group }) {
  const baseDesign = (d) => {
    if (!d) return 1;
    const s = d.trim().toLowerCase();
    if (s === "rct" || s === "randomized controlled trial") return 4;
    if (["quasi-experimental","did","diff-in-diff","difference-in-differences","iv","instrumental variable","instrumental variables","rdd","regression discontinuity","regression discontinuity design","matching","propensity score matching","synthetic control"].includes(s)) return 3;
    if (s === "review" || s === "systematic review" || s === "meta-analysis") return 3;
    if (s === "observational") return 2;
    if (s === "qualitative") return 2;
    return 1;
  };
  const isExp = (v) => v != null && String(v).trim().toLowerCase() !== "unclear";
  const sampleAdj = (n, d) => {
    if (n == null) return -1;
    if (n >= 5000) return 1;
    if (n >= 500) return 0;
    const exp = d && ["rct","quasi-experimental","did","iv","rdd"].includes(d.toLowerCase());
    if (n >= 100) return exp ? -1 : 0;
    return -2;
  };
  const clarityAdj = (dir, size, sig) => {
    if (!isExp(dir)) return -2;
    if (isExp(dir) && isExp(size) && isExp(sig)) return 1;
    if (isExp(dir) && isExp(size)) return 0;
    return -1;
  };
  const controlAdj = (t, c) => {
    const ok = (v) => isExp(v);
    if (ok(t) && ok(c)) return 0;
    if (ok(t) || ok(c)) return -1;
    return -2;
  };
  const score = baseDesign(study_design) + sampleAdj(sample_size, study_design)
    + clarityAdj(effect_direction, effect_size_text, statistical_significance)
    + controlAdj(treatment_group, control_group);
  const band = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  return { score, band };
}

// ---------------------------------------------------------------------------
// Process one work
// ---------------------------------------------------------------------------
async function processOne(workId, shared) {
  const { data: work, error: wErr } = await sb.from("works")
    .select("id, title, abstract, methodology_design")
    .eq("id", workId).single();
  if (wErr || !work) throw new Error(`work not found: ${workId}`);
  if (!work.title || !work.abstract) throw new Error("missing title or abstract");

  const prompt = `${shared.fewShots}

NOW EXTRACT FOR THIS PAPER:

Title: ${work.title}
Abstract: ${work.abstract}
Methodology design (pre-classified, may be wrong): ${work.methodology_design ?? "unknown"}

Extract the evidence card. Output JSON only.`;

  const raw = await qwenJSON(prompt, { system: shared.system, temperature: 0.1 });
  const conf = deriveConfidence({
    study_design: raw.study_design,
    sample_size: raw.sample_size,
    effect_direction: raw.effect_direction,
    effect_size_text: raw.effect_size_text,
    statistical_significance: raw.statistical_significance,
    treatment_group: raw.treatment_group,
    control_group: raw.control_group,
  });

  const card = {
    work_id: workId,
    study_design: raw.study_design ?? null,
    comparison_type: raw.comparison_type ?? null,
    country: raw.country ?? null,
    region: raw.region ?? null,
    setting: raw.setting ?? null,
    population_group: raw.population_group ?? null,
    analysis_unit: raw.analysis_unit ?? null,
    age_range: raw.age_range ?? null,
    income_group: raw.income_group ?? null,
    intervention: raw.intervention ?? "unclear",
    outcome: raw.outcome ?? "unclear",
    secondary_outcomes: raw.secondary_outcomes ?? null,
    treatment_group: raw.treatment_group ?? null,
    control_group: raw.control_group ?? null,
    effect_direction: normalizeDirection(raw.effect_direction),
    effect_size_text: raw.effect_size_text ?? null,
    effect_size_numeric: raw.effect_size_numeric ?? null,
    effect_type: raw.effect_type ?? null,
    baseline_level: raw.baseline_level ?? null,
    statistical_significance: raw.statistical_significance ?? null,
    sample_size: raw.sample_size ?? null,
    sample_size_text: raw.sample_size_text ?? null,
    time_horizon: raw.time_horizon ?? null,
    data_source: raw.data_source ?? null,
    identification_strategy: raw.identification_strategy ?? null,
    limitations: raw.limitations ?? null,
    heterogeneity: raw.heterogeneity ?? null,
    secondary_findings: raw.secondary_findings ?? null,
    mechanism: raw.mechanism ?? null,
    external_validity_note: raw.external_validity_note ?? null,
    multi_finding_flag: raw.multi_finding_flag ?? false,
    source_section: raw.source_section ?? "abstract",
    source_text: raw.source_text ?? work.abstract.slice(0, 500),
    ungrounded_fields: raw.ungrounded_fields ?? null,
    finding_short: raw.finding_short ?? null,
    confidence: conf.band,
    confidence_score: conf.score,
    extracted_by: QWEN_MODEL,
    extraction_prompt_version: shared.version,
    extraction_tier: 1,
    needs_review: conf.band === "low",
    source_language: detectLanguage(work.abstract),
  };

  const { error: upErr } = await sb.from("evidence_cards").upsert(card, { onConflict: "work_id" });
  if (upErr) throw new Error(`upsert failed: ${upErr.message}`);

  // Mark queue row done so CT 135 doesn't re-pick it up
  await sb.from("extraction_queue").update({
    state: "done",
    completed_at: new Date().toISOString(),
    last_error: null,
  }).eq("work_id", workId);

  return { workId, design: card.study_design, confidence: card.confidence };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const shared = await loadSharedPrompt();
  console.log(`[process] prompt version ${shared.version}, model=${QWEN_MODEL}`);

  // Collect target work_ids from all coding sheets
  const sheetNames = ["cash-transfers-education-lac", "ai-automation-labor", "informality-lac"];
  const allMissing = new Set();
  for (const s of sheetNames) {
    if (args.only && s !== args.only) continue;
    const path = resolve(ROOT, `reports/evidence-coding-${s}-2026-05-20.json`);
    const sheet = JSON.parse(await readFile(path, "utf8"));
    for (const id of sheet.indexes.missingCard) allMissing.add(id);
  }
  let workIds = [...allMissing];
  if (args.offset) workIds = workIds.slice(args.offset);
  if (args.limit) workIds = workIds.slice(0, args.limit);

  console.log(`[process] processing ${workIds.length} papers, offset=${args.offset}, concurrency=${args.concurrency}`);

  let done = 0, failed = 0;
  const t0 = Date.now();
  // Simple concurrency pool
  const queue = [...workIds];
  const workers = Array.from({ length: args.concurrency }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const t = Date.now();
      try {
        const r = await processOne(id, shared);
        done++;
        console.log(`[process] OK ${id} (${((Date.now() - t) / 1000).toFixed(1)}s) design=${r.design} conf=${r.confidence}  [${done + failed}/${workIds.length}]`);
      } catch (err) {
        failed++;
        console.log(`[process] FAIL ${id}: ${err.message?.slice(0, 200)}  [${done + failed}/${workIds.length}]`);
      }
    }
  });
  await Promise.all(workers);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[process] complete: ${done} ok, ${failed} failed, in ${dt}s`);
}

main().catch((err) => {
  console.error("[process] fatal:", err);
  process.exit(1);
});
