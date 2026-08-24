#!/usr/bin/env node
/**
 * In-scope ECON ABS 3+ gap fill — WAVE 2 (2026-07-06 coverage analysis).
 *
 * The applied/policy-economics journals from the coverage audit that were NOT
 * in the wave-1 list (import-econ-gaps-2026-07-06.mjs). Still deliberately
 * EXCLUDES the statistics-methodology and pure-theory journals ABS classifies
 * under ECON (JASA, Annals of Statistics, Biometrika, JRSS, J Math Econ,
 * Economic Theory, Econometric Theory/Reviews, JEDC, CSDA, etc.).
 *
 * Designed for `--api crossref` (no OpenAlex dependency — OpenAlex has a
 * 1000-credit/day budget). issns = each journal's full print+electronic pair
 * from the abs3-gap-v3 audit; Crossref's issn filter ORs over the pair.
 * Expected ≈12k new rows for 2010+ (audit upper bound; dedup will trim).
 *
 * Usage:
 *   node scripts/import-econ-gaps-wave2-2026-07-06.mjs --dry-run --years 16 --api crossref
 *   node scripts/import-econ-gaps-wave2-2026-07-06.mjs --years 16 --api crossref
 */
import { config } from "dotenv";
import { ingestJournals } from "./lib/openalex-journal-ingester.mjs";
config();

// name → ABS ISSN + full ISSN pair (from abs3-gap-v3 audit). missing = audit
// upper bound (universe − have) for 2010+.
const TARGETS = [
  { name: "Canadian Journal of Economics",                                   issn: "1540-5982", issns: ["0008-4085", "1540-5982"], tier: "3" },  // ~935
  { name: "Journal of International Economics",                              issn: "1873-0353", issns: ["0022-1996", "1873-0353"], tier: "4" },  // ~924
  { name: "Review of Income and Wealth",                                     issn: "1475-4991", issns: ["0034-6586", "1475-4991"], tier: "3" },  // ~887
  { name: "Oxford Bulletin of Economics and Statistics",                     issn: "1468-0084", issns: ["0305-9049", "1468-0084"], tier: "3" },  // ~867
  { name: "Journal of Agricultural Economics",                               issn: "1477-9552", issns: ["0021-857X", "1477-9552"], tier: "3" },  // ~838
  { name: "Journal of Institutional Economics",                              issn: "1744-1382", issns: ["1744-1374", "1744-1382"], tier: "3" },  // ~817
  { name: "European Review of Agricultural Economics",                       issn: "1464-3618", issns: ["0165-1587", "1464-3618"], tier: "3" },  // ~723
  { name: "Scandinavian Journal of Economics",                               issn: "1467-9442", issns: ["0347-0520", "1467-9442"], tier: "3" },  // ~708
  { name: "Economica",                                                       issn: "1468-0335", issns: ["0013-0427", "1468-0335"], tier: "3" },  // ~705
  { name: "International Economic Review",                                   issn: "1468-2354", issns: ["0020-6598", "1468-2354"], tier: "4" },  // ~648
  { name: "Experimental Economics",                                          issn: "1573-6938", issns: ["1386-4157", "1573-6938"], tier: "3" },  // ~633
  { name: "Journal of Law and Economics",                                    issn: "1537-5285", issns: ["0022-2186", "1537-5285"], tier: "3" },  // ~506
  { name: "Journal of the Association of Environmental and Resource Economists", issn: "2333-5963", issns: ["2333-5955", "2333-5963"], tier: "3" }, // ~499
  { name: "IMF Economic Review",                                             issn: "2041-417X", issns: ["2041-4161", "2041-417X"], tier: "3" },  // ~450
  { name: "Journal of Law, Economics, and Organization",                     issn: "1465-7341", issns: ["1465-7341", "8756-6222"], tier: "3" },  // ~435
  { name: "American Economic Review",                                        issn: "1944-7981", issns: ["0002-8282", "1944-7981"], tier: "4*" }, // ~409 top-up
  { name: "Journal of Risk and Uncertainty",                                 issn: "1573-0476", issns: ["0895-5646", "1573-0476"], tier: "3" },  // ~394
  { name: "Journal of Population Economics",                                 issn: "1432-1475", issns: ["0933-1433", "1432-1475"], tier: "3" },  // ~319 top-up
  { name: "Journal of Legal Studies",                                        issn: "1537-5366", issns: ["0047-2530", "1537-5366"], tier: "3" },  // ~308
];

await ingestJournals({
  journals: TARGETS,
  corpusSource: "econ_gaps_w2_2026_07",
  bannerTitle: "In-scope ECON ABS 3+ Gap Fill — Wave 2 (2026-07-06)",
  labelFor: (j) => (j.tier ?? "").padEnd(3),
  rawDataExtras: (paper) => ({ abs_tier: paper.journal.tier }),
}).catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
