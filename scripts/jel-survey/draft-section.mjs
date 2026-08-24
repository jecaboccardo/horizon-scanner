// scripts/jel-survey/draft-section.mjs
//
// JEL Skill #4 — Section Drafter.
//
// For a pinned JEL query + completed outline, drafts ONE section (or all
// sections sequentially) using Gemini (default) or qwen2.5:14b-synth (A/B).
// Reads the coding sheet from skill #2 to pick evidence, anchors voice on
// one of the topic's prioritized JEL exemplars, runs the result through the
// shared citation normalizer to recover [ss:DIGITS] mangling, and writes a
// drafted-section JSON to reports/.
//
// Usage:
//   node scripts/jel-survey/draft-section.mjs --query <id> --section <n>
//   node scripts/jel-survey/draft-section.mjs --query <id> --all-sections
//   node scripts/jel-survey/draft-section.mjs --query <id> --section 5 --model qwen-14b-synth
//
// Inputs (auto-discovered from latest dated file in reports/):
//   reports/outline-<query>-<date>-v2.json    (latest -v2 outline)
//   reports/evidence-coding-<query>-<date>.json (latest coding sheet)
//
// Override with --outline <path> / --coding <path> if needed.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { buildSectionPrompt } from "./section-prompt.mjs";

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const FIXTURE_PATH = resolve(ROOT, "evals/jel-survey-queries.json");
const REPORTS_DIR = resolve(ROOT, "reports");
const EXEMPLAR_DIR = resolve(ROOT, "evals/jel-exemplars");

const GEMINI_MODEL = process.env.GEMINI_DRAFT_MODEL ?? "gemini-2.5-flash";
const QWEN_SYNTH_MODEL = process.env.QWEN_SYNTH_MODEL ?? "qwen2.5:14b-synthesis";

const MODEL_ALIASES = {
  gemini: { backend: "gemini", id: GEMINI_MODEL },
  "qwen-14b-synth": { backend: "litellm", id: QWEN_SYNTH_MODEL },
};

// Cap evidence in prompt to keep tokens manageable. JEL sections cite 10-30
// papers; 25 with full card detail = ~6k input tokens, leaving plenty for the
// voice anchor + output. qwen-14b-synth gets a tighter cap because its 8k
// max_tokens output ceiling truncates JSON on long prompts (observed
// 2026-05-20 — body field came back undefined on 25-row prompts).
const EVIDENCE_CAP_GEMINI = 25;
const EVIDENCE_CAP_QWEN = 15;
// Voice anchor word count. ~1500 words = ~2k tokens. Enough for two solid
// example paragraphs. qwen gets a shorter anchor too.
const VOICE_ANCHOR_WORDS_GEMINI = 1500;
const VOICE_ANCHOR_WORDS_QWEN = 800;

function parseArgs(argv) {
  const out = {
    queryId: null, section: null, allSections: false, model: "gemini",
    outline: null, coding: null, context: null, outDir: REPORTS_DIR, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--query") { out.queryId = next; i++; }
    else if (flag === "--section") { out.section = next; i++; }
    else if (flag === "--all-sections") { out.allSections = true; }
    else if (flag === "--model") { out.model = next; i++; }
    else if (flag === "--outline") { out.outline = resolve(next); i++; }
    else if (flag === "--coding") { out.coding = resolve(next); i++; }
    else if (flag === "--context") { out.context = resolve(next); i++; }
    else if (flag === "--out-dir") { out.outDir = resolve(next); i++; }
    else if (flag === "--help" || flag === "-h") { out.help = true; }
  }
  return out;
}

