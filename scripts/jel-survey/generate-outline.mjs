// scripts/jel-survey/generate-outline.mjs
//
// Generate a JEL survey outline from a pinned query in
// evals/jel-survey-queries.json. Calls Gemini via the v1beta REST API.
// Validates the response against the outline gate (≥7 sections, ≤12,
// sec 1 covers intro+prior-surveys, last section is research agenda,
// targetWords sums to 15-20k).
//
// Usage:
//   node scripts/jel-survey/generate-outline.mjs --query <id> [--dry-run] [--out <path>]
//
// Env:
//   GEMINI_API_KEY  required unless --dry-run

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { buildOutlinePrompt } from "./outline-prompt.mjs";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const FIXTURE_PATH = resolve(ROOT, "evals/jel-survey-queries.json");
const GEMINI_MODEL = process.env.GEMINI_OUTLINE_MODEL ?? "gemini-2.5-flash";
const QWEN_SYNTH_MODEL = process.env.QWEN_SYNTH_OUTLINE_MODEL ?? "qwen2.5:14b-synthesis";

// --model alias → backend dispatcher. New models added here.
const MODEL_ALIASES = {
  gemini: { backend: "gemini", id: GEMINI_MODEL },
  "qwen-14b-synth": { backend: "litellm", id: QWEN_SYNTH_MODEL },
};

function parseArgs(argv) {
  const args = { model: "gemini" };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--query") { args.queryId = next; i++; }
    else if (flag === "--model") { args.model = next; i++; }
    else if (flag === "--out") { args.out = next; i++; }
    else if (flag === "--dry-run") { args.dryRun = true; }
    else if (flag === "--help" || flag === "-h") { args.help = true; }
  }
  return args;
}

function usage() {
  console.log(`
Usage: node scripts/jel-survey/generate-outline.mjs --query <id> [--model <alias>] [--dry-run] [--out <path>]

Flags:
  --query <id>   Query ID from evals/jel-survey-queries.json
  --model <alias>  Model alias. One of: ${Object.keys(MODEL_ALIASES).join(", ")} (default: gemini)
  --dry-run      Print the assembled prompt and exit (no model call)
  --out <path>   Write the outline JSON to a file (default: stdout)
  --help, -h     Show this message

Env:
  GEMINI_API_KEY              required for --model gemini
  LLM_API_KEY + LLM_BASE_URL  required for --model qwen-14b-synth
  GEMINI_OUTLINE_MODEL        default ${GEMINI_MODEL}
  QWEN_SYNTH_OUTLINE_MODEL    default ${QWEN_SYNTH_MODEL}
`);
}

async function loadQuery(queryId) {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw);
  const q = fixture.queries.find((x) => x.id === queryId);
  if (!q) {
    const ids = fixture.queries.map((x) => x.id).join(", ");
    throw new Error(`Unknown query "${queryId}". Available: ${ids}`);
  }
  return q;
}

async function callGemini({ system, user }, modelId) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env or run with --dry-run to inspect the prompt.",
    );
  }
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gemini ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) {
    throw new Error(`Gemini returned no text. Full response: ${JSON.stringify(data).slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini returned non-JSON. First 400 chars: ${text.slice(0, 400)}`);
  }
}

