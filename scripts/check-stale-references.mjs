#!/usr/bin/env node
/**
 * Report stale architecture/model references that tend to mislead agents.
 *
 * Default mode prints warnings and exits 0. Use --strict to exit 1 on hits.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const strict = process.argv.includes("--strict");

const skippedDirs = new Set([
  ".planning",
  ".git",
  "node_modules",
  "dist",
  "logs",
  "graphify-out",
  // Data/artifact dirs — they record real values (old ports, IDs, etc.) as DATA,
  // not as live references, so they produce false positives under --strict.
  "reports",
  // Throwaway agent worktrees (full repo copies — incl. this checker's own pattern
  // strings) and other local-only artifact dirs. Gitignored; never live references.
  "worktrees",
  ".vercel",
  ".superpowers",
]);

const skippedFiles = new Set([
  "package-lock.json",
  "docs/repo-hygiene-audit-2026-05-18.md",
  "docs/worktree-consolidation-2026-05-18.md",
  "scripts/check-stale-references.mjs",
]);

const binaryLike = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|sqlite|db|lock)$/i;

const checks = [
  {
    id: "lovable-reference",
    severity: "high",
    description: "Lovable artifacts should not remain after migration away from Lovable.",
    pattern: /\blovable\b/i,
  },
  {
    id: "legacy-local-api-8787",
    severity: "high",
    description: "Port 8787 is the old Node demo backend; current local prod-parity API should be Deno on 3002.",
    pattern: /localhost:8787|127\.0\.0\.1:8787|\b8787\b/,
  },
  {
    id: "openai-model-env",
    severity: "medium",
    description: "OPENAI_MODEL belongs to the old OpenAI demo path; current model config uses LLM_MODEL/QWEN_MODEL/Gemini envs.",
    pattern: /\bOPENAI_MODEL\b/,
  },
  {
    id: "qwen-14b-default",
    severity: "high",
    description: "qwen2.5:14b-instruct is retired and should not be a default model.",
    pattern: /(default|QWEN_MODEL|LLM_MODEL|OLLAMA_GENERATION_MODEL)[^\n]{0,120}qwen2\.5:14b-instruct|qwen2\.5:14b-instruct[^\n]{0,120}(default|QWEN_MODEL|LLM_MODEL|OLLAMA_GENERATION_MODEL)/i,
  },
  {
    id: "old-node-backend-active-path",
    severity: "high",
    description: "Old Node backend paths should not be described as active runtime paths.",
    pattern: /server[\\/](index\.mjs|lib[\\/])|server-node[\\/]|ecosystem\.config\.cjs/,
  },
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = normalize(relative(root, abs));

    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name)) continue;
      out.push(...await walk(abs));
      continue;
    }

    if (!entry.isFile()) continue;
    if (skippedFiles.has(rel)) continue;
    if (binaryLike.test(entry.name)) continue;

    const info = await stat(abs);
    if (info.size > 2_000_000) continue;
    out.push({ abs, rel });
  }
  return out;
}

function normalize(path) {
  return path.replace(/\\/g, "/");
}

function lineNumberFor(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const files = await walk(root);
const hits = [];

for (const file of files) {
  let text;
  try {
    text = await readFile(file.abs, "utf8");
  } catch {
    continue;
  }

  for (const check of checks) {
    const regex = new RegExp(check.pattern.source, check.pattern.flags.includes("g") ? check.pattern.flags : `${check.pattern.flags}g`);
    for (const match of text.matchAll(regex)) {
      const line = lineNumberFor(text, match.index ?? 0);
      const snippet = String(match[0]).replace(/\s+/g, " ").slice(0, 180);
      hits.push({ ...check, file: file.rel, line, snippet });
    }
  }
}

if (hits.length === 0) {
  console.log("[stale-check] ok - no stale references found");
  process.exit(0);
}

console.log(`[stale-check] ${hits.length} stale reference hit(s) found\n`);

for (const hit of hits) {
  console.log(`${hit.severity.toUpperCase()} ${hit.id} ${hit.file}:${hit.line}`);
  console.log(`  ${hit.description}`);
  console.log(`  ${hit.snippet}\n`);
}

if (strict) {
  process.exit(1);
}
