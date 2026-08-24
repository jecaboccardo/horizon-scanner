#!/usr/bin/env node
/**
 * Orchestrate the Project MUSE priority workflow.
 *
 * Priority definition, by default:
 *   - missing abstract
 *   - year >= 2010
 *   - ABS rating >= 3
 *   - all publication types
 *   - exclude generic/commentary/non-primary rows
 *
 * The pipeline keeps abstract backfill honest:
 *   1. Report all priority MUSE rows still missing abstracts.
 *   2. List/run browser HTML formal-abstract extraction.
 *   3. List/run PDF labeled Abstract/Summary fallback.
 *   4. List/run PDF evidence-card enrichment for PDF-only/no-abstract cases.
 *
 * Usage:
 *   node scripts/run-muse-priority-pipeline.mjs --list
 *   node scripts/run-muse-priority-pipeline.mjs --run-abstracts --manual-login
 *   node scripts/run-muse-priority-pipeline.mjs --run-evidence --manual-login
 *   node scripts/run-muse-priority-pipeline.mjs --run-all --manual-login
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function argValue(name, fallback = null) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const YEAR_MIN = argValue("--year-min", "2010");
const MIN_ABS_RATING = argValue("--min-abs-rating", "3");
const LIMIT = argValue("--limit", "500");
const PROFILE_DIR = argValue("--profile-dir", ".playwright-muse-profile");
const LOGIN_URL = argValue("--login-url", "https://globalhome.nyu.edu/services/search/elibrary");
const LOGIN_WAIT_MS = argValue("--login-wait-ms", hasFlag("--manual-login") ? "30000" : "15000");
const VERIFY_WAIT_MS = argValue("--verify-wait-ms", "300000");
const KEEP_OPEN_MS = argValue("--keep-open-ms", "0");
const PDF_PAGES = argValue("--pages", "18");
const REPORT_PREFIX = argValue("--out-prefix", "missing-abstracts-muse-priority-all");

const LIST_ONLY = hasFlag("--list") || (!hasFlag("--run-abstracts") && !hasFlag("--run-evidence") && !hasFlag("--run-all"));
const RUN_ABSTRACTS = hasFlag("--run-abstracts") || hasFlag("--run-all");
const RUN_EVIDENCE = hasFlag("--run-evidence") || hasFlag("--run-all");
const DRY_RUN = hasFlag("--dry-run");
const MANUAL_LOGIN = hasFlag("--manual-login");
const HEADLESS = hasFlag("--headless");
const INCLUDE_GENERIC = hasFlag("--include-generic-titles");
const SKIP_BROWSER = hasFlag("--skip-browser");
const SKIP_PDF_ABSTRACTS = hasFlag("--skip-pdf-abstracts");

const node = process.execPath;

function commonMuseArgs() {
  return [
    "--year-min", YEAR_MIN,
    "--min-abs-rating", MIN_ABS_RATING,
    "--all-publication-types",
    "--limit", LIMIT,
    "--profile-dir", PROFILE_DIR,
    "--login-url", LOGIN_URL,
    "--login-wait-ms", LOGIN_WAIT_MS,
    "--verify-wait-ms", VERIFY_WAIT_MS,
    ...(KEEP_OPEN_MS !== "0" ? ["--keep-open-ms", KEEP_OPEN_MS] : []),
    ...(MANUAL_LOGIN ? ["--manual-login"] : []),
    ...(HEADLESS ? ["--headless"] : []),
    ...(INCLUDE_GENERIC ? ["--include-generic-titles"] : []),
  ];
}

function run(label, script, args) {
  return new Promise((resolve, reject) => {
    if (!existsSync(script)) {
      reject(new Error(`Missing script: ${script}`));
      return;
    }
    console.log(`\n=== ${label} ===`);
    console.log([node, script, ...args].join(" "));
    const child = spawn(node, [script, ...args], {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function main() {
  console.log("\n=== MUSE Priority Pipeline ===");
  console.log(`Mode: ${LIST_ONLY ? "list/report only" : RUN_ABSTRACTS && RUN_EVIDENCE ? "run abstracts + evidence" : RUN_ABSTRACTS ? "run abstracts" : "run evidence"}`);
  console.log(`Year min: ${YEAR_MIN}`);
  console.log(`Min ABS rating: ${MIN_ABS_RATING}`);
  console.log(`Publication types: all`);
  console.log(`Limit: ${LIMIT}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Manual login: ${MANUAL_LOGIN}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log("Policy: exclude commentary/generic non-primary rows; do not generate abstracts.\n");

  await run("Report all priority MUSE missing abstracts", "scripts/report-missing-abstracts.mjs", [
    "--muse-only",
    "--year-min", YEAR_MIN,
    "--min-abs-rating", MIN_ABS_RATING,
    "--limit", "200000",
    "--out-prefix", REPORT_PREFIX,
    ...(INCLUDE_GENERIC ? ["--include-generic-titles"] : []),
  ]);

  await run("Report actionable browser targets excluding prior failed/PDF-only attempts", "scripts/report-missing-abstracts.mjs", [
    "--muse-only",
    "--year-min", YEAR_MIN,
    "--min-abs-rating", MIN_ABS_RATING,
    "--exclude-prior-attempts",
    "--limit", "200000",
    "--out-prefix", `${REPORT_PREFIX}-browser-actionable`,
    ...(INCLUDE_GENERIC ? ["--include-generic-titles"] : []),
  ]);

  if (!SKIP_BROWSER) {
    await run(
      LIST_ONLY ? "List browser HTML abstract targets" : RUN_ABSTRACTS ? "Run browser HTML abstract backfill" : "List browser HTML abstract targets",
      "scripts/backfill-abstracts-muse-browser.mjs",
      [
        ...(LIST_ONLY || !RUN_ABSTRACTS ? ["--list-targets"] : []),
        ...(DRY_RUN ? ["--dry-run"] : []),
        ...commonMuseArgs(),
      ],
    );
  }

  if (!SKIP_PDF_ABSTRACTS) {
    await run(
      LIST_ONLY ? "List PDF labeled-abstract fallback targets" : RUN_ABSTRACTS ? "Run PDF labeled-abstract fallback" : "List PDF labeled-abstract fallback targets",
      "scripts/backfill-abstracts-muse-pdf.mjs",
      [
        ...(LIST_ONLY || !RUN_ABSTRACTS ? ["--list-targets"] : []),
        ...(DRY_RUN ? ["--dry-run"] : []),
        "--pages", PDF_PAGES,
        ...commonMuseArgs(),
      ],
    );
  }

  await run(
    LIST_ONLY ? "List PDF evidence-card enrichment targets" : RUN_EVIDENCE ? "Run PDF evidence-card enrichment" : "List PDF evidence-card enrichment targets",
    "scripts/enrich-evidence-muse-pdf.mjs",
    [
      ...(LIST_ONLY || !RUN_EVIDENCE ? ["--list-targets"] : []),
      ...(DRY_RUN ? ["--dry-run"] : []),
      "--pages", PDF_PAGES,
      ...commonMuseArgs(),
    ],
  );

  console.log("\n=== MUSE Priority Pipeline complete ===");
}

main().catch((err) => {
  console.error(`[muse-pipeline] failed: ${err.message}`);
  process.exit(1);
});
