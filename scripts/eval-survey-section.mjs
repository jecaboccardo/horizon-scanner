// scripts/eval-survey-section.mjs
// Phase 0 stub for the Full JEL Article eval harness.
// Loads a canonical query fixture, finds the requested query and section,
// loads the prioritized exemplars from evals/jel-exemplars/, and prints
// the run plan. No model calls yet — Phase 1 will wire those in.
//
// Usage:
//   node scripts/eval-survey-section.mjs --query <id> --section <name> [--model gemini]
//   node scripts/eval-survey-section.mjs --list
//   node scripts/eval-survey-section.mjs --help

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE_PATH = resolve(ROOT, "evals/jel-survey-queries.json");
const EXEMPLAR_DIR = resolve(ROOT, "evals/jel-exemplars");

function parseArgs(argv) {
  const args = { model: "gemini" };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--query") { args.queryId = next; i++; }
    else if (flag === "--section") { args.section = next; i++; }
    else if (flag === "--model") { args.model = next; i++; }
    else if (flag === "--list") { args.list = true; }
    else if (flag === "--help" || flag === "-h") { args.help = true; }
  }
  return args;
}

function usage() {
  console.log(`
Usage: node scripts/eval-survey-section.mjs --query <id> --section <name> [--model gemini]
       node scripts/eval-survey-section.mjs --list

Flags:
  --query <id>      Query ID from evals/jel-survey-queries.json
  --section <name>  One of the $standard_sections from the fixture
  --model <name>    Target model (default: gemini)
  --list            List available queries and standard sections
  --help, -h        Show this message

Phase 0: validates the harness inputs (fixture parses, query exists, exemplars
load, search_run is pinned). No model call.

Phase 1 will:
  1. Resolve the pinned search_run_id and pull evidence rows
  2. Build the section prompt (outline scope + evidence + exemplar slot)
  3. Call the model
  4. Score: schema validity, citation grounding, ss: prefix rate, word count, voice
`);
}

async function loadFixture() {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw);
}

async function loadExemplars(filenames) {
  const out = [];
  for (const filename of filenames) {
    const path = resolve(EXEMPLAR_DIR, filename);
    try {
      const text = await readFile(path, "utf8");
      const words = text.split(/\s+/).filter(Boolean).length;
      out.push({ filename, path, words, present: true });
    } catch (err) {
      out.push({ filename, path, words: 0, present: false, error: err.message });
    }
  }
  return out;
}

function checkSection(fixture, section) {
  const known = fixture.$standard_sections ?? [];
  if (!known.includes(section)) {
    return {
      ok: false,
      message: `Unknown section "${section}". Standard sections:\n  - ${known.join("\n  - ")}`,
    };
  }
  return { ok: true };
}

async function listAll() {
  const fixture = await loadFixture();
  console.log("Available queries:");
  for (const q of fixture.queries) {
    const pinned = q.pinnedSearchRunId ? `pinned=${q.pinnedSearchRunId}` : "NOT PINNED";
    console.log(`  - ${q.id} [${pinned}]`);
    console.log(`      ${q.query}`);
  }
  console.log("\nStandard sections:");
  for (const s of fixture.$standard_sections ?? []) {
    console.log(`  - ${s}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  if (args.list) return listAll();

  if (!args.queryId || !args.section) {
    usage();
    process.exit(1);
  }

  const fixture = await loadFixture();
  const query = fixture.queries.find((q) => q.id === args.queryId);
  if (!query) {
    console.error(`Unknown query: ${args.queryId}`);
    console.error(`Run with --list to see available queries.`);
    process.exit(1);
  }

  const sectionCheck = checkSection(fixture, args.section);
  if (!sectionCheck.ok) {
    console.error(sectionCheck.message);
    process.exit(1);
  }

  const exemplars = await loadExemplars(query.exemplarPriority ?? []);
  const missingExemplars = exemplars.filter((e) => !e.present);
  const totalExemplarWords = exemplars
    .filter((e) => e.present)
    .reduce((acc, e) => acc + e.words, 0);

  console.log("=== Eval Harness: Survey Section (Phase 0 stub) ===");
  console.log(`Query ID:     ${query.id}`);
  console.log(`Question:     ${query.query}`);
  console.log(`Section:      ${args.section}`);
  console.log(`Model:        ${args.model}`);
  console.log(`Design prof:  ${query.designProfile ?? "(unspecified)"}`);
  console.log(`Citation prof: ${query.citationProfile ?? "(unspecified)"}`);
  console.log(`Filters:      ${JSON.stringify(query.filters ?? {})}`);
  console.log(`Pinned run:   ${query.pinnedSearchRunId ?? "NOT PINNED — Phase 1 cannot retrieve until pinned"}`);
  console.log("");
  console.log(`Exemplars (${exemplars.length} requested, ${exemplars.length - missingExemplars.length} present):`);
  for (const e of exemplars) {
    if (e.present) {
      console.log(`  OK   ${e.filename.padEnd(40)} ${e.words.toLocaleString()} words`);
    } else {
      console.log(`  MISS ${e.filename.padEnd(40)} ${e.error ?? ""}`);
    }
  }
  console.log(`Total exemplar corpus: ${totalExemplarWords.toLocaleString()} words`);
  console.log("");

  const blockers = [];
  if (!query.pinnedSearchRunId) blockers.push("search_run not pinned");
  if (missingExemplars.length > 0) {
    blockers.push(`${missingExemplars.length} exemplar(s) missing`);
  }

  if (blockers.length > 0) {
    console.log(`Blockers before Phase 1 can run a real eval:`);
    for (const b of blockers) console.log(`  - ${b}`);
  } else {
    console.log(`All inputs validated. Ready for Phase 1 model wiring.`);
  }

  console.log("");
  console.log(`Phase 1 will:`);
  console.log(`  1. Pull evidence rows from the pinned search_run`);
  console.log(`  2. Build the section prompt (outline scope + evidence + exemplar few-shot)`);
  console.log(`  3. Call ${args.model} for the section`);
  console.log(`  4. Score: schema validity, citation grounding, ss: prefix rate, word count, voice`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
