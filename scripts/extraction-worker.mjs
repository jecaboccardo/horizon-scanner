// scripts/extraction-worker.mjs
// Long-running extraction worker. Run with: node scripts/extraction-worker.mjs
// Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Env optional: QWEN_ENDPOINT, QWEN_MODEL, WORKER_BATCH_SIZE, WORKER_MAX_ATTEMPTS

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { pid } from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// LLM endpoint is now LiteLLM (OpenAI-compatible) at https://llm.iotaimpact.com/v1/chat/completions
// Override with LLM_ENDPOINT to point elsewhere. QWEN_ENDPOINT kept as alias for back-compat.
const LLM_ENDPOINT = process.env.LLM_ENDPOINT ?? process.env.QWEN_ENDPOINT ?? "https://llm.iotaimpact.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
// LiteLLM model history:
//   2026-05-09  proxy moved from Ollama to vLLM; alias renamed
//               qwen2.5:14b-instruct → qwen2.5:7b-instruct-vllm
//   2026-05-20  qwen2.5:7b-instruct-vllm removed; only qwen2.5:14b-synthesis
//               remains as the general-purpose LLM. Worker restart on CT 135
//               needed to pick up this default.
const QWEN_MODEL = process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? "qwen2.5:14b-synthesis";
const BATCH_SIZE = parseInt(process.env.WORKER_BATCH_SIZE ?? "5", 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS ?? "3", 10);

