#!/usr/bin/env node
/**
 * Phase 0 audit — read-only diagnostic of corpus column coverage.
 *
 * Tells us how many papers we have, how many are tagged with corpus_source,
 * publication_type, year, geography, sms_level — and which ingest paths
 * produce the most null-SMS rows. Output drives the Phase 1-4 backfill plan.
 *
 * Read-only. Safe to run anytime. No side effects.
 *
 * Usage:
 *   node scripts/audit-corpus-state.mjs
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const fmt = (n) => n.toLocaleString();
const pct = (n, total) =>
  total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;

async function count(filter, label = "?") {
  let q = sb.from("works").select("id", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) {
    console.error(`  [warn] count(${label}) failed:`, JSON.stringify(error));
    return null;
  }
  return c ?? 0;
}

async function distinctValues(column, limit = 200000) {
  // PostgREST has no DISTINCT; pull all values + dedupe in JS.
  const all = new Map();
  let offset = 0;
  const PAGE = 1000;
  while (offset < limit) {
    const { data, error } = await sb
      .from("works")
      .select(column)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`distinct ${column} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      const v = row[column];
      if (v == null) continue;
      all.set(v, (all.get(v) || 0) + 1);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return [...all.entries()].sort((a, b) => b[1] - a[1]);
}

function bar(n, max, width = 30) {
  const filled = Math.round((n / max) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

async function main() {
  console.log("=".repeat(70));
  console.log("CORPUS AUDIT — Phase 0");
  console.log("=".repeat(70));

  // ----- schema probe: what columns actually exist on a sample row?
  const { data: sampleRow, error: sampleErr } = await sb
    .from("works")
    .select("*")
    .limit(1)
    .single();
  if (sampleErr) {
    console.error("Schema probe failed:", sampleErr.message);
  } else {
    const cols = Object.keys(sampleRow).sort();
    console.log("\nColumns present on works table:");
    console.log("  " + cols.join(", "));
  }

  // ----- totals
  const total = await count(null, "total");
  console.log(`\nTotal works in corpus:  ${fmt(total)}\n`);

  // ----- coverage table
  const withYear = await count((q) => q.not("year", "is", null), "year");
  const withGeo = await count((q) => q.not("geography", "is", null), "geography");
  const withSms = await count((q) => q.not("sms_level", "is", null), "sms");
  const withCorpusSource = await count((q) => q.not("corpus_source", "is", null), "corpus_source");
  const withPubType = await count((q) => q.not("publication_type", "is", null), "pub_type");
  const withVenue = await count((q) => q.not("venue", "is", null), "venue");

  const showRow = (label, n) => {
    if (n == null) {
      console.log(`  ${label.padEnd(17)} (failed — see warn above)`);
    } else {
      console.log(`  ${label.padEnd(17)} ${fmt(n).padStart(7)}  (${pct(n, total).padStart(6)})  ${bar(n, total)}`);
    }
  };
  console.log("Column coverage:");
  showRow("year",             withYear);
  showRow("geography",        withGeo);
  showRow("sms_level",        withSms);
  showRow("corpus_source",    withCorpusSource);
  showRow("publication_type", withPubType);
  showRow("venue",            withVenue);

  // ----- corpus_source distribution
  console.log("\nDistribution by corpus_source:");
  const sources = await distinctValues("corpus_source");
  const sourceMax = sources[0]?.[1] || 1;
  for (const [src, c] of sources.slice(0, 20)) {
    console.log(`  ${(src || "(null)").padEnd(28)} ${fmt(c).padStart(7)}  ${bar(c, sourceMax, 25)}`);
  }
  if (sources.length > 20) {
    console.log(`  … and ${sources.length - 20} more`);
  }

  // ----- publication_type distribution (skip if column missing)
  if (sampleRow && "publication_type" in sampleRow) {
    console.log("\nDistribution by publication_type:");
    const types = await distinctValues("publication_type");
    const typeMax = types[0]?.[1] || 1;
    for (const [t, c] of types) {
      console.log(`  ${(t || "(null)").padEnd(28)} ${fmt(c).padStart(7)}  ${bar(c, typeMax, 25)}`);
    }
  } else {
    console.log("\nDistribution by publication_type:  (column missing — migration 20260507000002 not applied)");
  }

  // ----- null-SMS cross-tab by corpus_source
  console.log("\nNull-SMS papers by corpus_source (Phase 4 backfill targets):");
  const nullSmsTotal = await count((q) => q.is("sms_level", null));
  console.log(`  Total null-SMS rows: ${fmt(nullSmsTotal)} (${pct(nullSmsTotal, total)} of corpus)\n`);
  const topSources = sources.slice(0, 10);
  for (const [src, _c] of topSources) {
    const nullForSrc = await count((q) =>
      q.eq("corpus_source", src).is("sms_level", null),
    );
    console.log(`  ${(src || "(null)").padEnd(28)} ${fmt(nullForSrc).padStart(7)} null-SMS`);
  }

  // ----- abs_rating + repec coverage (journal-tier filters)
  console.log("\nJournal-rank metadata (drives journal-tier filter):");
  const withAbs = await count((q) => q.not("abs_rating", "is", null));
  const withRepec = await count((q) => q.not("repec_percentile", "is", null));
  console.log(`  abs_rating       ${fmt(withAbs).padStart(7)}  (${pct(withAbs, total).padStart(6)})`);
  console.log(`  repec_percentile ${fmt(withRepec).padStart(7)}  (${pct(withRepec, total).padStart(6)})`);

  // ----- methodology_design distribution
  console.log("\nDistribution by methodology_design (top 12):");
  const designs = await distinctValues("methodology_design");
  for (const [d, c] of designs.slice(0, 12)) {
    console.log(`  ${(d || "(null)").padEnd(28)} ${fmt(c).padStart(7)}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("Audit complete. Use these numbers to scope Phases 1-4.");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("[audit] failed:", err.message);
  process.exit(1);
});
