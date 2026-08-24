#!/usr/bin/env node
/**
 * Lightweight frontend smoke test for defaults that are easy to regress during
 * UI/filter edits. This deliberately avoids adding a test runner dependency;
 * `npm run build` still verifies the React app compiles.
 */

import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) {
    console.error(`[smoke-react] FAIL ${message}`);
    process.exitCode = 1;
  }
}

const app = readFileSync("App.tsx", "utf8");
const sources = readFileSync("components/SourcesPicker.tsx", "utf8");
const brief = readFileSync("components/BriefView.tsx", "utf8");

assert(/const defaultFilters:\s*SearchFilters\s*=\s*{[\s\S]*?timePeriod:\s*'all'/.test(app),
  "App defaultFilters should use all-time search by default");
assert(/const defaultFilters:\s*SearchFilters\s*=\s*{[\s\S]*?startDate:\s*''/.test(app),
  "App defaultFilters should not force a 2020 start date");
assert(/const \[timeRange,\s*setTimeRange\]\s*=\s*useState<TimeRange>\('all'\)/.test(app),
  "App timeRange state should default to all");
// Reconciled 2026-06-12 with the 2026-06-11 source restructure. App.tsx
// defaultFilters, SourcesQuestion DEFAULT_*, and SourcesPicker
// DEFAULT_SOURCES_SELECTION default WP sources to NBER + IZA + CEPR_REPEC + SSRN.
// The legacy picker's institutional default is IADB + WB + OECD; IMF is a
// clarifier-only institutional source the picker does not model.
assert(/workingPaperSources:\s*\['NBER',\s*'IZA',\s*'CEPR_REPEC',\s*'SSRN'\]/.test(app),
  "App default working-paper sources should be NBER + IZA + CEPR_REPEC + SSRN");
assert(/DEFAULT_SOURCES_SELECTION[\s\S]*?workingPaperSources:\s*\['NBER',\s*'IZA',\s*'CEPR_REPEC',\s*'SSRN'\]/.test(sources),
  "SourcesPicker default working-paper sources should be NBER + IZA + CEPR_REPEC + SSRN");
assert(/institutionalSources:\s*\['IADB',\s*'WB',\s*'OECD'\]/.test(sources),
  "SourcesPicker default institutional sources should be IADB + WB + OECD");
// BriefView's filter-summary reads workingPaperSources for display; it must
// fall back gracefully when the field is absent (summary shows what's actually
// selected — it does not fabricate NBER/SSRN).
assert(/filters\.workingPaperSources \?\? \[\]/.test(brief),
  "BriefView filter summary should read workingPaperSources with an empty fallback");
assert(/value:\s*'recent-2020'/.test(app) || /recent-2020/.test(brief),
  "2020-present should remain available as a user-selectable option");

if (process.exitCode) process.exit(process.exitCode);
console.log("[smoke-react] ok - default filters and source choices are stable");