if (!LLM_API_KEY) {
  console.error("[worker] Missing LLM_API_KEY (LiteLLM at " + LLM_ENDPOINT + " requires Bearer auth)");
  process.exit(1);
}
const POLL_MS = 2000;
const HEARTBEAT_MS = 60_000;
const WORKER_ID = `${hostname()}-${pid}`;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[worker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Load shared prompt from extractionPrompt.ts at startup (single source of truth)
// ---------------------------------------------------------------------------
const SHARED_PROMPT_PATH = process.env.EXTRACTION_PROMPT_PATH ?? "supabase/functions/_shared/extractionPrompt.ts";

function loadSharedPrompt() {
  const src = readFileSync(SHARED_PROMPT_PATH, "utf8");
  const version = src.match(/EXTRACTION_PROMPT_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const system = src.match(/export const EXTRACTION_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1];
  const fewShots = src.match(/const FEW_SHOTS\s*=\s*`([\s\S]*?)`;/)?.[1];
  const verification = src.match(/export const VERIFICATION_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1];
  if (!version || !system || !fewShots || !verification) {
    throw new Error(`Failed to parse ${SHARED_PROMPT_PATH} — missing version/system/few_shots/verification`);
  }
  return { version, system, fewShots, verification };
}

const SHARED = loadSharedPrompt();
const EXTRACTION_PROMPT_VERSION = SHARED.version;
console.log(`[worker] loaded prompt ${EXTRACTION_PROMPT_VERSION} from ${SHARED_PROMPT_PATH}`);

// ---------------------------------------------------------------------------
// LLM helper (LiteLLM, OpenAI-compatible /v1/chat/completions)
// ---------------------------------------------------------------------------
const QWEN_TIMEOUT_MS = 120_000; // 2 min ceiling — prevents hung calls blocking the worker

async function qwenGenerateJSON(prompt, { system, numCtx = 8192, temperature = 0.1 } = {}) {
  // numCtx is no longer a per-request knob via OpenAI-compat API; LiteLLM
  // applies the model's configured context window. Kept in the signature
  // for back-compat with callers.
  void numCtx;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = {
    model: QWEN_MODEL,
    messages,
    stream: false,
    temperature,
    response_format: { type: "json_object" },
  };
  const res = await fetch(LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM no content: ${JSON.stringify(data).slice(0, 200)}`);
  try {
    return JSON.parse(content);
  } catch {
    const stripped = String(content).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(stripped);
  }
}

// ---------------------------------------------------------------------------
// Language detection (simple heuristic — Spanish stopwords or diacritics)
// ---------------------------------------------------------------------------
const SPANISH_DIACRITICS = /[áéíóúñ¿¡]/;
const SPANISH_STOPWORDS = new Set(["el","la","los","las","de","del","y","que","en","por","con","un","una","es","son","fue","para","sobre","como","si","no","más","se","al","lo","su","sus","una","está","han","has","hay","tiene","tienen","ser","estar","evidencia","estudio","investigación","análisis","resultados","efecto","impacto","política","hogares","países"]);

function detectLanguage(text) {
  if (!text) return "en";
  if (SPANISH_DIACRITICS.test(text)) return "es";
  const tokens = text.toLowerCase().split(/[^a-záéíóúñ]+/).filter(Boolean);
  let hits = 0;
  for (const tok of tokens) { if (SPANISH_STOPWORDS.has(tok)) hits++; }
  return hits >= 3 ? "es" : "en";
}

// ---------------------------------------------------------------------------
// Confidence scoring (mirrors confidence.ts logic)
// ---------------------------------------------------------------------------
function deriveConfidence({ study_design, sample_size, effect_direction, effect_size_text, statistical_significance, treatment_group, control_group }) {
  function baseDesign(d) {
    if (!d) return 1;
    const s = d.trim().toLowerCase();
    if (s === "rct" || s === "randomized controlled trial") return 4;
    if (["quasi-experimental","did","diff-in-diff","difference-in-differences","iv","instrumental variable","instrumental variables","rdd","regression discontinuity","regression discontinuity design","matching","propensity score matching","synthetic control"].includes(s)) return 3;
    if (s === "review" || s === "systematic review" || s === "meta-analysis") return 3;
    if (s === "observational") return 2;
    if (s === "qualitative") return 2;
    return 1;
  }
  function sampleAdj(n, d) {
    if (n == null) return -1;
    if (n >= 5000) return 1;
    if (n >= 500) return 0;
    const isExp = d && ["rct","quasi-experimental","did","iv","rdd"].includes(d.toLowerCase());
    if (n >= 100) return isExp ? -1 : 0;
    return -2;
  }
  function isExplicit(v) {
    if (v == null) return false;
    const s = typeof v === "string" ? v : String(v);
    return s.trim().toLowerCase() !== "unclear";
  }
  function clarityAdj(dir, size, sig) {
    if (!isExplicit(dir)) return -2;
    if (isExplicit(dir) && isExplicit(size) && isExplicit(sig)) return 1;
    if (isExplicit(dir) && isExplicit(size)) return 0;
    return -1;
  }
  function controlAdj(t, c) {
    const tOk = isExplicit(t), cOk = isExplicit(c);
    if (tOk && cOk) return 0;
    if (tOk || cOk) return -1;
    return -2;
  }
  const score = baseDesign(study_design) + sampleAdj(sample_size, study_design) +
    clarityAdj(effect_direction, effect_size_text, statistical_significance) +
    controlAdj(treatment_group, control_group);
  const band = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  return { score, band };
}

// ---------------------------------------------------------------------------
// Direction normalization (mirrors extraction.ts normalizeDirection)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Extraction prompts — all loaded from shared extractionPrompt.ts at startup
// ---------------------------------------------------------------------------
const EXTRACTION_SYSTEM = SHARED.system;
const VERIFICATION_SYSTEM = SHARED.verification;

function buildExtractionPrompt(title, abstract, methodologyDesign, resultsChunk, conclusionChunk) {
  const tier2 = resultsChunk || conclusionChunk;
  return `${SHARED.fewShots}

NOW EXTRACT FOR THIS PAPER:

Title: ${title}
Abstract: ${abstract}
${tier2 ? `Results section: ${resultsChunk ?? "(not available)"}\nConclusion section: ${conclusionChunk ?? "(not available)"}` : ""}
Methodology design (pre-classified, may be wrong): ${methodologyDesign ?? "unknown"}

Extract the evidence card. Output JSON only.`;
}

function buildVerificationPrompt(card, sourceText) {
  return `source_text: "${String(sourceText).replace(/"/g, '\\"')}"

extracted_card: ${JSON.stringify(card, null, 2)}

Verify and output JSON: {"valid": boolean, "issues": ["..."]}`;
}

// ---------------------------------------------------------------------------
// Critical fields check (mirrors extraction.ts)
// ---------------------------------------------------------------------------
function criticalFieldsMissing(card, design) {
  if (!card.effect_size_text) return true;
  if (card.treatment_group === "unclear" || card.control_group === "unclear") return true;
  if ((design === "RCT" || design === "quasi-experimental") && !card.statistical_significance) return true;
  if (card.effect_direction === "unclear") return true;
  return false;
}

// ---------------------------------------------------------------------------
// PDF chunk fetching (simplified — no pdf-parse, just marks tier 2 unavailable)
// This worker version skips PDF parsing in v1; Tier 2 is handled by future enhancement.
// Papers that need Tier 2 get confidence: low and needs_review: true.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------
async function claimBatch() {
  const { data, error } = await supabase.rpc("claim_extraction_batch", { batch_size: BATCH_SIZE });
  if (error) throw new Error(`claim_extraction_batch error: ${error.message}`);
  return data ?? [];
}

async function fetchWork(workId) {
  const { data, error } = await supabase
    .from("works")
    .select("id, title, abstract, methodology_design, open_access_pdf_url")
    .eq("id", workId)
    .single();
  if (error || !data) throw new Error(`work not found: ${workId}`);
  return data;
}

async function upsertCard(card) {
  const { error } = await supabase.from("evidence_cards").upsert(
    {
      work_id: card.work_id,
      study_design: card.study_design,
      comparison_type: card.comparison_type,
      country: card.country,
      region: card.region,
      setting: card.setting,
      population_group: card.population_group,
      analysis_unit: card.analysis_unit,
      age_range: card.age_range,
      income_group: card.income_group,
      intervention: card.intervention,
      outcome: card.outcome,
      secondary_outcomes: card.secondary_outcomes,
      treatment_group: card.treatment_group,
      control_group: card.control_group,
      effect_direction: card.effect_direction,
      effect_size_text: card.effect_size_text,
      effect_size_numeric: card.effect_size_numeric,
      effect_type: card.effect_type,
      baseline_level: card.baseline_level,
      statistical_significance: card.statistical_significance,
      sample_size: card.sample_size,
      sample_size_text: card.sample_size_text,
      time_horizon: card.time_horizon,
      data_source: card.data_source,
      identification_strategy: card.identification_strategy,
      limitations: card.limitations,
      heterogeneity: card.heterogeneity,
      secondary_findings: card.secondary_findings,
      mechanism: card.mechanism,
      external_validity_note: card.external_validity_note,
      multi_finding_flag: card.multi_finding_flag,
      source_section: card.source_section,
      source_text: card.source_text,
      ungrounded_fields: card.ungrounded_fields,
      finding_short: card.finding_short,
      confidence: card.confidence,
      confidence_score: card.confidence_score,
      extracted_by: card.extracted_by,
      extraction_prompt_version: card.extraction_prompt_version,
      extraction_tier: card.extraction_tier,
      needs_review: card.needs_review,
      source_language: card.source_language,
    },
    { onConflict: "work_id" }
  );
  if (error) throw new Error(`upsert error: ${error.message}`);
}

async function logIssue(workId, issueType, details, cardId = null) {
  // Note: supabase-js v2 builders are thenables but do NOT support .catch().
  // Use try/catch so a logging failure can never abort the extraction flow.
  try {
    await supabase.from("extraction_issues").insert({
      work_id: workId,
      card_id: cardId,
      issue_type: issueType,
      details,
    });
  } catch (err) {
    console.error(`[worker] logIssue failed for ${workId}: ${err.message}`);
  }
}

async function markDone(workId) {
  await supabase.from("extraction_queue").update({
    state: "done",
    completed_at: new Date().toISOString(),
  }).eq("work_id", workId);
}

async function markFailed(workId, errorMsg) {
  await supabase.from("extraction_queue").update({
    state: "failed",
    last_error: errorMsg,
    completed_at: new Date().toISOString(),
  }).eq("work_id", workId);
}

async function releaseToQueue(workId, errorMsg) {
  await supabase.from("extraction_queue").update({
    state: "queued",
    last_error: errorMsg,
    started_at: null,
  }).eq("work_id", workId);
}

// ---------------------------------------------------------------------------
// Process one paper
// ---------------------------------------------------------------------------
async function processOne(row) {
  const work = await fetchWork(row.work_id);
  if (!work.title || !work.abstract) {
    await logIssue(row.work_id, "thin_abstract", { note: "missing title or abstract" });
    await markFailed(row.work_id, "missing title or abstract");
    return;
  }

  // Tier 1 extraction
  let raw;
  try {
    raw = await qwenGenerateJSON(
      buildExtractionPrompt(work.title, work.abstract, work.methodology_design, null, null),
      { system: EXTRACTION_SYSTEM, numCtx: 16384, temperature: 0.1 }
    );
  } catch (err) {
    throw new Error(`Extraction call failed: ${err.message}`);
  }

  let tier = 1;

  // Note: Tier 2 (PDF fetching + pdf-parse) is not implemented in V1 worker.
  // Papers with missing critical fields get confidence: low and needs_review: true.
  // Tier 2 can be enabled later by adding pdf-parse dependency and implementing fetchAndChunkPdf here.

  // Confidence scoring
  const conf = deriveConfidence({
    study_design: raw.study_design,
    sample_size: raw.sample_size,
    effect_direction: raw.effect_direction,
    effect_size_text: raw.effect_size_text,
    statistical_significance: raw.statistical_significance,
    treatment_group: raw.treatment_group,
    control_group: raw.control_group,
  });

  let needs_review = conf.band === "low";

  // Two-pass verification
  try {
    const verify = await qwenGenerateJSON(
      buildVerificationPrompt(raw, raw.source_text ?? ""),
      { system: VERIFICATION_SYSTEM, numCtx: 8192, temperature: 0 }
    );
    if (!verify.valid) {
      needs_review = true;
      await logIssue(row.work_id, "verification_failed", { issues: verify.issues });
    }
  } catch {
    needs_review = true;
  }

  if (conf.band === "low") {
    await logIssue(row.work_id, "low_confidence", { score: conf.score });
  }

  const card = {
    ...raw,
    effect_direction: normalizeDirection(raw.effect_direction),
    work_id: row.work_id,
    confidence: conf.band,
    confidence_score: conf.score,
    extracted_by: QWEN_MODEL,
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
    extraction_tier: tier,
    needs_review,
    source_language: detectLanguage(work.abstract),
  };

  await upsertCard(card);
  await markDone(row.work_id);
  console.log(`[worker] OK ${row.work_id} tier=${tier} confidence=${conf.band}`);
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
async function heartbeatLoop() {
  while (running) {
    try {
      await supabase.from("worker_heartbeat").upsert({
        worker_id: WORKER_ID,
        last_seen: new Date().toISOString(),
        hostname: hostname(),
        pid,
      }, { onConflict: "worker_id" });
    } catch {}
    // Sleep in 1s slices so SIGTERM/SIGINT exit within ~1s instead of HEARTBEAT_MS.
    for (let elapsed = 0; elapsed < HEARTBEAT_MS && running; elapsed += 1000) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function mainLoop() {
  console.log(`[worker ${WORKER_ID}] starting — batch=${BATCH_SIZE} max_attempts=${MAX_ATTEMPTS}`);
  heartbeatLoop(); // fire-and-forget background heartbeat

  while (running) {
    let batch;
    try {
      batch = await claimBatch();
    } catch (err) {
      console.error("[worker] claim error:", err.message);
      await new Promise(r => setTimeout(r, POLL_MS * 5));
      continue;
    }

    if (batch.length === 0) {
      await new Promise(r => setTimeout(r, POLL_MS));
      continue;
    }

    await Promise.allSettled(
      batch.map(async (row) => {
        try {
          await processOne(row);
        } catch (err) {
          console.error(`[worker] FAIL ${row.work_id}:`, err.message);
          if (row.attempts >= MAX_ATTEMPTS) {
            await markFailed(row.work_id, err.message);
          } else {
            await releaseToQueue(row.work_id, err.message);
          }
        }
      })
    );
  }
  console.log(`[worker ${WORKER_ID}] stopped`);
}

mainLoop();