async function callLiteLLM({ system, user }, modelId) {
  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL;
  if (!key || !base) {
    throw new Error(
      "LLM_API_KEY and LLM_BASE_URL are required for LiteLLM models. Check .env.",
    );
  }
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LiteLLM ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error(`LiteLLM returned no text. Full response: ${JSON.stringify(data).slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`LiteLLM returned non-JSON. First 400 chars: ${text.slice(0, 400)}`);
  }
}

async function callModel(modelAlias, prompt) {
  const spec = MODEL_ALIASES[modelAlias];
  if (!spec) {
    throw new Error(
      `Unknown model alias "${modelAlias}". Available: ${Object.keys(MODEL_ALIASES).join(", ")}`,
    );
  }
  if (spec.backend === "gemini") return callGemini(prompt, spec.id);
  if (spec.backend === "litellm") return callLiteLLM(prompt, spec.id);
  throw new Error(`No backend handler for "${spec.backend}".`);
}

// Acceptance gate from Phase 1 plan: ≥7 sections, ≤12, sec 1 covers
// intro+prior-surveys, last is research agenda, total targetWords 15-20k.
function validateOutline(outline) {
  const errors = [];
  if (!outline || typeof outline !== "object") {
    errors.push("Outline is not an object.");
    return errors;
  }
  if (typeof outline.title !== "string" || outline.title.length < 8) {
    errors.push("Missing or too-short title.");
  }
  if (typeof outline.abstract !== "string" || outline.abstract.split(/\s+/).length < 50) {
    errors.push("Abstract must be at least ~50 words (4-6 sentences).");
  }
  if (!Array.isArray(outline.sections)) {
    errors.push("Missing sections array.");
    return errors;
  }
  if (outline.sections.length < 7) errors.push(`Only ${outline.sections.length} sections (need ≥7).`);
  if (outline.sections.length > 12) errors.push(`${outline.sections.length} sections (max 12).`);

  for (const [i, s] of outline.sections.entries()) {
    if (!s.number) errors.push(`Section ${i}: missing number.`);
    if (typeof s.heading !== "string" || s.heading.length < 4) {
      errors.push(`Section ${s.number ?? i}: missing or short heading.`);
    }
    if (typeof s.scope !== "string" || s.scope.split(/\s+/).length < 15) {
      errors.push(`Section ${s.number ?? i}: scope too short (need 2-3 sentences).`);
    }
    if (typeof s.targetWords !== "number" || s.targetWords < 400 || s.targetWords > 4000) {
      errors.push(`Section ${s.number ?? i}: targetWords out of plausible range (400-4000).`);
    }
    if (!Array.isArray(s.expectedDesigns) || s.expectedDesigns.length === 0) {
      errors.push(`Section ${s.number ?? i}: expectedDesigns is empty.`);
    }
  }

  const total = outline.sections.reduce((acc, s) => acc + (s.targetWords ?? 0), 0);
  if (total < 14_000 || total > 21_000) {
    errors.push(`Total targetWords = ${total}; expected 15,000-20,000.`);
  }

  // Sec 1: intro + prior surveys
  const first = outline.sections[0];
  if (first) {
    const h = (first.heading + " " + (first.scope ?? "")).toLowerCase();
    const introHit = /intro|prior surv|positioning|prior literat|previous review|earlier review/.test(h);
    if (!introHit) {
      errors.push(`Section 1 heading/scope doesn't reference intro or prior surveys: "${first.heading}"`);
    }
  }

  // Last: research agenda
  const last = outline.sections[outline.sections.length - 1];
  if (last) {
    const h = (last.heading + " " + (last.scope ?? "")).toLowerCase();
    const agendaHit = /research agenda|research frontier|open question|future research|directions|where the literature goes|priorities for/.test(h);
    if (!agendaHit) {
      errors.push(`Last section doesn't reference a research agenda: "${last.heading}"`);
    }
  }

  return errors;
}

function summarize(outline) {
  const lines = [];
  lines.push(`Title: ${outline.title}`);
  lines.push(`Abstract: ${outline.abstract.slice(0, 200)}${outline.abstract.length > 200 ? "..." : ""}`);
  lines.push("");
  lines.push("Sections:");
  let total = 0;
  for (const s of outline.sections) {
    total += s.targetWords ?? 0;
    const designs = Array.isArray(s.expectedDesigns) && s.expectedDesigns.length > 0
      ? s.expectedDesigns.join("/")
      : "(none)";
    const num = String(s.number ?? "?").padEnd(4);
    lines.push(`  ${num} ${s.heading ?? "(missing heading)"}  [${s.targetWords ?? 0}w, designs: ${designs}]`);
    lines.push(`        ${s.scope ?? "(missing scope)"}`);
  }
  lines.push("");
  lines.push(`Total target: ${total.toLocaleString()} words across ${outline.sections.length} sections`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }
  if (!args.queryId) { usage(); process.exit(1); }

  const q = await loadQuery(args.queryId);
  const prompt = buildOutlinePrompt({
    query: q.query,
    topics: q.filters?.topics ?? [],
    regions: q.filters?.regions ?? [],
    intent: q.intent ?? "",
  });

  if (args.dryRun) {
    console.log("=== SYSTEM ===\n" + prompt.system);
    console.log("\n=== USER ===\n" + prompt.user);
    console.log("\n(Dry run — no Gemini call. Re-run without --dry-run to actually generate.)");
    return;
  }

  const spec = MODEL_ALIASES[args.model];
  if (!spec) {
    console.error(`Unknown --model "${args.model}". Available: ${Object.keys(MODEL_ALIASES).join(", ")}`);
    process.exit(1);
  }
  const t0 = Date.now();
  console.log(`[outline-gen] Calling ${spec.id} (alias=${args.model}) for query="${args.queryId}"`);
  const outline = await callModel(args.model, prompt);
  const elapsedMs = Date.now() - t0;
  console.log(`[outline-gen] Completed in ${(elapsedMs / 1000).toFixed(1)}s`);

  const errors = validateOutline(outline);
  if (errors.length > 0) {
    console.error("\n[outline-gen] VALIDATION ERRORS:");
    for (const e of errors) console.error("  - " + e);
    console.error("\nOutline produced anyway — review above and decide whether to keep:\n");
  } else {
    console.log("[outline-gen] All validation checks passed.\n");
  }

  console.log(summarize(outline));

  if (args.out) {
    const path = resolve(ROOT, args.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(outline, null, 2));
    console.log(`\n[outline-gen] Wrote outline to ${path}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
