#!/usr/bin/env node
/**
 * Stamp raw_data.publication_type on every work in the corpus.
 *
 * Categories (mutually exclusive, first match wins):
 *   working_paper  — NBER WPs, IZA DPs, World Bank Policy Research WPs,
 *                    venues containing "working paper" / "discussion paper" /
 *                    "preprint", or existing raw_data.source_type='working_paper'.
 *   report         — IDB publications, PAHO, WHO, OECD, multilateral reports,
 *                    venues containing "report" / "policy brief" / "technical note".
 *   journal_article— has journal-rankings match (abs_rating or repec_percentile),
 *                    or DOI prefix is a known academic publisher.
 *   other          — fallback (mostly null-venue grey lit).
 *
 * Idempotent — re-runnable. Skips rows where raw_data.publication_type is
 * already set unless --force is passed.
 *
 * Usage:
 *   node scripts/classify-publication-type.mjs              # apply
 *   node scripts/classify-publication-type.mjs --dry-run    # count only
 *   node scripts/classify-publication-type.mjs --force      # re-tag all rows
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const PAGE = 1000;

// Working paper signals
const WP_DOI_PREFIXES = ['10.3386/', '10.1596/1813-9450-'];
const WP_VENUE_PATTERNS = [
  /working\s*paper/i,
  /discussion\s*paper/i,
  /\bpreprint\b/i,
  /\bIZA\s*(DP|Discussion)/i,
  /policy\s*research\s*working/i,
  /NBER/i,
];

// Report / institutional signals
const REPORT_DOI_PREFIXES = ['10.18235/', '10.37774/', '10.1787/', '10.5089/']; // IDB, PAHO, OECD, IMF
const REPORT_VENUE_PATTERNS = [
  /\bIDB\s*Publication/i,
  /\bIDB\s+Working\s+Paper/i, // captured here too — but WP signal would have already matched if working
  /^report$/i,
  /\breport\b/i,
  /policy\s*brief/i,
  /technical\s*note/i,
  /technical\s*report/i,
  /\bOECD\b.*Review/i,
  /World\s*Bank/i,
  /^PAHO\b/i,
  /^WHO\b/i,
  /\bECLAC\b/i,
  /\bCEPAL\b/i,
];

// Journal-article DOI prefixes (major academic publishers)
const JOURNAL_DOI_PREFIXES = [
  '10.1016/',  // Elsevier
  '10.1007/',  // Springer Nature
  '10.1111/',  // Wiley-Blackwell
  '10.1086/',  // Univ. Chicago Press
  '10.1037/',  // APA
  '10.1038/',  // Nature Portfolio
  '10.1126/',  // Science / AAAS
  '10.1257/',  // AEA (American Economic Review etc.)
  '10.1162/',  // MIT Press
  '10.1093/',  // Oxford UP
  '10.1017/',  // Cambridge UP
  '10.1080/',  // Taylor & Francis
  '10.1136/',  // BMJ
  '10.1371/',  // PLOS
  '10.1590/',  // SciELO
  '10.21149/', // Salud Pública de México
  '10.26633/', // Pan American Journal of Public Health
  '10.18332/', // EU Public Health (some)
  '10.21037/', // AME Publishing
  '10.1093/',  // Oxford Academic
  '10.4324/',  // Routledge
];

function classify(row) {
  const venue = (row.venue || '').trim();
  const doi = (row.canonical_doi || '').toLowerCase();
  const raw = row.raw_data || {};

  // Already explicitly tagged at ingest time
  const ingestType = raw.source_type;
  if (ingestType === 'working_paper') return 'working_paper';

  // 1) Working paper checks
  if (doi && WP_DOI_PREFIXES.some(p => doi.startsWith(p))) return 'working_paper';
  if (venue && WP_VENUE_PATTERNS.some(re => re.test(venue))) return 'working_paper';

  // 2) Report checks (note: REPORT_DOI_PREFIXES include IDB/PAHO/OECD/IMF)
  if (doi && REPORT_DOI_PREFIXES.some(p => doi.startsWith(p))) return 'report';
  if (venue && REPORT_VENUE_PATTERNS.some(re => re.test(venue))) return 'report';

  // 3) Journal article — strong signals first, then fall through to "venue
  //    is set" as the broader default. Most academic content in the corpus
  //    that has a venue and isn't tagged WP/report is a journal article.
  if (row.abs_rating != null || row.repec_percentile != null) return 'journal_article';
  if (doi && JOURNAL_DOI_PREFIXES.some(p => doi.startsWith(p))) return 'journal_article';
  if (ingestType === 'journal_article') return 'journal_article';
  if (venue && venue.length > 0) return 'journal_article';

  // 4) Fallback — truly unclassifiable (no venue, no recognized DOI)
  return 'other';
}

async function main() {
  console.log(`\n=== Publication-type classifier ===`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Force re-tag: ${FORCE}\n`);

  let from = 0;
  const counts = { working_paper: 0, report: 0, journal_article: 0, other: 0, skipped: 0, errors: 0 };
  const startTime = Date.now();

  while (true) {
    let q = supabase
      .from('works')
      .select('id, canonical_doi, venue, abs_rating, repec_percentile, raw_data')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) { console.error('  fetch err:', error.message); break; }
    if (!data?.length) break;

    // Build update jobs first (skip already-tagged unless forced)
    const jobs = [];
    for (const row of data) {
      const existing = row.raw_data?.publication_type;
      if (existing && !FORCE) { counts.skipped++; continue; }
      const type = classify(row);
      counts[type]++;
      if (DRY_RUN) continue;
      jobs.push({ id: row.id, raw_data: { ...(row.raw_data || {}), publication_type: type } });
    }

    // Run updates in parallel with concurrency cap
    if (jobs.length > 0) {
      const CONCURRENCY = 20;
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const i = cursor++;
          const j = jobs[i];
          const { error: upErr } = await supabase.from('works').update({ raw_data: j.raw_data }).eq('id', j.id);
          if (upErr) {
            counts.errors++;
            if (counts.errors < 5) console.error(`\n  upd err: ${upErr.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    }

    from += data.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  ${from} processed | WP ${counts.working_paper} · report ${counts.report} · journal ${counts.journal_article} · other ${counts.other} · skipped ${counts.skipped} | ${elapsed}s`);
    if (data.length < PAGE) break;
  }

  console.log(`\n\n=== Summary ===`);
  console.log(`Working papers:    ${counts.working_paper.toLocaleString()}`);
  console.log(`Reports:           ${counts.report.toLocaleString()}`);
  console.log(`Journal articles:  ${counts.journal_article.toLocaleString()}`);
  console.log(`Other:             ${counts.other.toLocaleString()}`);
  console.log(`Skipped (already): ${counts.skipped.toLocaleString()}`);
  if (counts.errors > 0) console.log(`Errors:            ${counts.errors}`);
  console.log(`Elapsed:           ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
