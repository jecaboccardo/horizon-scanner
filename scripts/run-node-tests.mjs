#!/usr/bin/env node
/**
 * Runs the plain-node test files under Tests/*.mjs (each a standalone
 * node:assert script, no test-runner dependency). Aggregates pass/fail across
 * files instead of stopping at the first failure, so one broken file doesn't
 * hide failures in the rest.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('Tests')
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('[test-node] no Tests/*.test.mjs files found');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const path = `Tests/${file}`;
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed++;
    console.error(`[test-node] FAIL ${path}`);
  }
}

console.log(`[test-node] ${files.length - failed}/${files.length} passed`);
process.exit(failed > 0 ? 1 : 0);
