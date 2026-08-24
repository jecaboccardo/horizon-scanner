#!/usr/bin/env node
/**
 * In-scope ECON ABS 3+ gap fill (2026-07-06 coverage analysis).
 *
 * Targets the biggest ABS 3+ ECONOMICS-field coverage gaps that are genuinely in
 * scope for a development / applied-economics corpus. Deliberately EXCLUDES the
 * statistics-methodology and pure-theory journals that ABS classifies under ECON
 * but which the corpus does not target (Annals of Statistics, Biometrika, JASA,
 * J Multivariate Analysis, JRSS A/B, Econometric Reviews, Economic Theory,
 * J Mathematical Economics, J Economic Dynamics & Control, etc.).
 *
 * Resolves each journal's OpenAlex source id from its ABS ISSN at runtime, then
 * defers to the shared ingester (dedups vs the whole corpus by DOI/id; writes
 * embedding=null → run backfill-fast.mjs afterwards to embed).
 *
 * Usage:
 *   node --env-file=.env scripts/import-econ-gaps-2026-07-06.mjs --dry-run --years 16
 *   node --env-file=.env scripts/import-econ-gaps-2026-07-06.mjs --years 16
 */
import { config } from "dotenv";
import { ingestJournals } from "./lib/openalex-journal-ingester.mjs";
config();

const MAILTO = process.env.OPENALEX_EMAIL || "research@nextminder.com";

// name → ABS ISSN (from the abs_rankings table used in the coverage analysis).
// issns = the journal's FULL print+electronic pair (from abs3-gap-v3 audit) —
// Crossref's issn filter only matches the deposited (usually print) ISSN, so
// crossref mode ORs the whole set. Expected universes (OpenAlex 2010+, audit):
// EcolEcon 4778 · JEBO 4724 · PubChoice 1779 · ERE 1689 · IJIO 1008 ·
// SC&W 1171 · JEconometrics 2468 · EconLetters 7250 — total ≈24.9k, ~3.9k held.
const TARGETS = [
  { name: "Ecological Economics",                              issn: "1873-6106", issns: ["0921-8009", "1873-6106"], tier: "3" },
  { name: "Journal of Economic Behavior and Organization",     issn: "1879-1751", issns: ["0167-2681", "1879-1751"], tier: "3" },
  { name: "Public Choice",                                     issn: "1573-7101", issns: ["0048-5829", "1573-7101"], tier: "3" },
  { name: "Environmental and Resource Economics",              issn: "1573-1502", issns: ["0924-6460", "1573-1502"], tier: "3" },
  { name: "International Journal of Industrial Organization",   issn: "1873-7986", issns: ["0167-7187", "1873-7986"], tier: "3" },
  { name: "Social Choice and Welfare",                         issn: "1432-217X", issns: ["0176-1714", "1432-217X"], tier: "3" },
  { name: "Journal of Econometrics",                           issn: "1872-6895", issns: ["0304-4076", "1872-6895"], tier: "4" },
  { name: "Economics Letters",                                 issn: "1873-7374", issns: ["0165-1765", "1873-7374"], tier: "3" }, // short-notes: high volume, lower evidence value
];

// --api crossref pages Crossref by ISSN directly — no OpenAlex calls at all
// (OpenAlex now has a 1000-credit/day budget; even /sources lookups spend it).
const useCrossref = process.argv.includes("--api") &&
  process.argv[process.argv.indexOf("--api") + 1] === "crossref";

let journals;
if (useCrossref) {
  journals = TARGETS.map((t) => ({ ...t }));
  console.log(`Crossref mode: ${journals.length} journals by ISSN (no OpenAlex resolution)`);
} else {
  const resolved = [];
  for (const t of TARGETS) {
    try {
      const d = await fetch(`https://api.openalex.org/sources/issn:${t.issn}?mailto=${MAILTO}`).then((r) => r.json());
      const sid = d?.id ? String(d.id).split("/").pop() : null;
      if (!sid) { console.error(`  ! no OpenAlex source for ${t.name} (${t.issn})`); continue; }
      resolved.push({ id: sid, name: t.name, tier: t.tier, issn: t.issn });
    } catch (e) {
      console.error(`  ! source lookup failed for ${t.name}: ${e.message}`);
    }
  }
  console.log(`Resolved ${resolved.length}/${TARGETS.length} source ids`);
  journals = resolved;
}

await ingestJournals({
  journals,
  corpusSource: "econ_gaps_2026_07",
  bannerTitle: "In-scope ECON ABS 3+ Gap Fill (2026-07-06)",
  labelFor: (j) => (j.tier ?? "").padEnd(3),
  rawDataExtras: (paper) => ({ abs_tier: paper.journal.tier }),
}).catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