function usage() {
  console.log(`
Usage: node scripts/jel-survey/draft-section.mjs --query <id> --section <n> [--model gemini]
       node scripts/jel-survey/draft-section.mjs --query <id> --all-sections [--model gemini]

Flags:
  --query <id>         Query id from evals/jel-survey-queries.json
  --section <n>        Section number ("1", "2.1", etc.) from the outline
  --all-sections       Draft all sections sequentially
  --model <alias>      ${Object.keys(MODEL_ALIASES).join(" | ")} (default: gemini)
  --outline <path>     Override outline JSON path (default: latest -v2 in reports/)
  --coding <path>      Override coding sheet path (default: latest in reports/)
  --out-dir <path>     Override output dir (default: reports/)
  --help, -h           Show this message
`);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function findLatest(prefix, suffix = ".json") {
  const entries = await readdir(REPORTS_DIR).catch(() => []);
  const matches = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .reverse();
  return matches.length > 0 ? resolve(REPORTS_DIR, matches[0]) : null;
}

async function loadOutline(queryId, override) {
  const path = override ?? await findLatest(`outline-${queryId}-`, "-v2.json")
    ?? await findLatest(`outline-${queryId}-`, ".json");
  if (!path) throw new Error(`No outline found for ${queryId}. Run generate-outline.mjs first.`);
  console.log(`[draft] outline: ${basename(path)}`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function loadCodingSheet(queryId, override) {
  const path = override ?? await findLatest(`evidence-coding-${queryId}-`);
  if (!path) throw new Error(`No coding sheet for ${queryId}. Run build-evidence-coding.mjs first.`);
  console.log(`[draft] coding sheet: ${basename(path)}`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function loadQuery(queryId) {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const q = fixture.queries.find((x) => x.id === queryId);
  if (!q) {
    const ids = fixture.queries.map((x) => x.id).join(", ");
    throw new Error(`Unknown query "${queryId}". Available: ${ids}`);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Voice anchor — load first exemplar from query.exemplarPriority
// ---------------------------------------------------------------------------

const EXEMPLAR_LABELS = {
  "list-experiments-children.txt": "List, Petrie & Samek, JEL 61(2) 2023",
  "korinek-generative-ai.txt": "Korinek, JEL 61(4) 2023",
  "shy-cash-alive.txt": "Shy, JEL 61(4) 2023",
  "acemoglu-restrepo-automation.txt": "Acemoglu & Restrepo, JEL (2019)",
  "globalization-inequality-lac.txt": "JEL survey on Globalization and Inequality in LAC",
  "chetty-mobility.txt": "Chetty et al., mobility/empirical-methodology voice",
  "duflo.txt": "Duflo, experimental development economics voice",
};

async function loadVoiceAnchor(query, anchorWords) {
  const list = query.exemplarPriority ?? [];
  for (const filename of list) {
    const path = resolve(EXEMPLAR_DIR, filename);
    try {
      const raw = await readFile(path, "utf8");
      const words = raw.split(/\s+/);
      // Skip front-matter (JSTOR boilerplate), take a slice from words 200 onward.
      const slice = words.slice(200, 200 + anchorWords).join(" ");
      const label = EXEMPLAR_LABELS[filename] ?? filename;
      console.log(`[draft] voice anchor: ${label} (${slice.split(/\s+/).length} words)`);
      return { text: slice, title: label };
    } catch (err) {
      // try next
    }
  }
  return { text: "(no exemplar available)", title: "(none)" };
}

// ---------------------------------------------------------------------------
// Evidence selection per section
// ---------------------------------------------------------------------------

function normalizeDesign(raw) {
  if (!raw) return "unknown";
  const s = String(raw).trim().toLowerCase();
  if (s === "rct" || s.includes("random")) return "RCT";
  if (s === "did" || s.includes("difference-in-differences") || s.includes("difference in differences")) return "DiD";
  if (s === "iv" || s.includes("instrumental")) return "IV";
  if (s === "rdd" || s.includes("regression discontinuity")) return "RDD";
  if (s.includes("quasi")) return "quasi-experimental";
  if (s.includes("matching") || s.includes("propensity")) return "matching";
  if (s.includes("observ")) return "observational";
  if (s.includes("qualitative")) return "qualitative";
  if (s.includes("review") || s.includes("meta")) return "review";
  if (s.includes("simulation") || s.includes("structural")) return "structural";
  if (s.includes("theor")) return "theoretical";
  if (s.includes("descriptive")) return "descriptive";
  return s;
}

function pickEvidenceForSection(sheet, section, cap) {
  const wanted = new Set((section.expectedDesigns ?? []).map(normalizeDesign));
  const papers = sheet.papers ?? [];
  // Score: prefer (a) design match, (b) has card, (c) higher SMS, (d) newer.
  const scored = papers.map((p) => {
    const d = normalizeDesign(p.card?.design ?? p.methodologyDesign);
    const designMatch = wanted.has(d) ? 1 : 0;
    return {
      p,
      score:
        designMatch * 100 +
        (p.hasCard ? 30 : 0) +
        (p.smsLevel ?? 0) * 5 +
        (p.year ? Math.min((p.year - 2000), 30) : 0) / 10,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  // If we have ≥10 design-matched papers, return only those; else include
  // top fallbacks so the section isn't starved.
  const designMatched = scored.filter((x) => wanted.has(normalizeDesign(x.p.card?.design ?? x.p.methodologyDesign)));
  const chosen = designMatched.length >= 10
    ? designMatched.slice(0, cap)
    : scored.slice(0, cap);
  return chosen.map((x) => x.p);
}

// ---------------------------------------------------------------------------
// Citation normalizer (mirror of supabase/functions/_shared/citationNormalizer.ts)
// ---------------------------------------------------------------------------
//
// Duplicated in Node so the drafter doesn't depend on the Deno backend. Same
// patterns, same drop-vs-rewrite policy. Keep in sync with the .ts file.

const NBER_RE = /^10\.3386\/w(\d+)$/i;
const SSRN_RE = /^10\.2139\/ssrn\.(\d+)$/i;
const DOI_RE = /^10\.[^/]+\/.+/i;
const MANGLED_RE = /\[ss:(\d+(?:\/[^\]\s]+)?)\]/g;

function buildSuffixIndex(evidenceRows) {
  const index = new Map();
  for (const p of evidenceRows) {
    const id = p?.workId;
    if (!id) continue;
    const add = (key) => {
      const arr = index.get(key);
      if (arr) { if (!arr.includes(id)) arr.push(id); }
      else { index.set(key, [id]); }
    };
    if (DOI_RE.test(id)) add(id.slice(3));
    const nber = id.match(NBER_RE);
    if (nber) add(nber[1]);
    const ssrn = id.match(SSRN_RE);
    if (ssrn) add(ssrn[1]);
  }
  return index;
}

function normalizeCitations(text, evidence) {
  if (!text) return { text, stats: { rewritten: 0, dropped: 0, ambiguous: 0 } };
  const index = buildSuffixIndex(evidence);
  if (index.size === 0) return { text, stats: { rewritten: 0, dropped: 0, ambiguous: 0 } };
  const stats = { rewritten: 0, dropped: 0, ambiguous: 0 };
  let dropped = false;
  const out = text.replace(MANGLED_RE, (_m, body) => {
    const matches = index.get(body);
    if (!matches || matches.length === 0) { stats.dropped++; dropped = true; return ""; }
    if (matches.length > 1) { stats.ambiguous++; dropped = true; return ""; }
    stats.rewritten++;
    return `[${matches[0]}]`;
  });
  const cleaned = dropped
    ? out.replace(/\s+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ")
    : out;
  return { text: cleaned, stats };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDraft(draft, evidence, targetWords) {
  const errors = [];
  const warnings = [];
  if (!draft || typeof draft !== "object") { errors.push("Draft is not an object."); return { errors, warnings }; }
  if (typeof draft.body !== "string" || draft.body.length < 200) {
    errors.push("body is missing or too short.");
  }
  const allowedIds = new Set(evidence.map((p) => p.workId));
  const cited = new Set();
  for (const m of (draft.body ?? "").matchAll(/\[([^\]\s][^\]]{1,120})\]/g)) {
    const id = m[1].trim();
    cited.add(id);
  }
  const invalid = [...cited].filter((id) => !allowedIds.has(id) && !id.startsWith("ss:"));
  if (invalid.length > 0) {
    warnings.push(`Citations not in evidence (${invalid.length}): ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? "..." : ""}`);
  }
  if (Array.isArray(draft.citedWorkIds)) {
    const stale = draft.citedWorkIds.filter((id) => !allowedIds.has(id));
    if (stale.length > 0) warnings.push(`citedWorkIds has ${stale.length} entries not in evidence.`);
  }
  const actualWords = (draft.body ?? "").trim().split(/\s+/).filter(Boolean).length;
  const lo = Math.floor(targetWords * 0.6);
  const hi = Math.ceil(targetWords * 1.4);
  if (actualWords < lo) warnings.push(`Word count ${actualWords} < 60% of target ${targetWords}.`);
  if (actualWords > hi) warnings.push(`Word count ${actualWords} > 140% of target ${targetWords}.`);
  return { errors, warnings, actualWords, invalidCitations: invalid, validCitations: [...cited].filter((id) => allowedIds.has(id)) };
}

// ---------------------------------------------------------------------------
// Model callers (mirrors generate-outline.mjs)
// ---------------------------------------------------------------------------

async function callGemini({ system, user }, modelId) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gemini ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? "").join("") ?? "";
  if (!text) throw new Error(`Gemini returned no text. finish=${data?.candidates?.[0]?.finishReason}.`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini returned non-JSON. First 400: ${text.slice(0, 400)}`);
  }
}

async function callLiteLLM({ system, user }, modelId) {
  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL;
  if (!key || !base) throw new Error("LLM_API_KEY and LLM_BASE_URL required.");
  const url = `${base.replace(/\/+$/, "")}/v1/chat/completions`;
  const body = {
    model: modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
    max_tokens: 8192,
    response_format: { type: "json_object" },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LiteLLM ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("LiteLLM returned no text.");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`LiteLLM returned non-JSON. First 400: ${text.slice(0, 400)}`);
  }
}

async function callModel(alias, prompt) {
  const spec = MODEL_ALIASES[alias];
  if (!spec) throw new Error(`Unknown model alias "${alias}".`);
  if (spec.backend === "gemini") return { model: spec.id, draft: await callGemini(prompt, spec.id) };
  if (spec.backend === "litellm") return { model: spec.id, draft: await callLiteLLM(prompt, spec.id) };
  throw new Error(`No backend for "${spec.backend}".`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function draftOne({ outline, section, sheet, query, exemplar, priorSections, modelAlias, context }) {
  const evidenceCap = modelAlias === "qwen-14b-synth" ? EVIDENCE_CAP_QWEN : EVIDENCE_CAP_GEMINI;
  const evidence = pickEvidenceForSection(sheet, section, evidenceCap);
  console.log(`[draft] section ${section.number} (${section.heading}): ${evidence.length} evidence rows${context?.length ? `, ${context.length} context entries` : ""}, ${section.targetWords}w target`);

  const prompt = buildSectionPrompt({
    outline, section, evidence,
    exemplarText: exemplar.text,
    exemplarTitle: exemplar.title,
    priorSections,
    context: context ?? [],
  });

  const t0 = Date.now();
  let model, draft;
  try {
    ({ model, draft } = await callModel(modelAlias, prompt));
  } catch (err) {
    console.error(`[draft]   ${modelAlias} threw: ${err.message?.slice(0, 300)}`);
    throw err;
  }
  const elapsedMs = Date.now() - t0;
  console.log(`[draft]   ${model} returned in ${(elapsedMs / 1000).toFixed(1)}s`);

  // qwen-14b-synth sometimes wraps body in alternate keys when prompts are
  // long. Coerce a few common synonyms before validation.
  if (typeof draft?.body !== "string") {
    for (const altKey of ["text", "content", "prose", "draftBody", "section_body"]) {
      if (typeof draft?.[altKey] === "string" && draft[altKey].length > 0) {
        console.log(`[draft]   coerced body from alternate key "${altKey}"`);
        draft.body = draft[altKey];
        break;
      }
    }
  }
  if (typeof draft?.body !== "string" || draft.body.length < 200) {
    const keys = draft && typeof draft === "object" ? Object.keys(draft) : [];
    console.error(`[draft]   raw response has no body. Top-level keys: [${keys.join(", ")}]. Raw (first 600): ${JSON.stringify(draft)?.slice(0, 600)}`);
  }

  // Normalize citations: rewrite [ss:DIGITS] → [canonical workId] from evidence.
  if (typeof draft.body === "string") {
    const norm = normalizeCitations(draft.body, evidence);
    if (norm.stats.rewritten || norm.stats.dropped || norm.stats.ambiguous) {
      console.log(`[draft]   citation normalize: rewritten=${norm.stats.rewritten} dropped=${norm.stats.dropped} ambiguous=${norm.stats.ambiguous}`);
    }
    draft.body = norm.text;
  }

  const v = validateDraft(draft, evidence, section.targetWords);
  for (const e of v.errors) console.error(`[draft]   ERROR: ${e}`);
  for (const w of v.warnings) console.warn(`[draft]   WARN: ${w}`);

  return {
    queryId: query.id,
    searchRunId: sheet.searchRunId,
    sectionNumber: section.number,
    heading: section.heading,
    scope: section.scope,
    targetWords: section.targetWords,
    expectedDesigns: section.expectedDesigns,
    evidenceCount: evidence.length,
    evidenceUsedWorkIds: evidence.map((p) => p.workId),
    model,
    elapsedMs,
    draftBody: draft.body,
    actualWords: v.actualWords,
    citedWorkIds: v.validCitations ?? draft.citedWorkIds ?? [],
    invalidCitations: v.invalidCitations ?? [],
    uncoveredAreas: draft.uncoveredAreas ?? [],
    validationErrors: v.errors,
    validationWarnings: v.warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.queryId || (!args.section && !args.allSections)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!MODEL_ALIASES[args.model]) {
    console.error(`Unknown --model "${args.model}". Available: ${Object.keys(MODEL_ALIASES).join(", ")}`);
    process.exit(1);
  }

  const query = await loadQuery(args.queryId);
  const outline = await loadOutline(args.queryId, args.outline);
  const sheet = await loadCodingSheet(args.queryId, args.coding);
  const anchorWords = args.model === "qwen-14b-synth" ? VOICE_ANCHOR_WORDS_QWEN : VOICE_ANCHOR_WORDS_GEMINI;
  const exemplar = await loadVoiceAnchor(query, anchorWords);
  let context = [];
  if (args.context) {
    const ctxJson = JSON.parse(await readFile(args.context, "utf8"));
    context = ctxJson?.topics ?? [];
    console.log(`[draft] loaded ${context.length} context entries from ${args.context}`);
  }

  const sectionsToDraft = args.allSections
    ? outline.sections
    : outline.sections.filter((s) => String(s.number) === String(args.section));
  if (sectionsToDraft.length === 0) {
    console.error(`No section "${args.section}" in outline. Available: ${outline.sections.map((s) => s.number).join(", ")}`);
    process.exit(1);
  }

  await mkdir(args.outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const priorSections = [];
  for (const section of sectionsToDraft) {
    const out = await draftOne({
      outline, section, sheet, query, exemplar,
      priorSections: priorSections.slice(0, 3), // cap prior context
      modelAlias: args.model,
      context,
    });
    const outPath = resolve(args.outDir, `section-${args.queryId}-${section.number}-${today}.json`);
    await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
    console.log(`[draft]   wrote ${outPath} (${out.actualWords}w, ${out.citedWorkIds.length} citations)`);
    priorSections.push({
      number: section.number,
      heading: section.heading,
      summary: (out.draftBody ?? "").slice(0, 600),
    });
  }

  console.log(`\nDone. Drafted ${sectionsToDraft.length} section${sectionsToDraft.length !== 1 ? "s" : ""}.`);
}

main().catch((err) => {
  console.error("[draft] fatal:", err.message ?? err);
  process.exit(1);
});
