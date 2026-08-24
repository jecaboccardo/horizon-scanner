#!/usr/bin/env node
/**
 * Syntax-check repo Node scripts without running them.
 *
 * This catches broken imports, bad merges, and partial edits in operational
 * scripts before they make it into a backfill run. It intentionally uses
 * `node --check` only; scripts that need env/network are not executed.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const scriptRoot = join(root, "scripts");
const skippedDirs = new Set(["node_modules", "logs"]);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) walk(abs);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".mjs")) files.push(abs);
  }
}

if (!statSync(scriptRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("[check-scripts] missing scripts/ directory");
  process.exit(1);
}

walk(scriptRoot);
files.sort();

let failed = 0;
for (const file of files) {
  const rel = relative(root, file);
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    failed++;
    console.error(`\n[check-scripts] FAIL ${rel}`);
    if (result.stdout) console.error(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
  }
}

if (failed > 0) {
  console.error(`\n[check-scripts] ${failed}/${files.length} script(s) failed syntax check`);
  process.exit(1);
}

console.log(`[check-scripts] ok - ${files.length} .mjs scripts parse`);
