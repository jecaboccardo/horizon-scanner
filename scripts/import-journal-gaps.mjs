#!/usr/bin/env node
/**
 * Fill gaps in ABS top-40 journal coverage. Targets the 14 ABS 4-star and 4
 * journals that had <100 papers in corpus as of 2026-04-27 gap analysis.
 *
 * Tags rows with everything needed so no backfill is required:
 *   - corpus_source = 'journal_gaps'
 *   - source        = 'openalex'
 *   - venue         = journal display name
 *   - methodology_design / sms_level  (regex on title+abstract)
 *   - raw_data.scl_topics             (pre-computed)
 *   - raw_data.source_type            ('journal_article')
 *   - raw_data.abs_tier               ('4*' or '4')
 *
 * Usage:
 *   node scripts/import-journal-gaps.mjs                # all 14, last 15y
 *   node scripts/import-journal-gaps.mjs --dry-run      # count only
 *   node scripts/import-journal-gaps.mjs --years 30     # extend to last 30y
 *
 * Shared ingest logic lives in scripts/lib/openalex-journal-ingester.mjs.
 */

import { config } from "dotenv";
import { ingestJournals } from "./lib/openalex-journal-ingester.mjs";

config();

// Target journals (ABS 4* and 4 with <100 papers in corpus)
const JOURNALS = [
  // ABS 4* — sociology, psychology, HRM
  { id: "S122471516", name: "American Journal of Sociology",          tier: "4*" },
  { id: "S157620343", name: "American Sociological Review",           tier: "4*" },
  { id: "S61274580",  name: "Annual Review of Sociology",             tier: "4*" },
  { id: "S166002381", name: "Journal of Applied Psychology",          tier: "4*" },
  { id: "S84664706",  name: "Personnel Psychology",                   tier: "4*" },
  { id: "S113497174", name: "Human Resource Management Journal",      tier: "4*" },
  // ABS 4 — niche econ, sociology, HRM
  { id: "S179979277", name: "International Economic Review",          tier: "4"  },
  { id: "S127742747", name: "Journal of Econometrics",                tier: "4"  },
  { id: "S198098467", name: "Journal of International Economics",     tier: "4"  },
  { id: "S36718530",  name: "Sociology of Education",                 tier: "4"  },
  { id: "S18284184",  name: "Journal of Population Economics",        tier: "4"  },
  { id: "S192274990", name: "Industrial and Labor Relations Review",  tier: "4"  },
  { id: "S61595665",  name: "British Journal of Industrial Relations",tier: "4"  },
  { id: "S62201805",  name: "Journal of Economic Behavior & Organization", tier: "4" },
];

ingestJournals({
  journals: JOURNALS,
  corpusSource: "journal_gaps",
  bannerTitle: "ABS Top-Journal Gap Fill",
  labelFor: (j) => (j.tier ?? "").padEnd(3),
  rawDataExtras: (paper) => ({ abs_tier: paper.journal.tier }),
  // smsPatterns: default English-only set
}).catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
