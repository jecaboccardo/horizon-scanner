#!/usr/bin/env node
/**
 * ProQuest ABI/INFORM abstract backfill — NYU login launcher.
 *
 * A thin Node wrapper around scripts/backfill-abstracts-proquest-browser.mjs that
 * bakes in the defaults you want: NYU manual login + year >= 2020 + non-noise,
 * gap-only papers. Runs in ANY terminal (PowerShell, bash, cmd):
 *
 *     node scripts/proquest-nyu.mjs                       # year>=2020, 150 papers
 *     node scripts/proquest-nyu.mjs --dry-run --limit 10  # preview, no writes
 *     node scripts/proquest-nyu.mjs --limit 300           # bigger batch
 *     node scripts/proquest-nyu.mjs --preset applied-econ # best hit-rate venues
 *     node scripts/proquest-nyu.mjs --year-min 2015       # override the year floor
 *
 * An Edge/Chrome window opens on the NYU global-home page — log into ProQuest
 * ABI/INFORM there (~150s window), then it works the gap list automatically.
 *
 * Golden-rule safe: the underlying scraper only writes `abstract` where it is
 * currently NULL, verifies the docview FULL title before writing, and marks
 * misses (raw_data.proquest_attempt) so re-runs skip known failures.
 *
 * Any flag you pass appears BEFORE the defaults below; the scraper reads the
 * first occurrence of each flag, so your value wins (you can override year-min,
 * limit, add --dry-run, --preset, --venues, --exclude-venues, --ids, etc.).
 *
 * When it finishes it prints the re-embed command for the filled ids:
 *     node scripts/backfill-reembed-with-abstract.mjs --ids-file reports/proquest-written-ids-<date>.json
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scraper = resolve(here, "backfill-abstracts-proquest-browser.mjs");

const userArgs = process.argv.slice(2);
// User args first (first-occurrence wins in the scraper) → defaults as fallback.
const defaults = ["--manual-login", "--year-min", "2020", "--limit", "150"];
const args = [scraper, ...userArgs, ...defaults];

console.log(`[proquest-nyu] launching: node ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => { console.error("[proquest-nyu] failed to launch:", e.message); process.exit(1); });
