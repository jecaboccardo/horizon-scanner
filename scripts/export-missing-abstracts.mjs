#!/usr/bin/env node
/**
 * Export papers missing abstracts (canonical, non-noise, NOT venue-denylisted)
 * with venue, title, doi, year, authors, publication_type — so they can be
 * triaged for manual abstract acquisition.
 *
 * Writes:
 *   reports/missing-abstracts-<date>.csv          (one row per paper)
 *   reports/missing-abstracts-by-venue-<date>.csv (venue, count, with-DOI count)
 *
 * Usage:
 *   node scripts/export-missing-abstracts.mjs                 # with-DOI only (default)
 *   node scripts/export-missing-abstracts.mjs --include-no-doi
 *   node scripts/export-missing-abstracts.mjs --year-min 2000
 *   node scripts/export-missing-abstracts.mjs --include-no-doi --all-venues  # every canonical non-noise row
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { loadVenueDenylist, isDeniedVenue } from './lib/venue-denylist.mjs';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const args = process.argv.slice(2);
const INCLUDE_NO_DOI = args.includes('--include-no-doi');
const ALL_VENUES = args.includes('--all-venues'); // skip the export-time venue denylist (is_noise still excluded)
const YEAR_MIN = (() => { const i = args.indexOf('--year-min'); return i >= 0 ? Number(args[i + 1]) : null; })();
const denylist = loadVenueDenylist();

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const authorsToStr = (a) => {
  if (!Array.isArray(a)) return '';
  return a.map((x) => (typeof x === 'string' ? x : (x?.name || x?.full_name || ''))).filter(Boolean).join('; ');
};

console.log(`Venue denylist: ${denylist.venues.length} venues loaded${ALL_VENUES ? ' (SKIPPED — --all-venues)' : ''}`);
console.log(`Filter: ${INCLUDE_NO_DOI ? 'all rows' : 'with-DOI only'}${YEAR_MIN ? ` | year>=${YEAR_MIN}` : ''}\n`);

const rows = [];
const PAGE = 1000;
let from = 0;
let denied = 0;
while (true) {
  let q = sb.from('works')
    .select('id,title,venue,canonical_doi,year,authors,publication_type,citation_count')
    .is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true)
    .order('venue', { ascending: true, nullsFirst: false })
    .order('citation_count', { ascending: false, nullsFirst: false })
    .range(from, from + PAGE - 1);
  if (!INCLUDE_NO_DOI) q = q.not('canonical_doi', 'is', null);
  if (YEAR_MIN) q = q.gte('year', YEAR_MIN);
  const { data, error } = await q;
  if (error) { console.error('query error:', error.message); break; }
  if (!data?.length) break;
  for (const r of data) {
    if (!ALL_VENUES && isDeniedVenue(r.venue, denylist)) { denied++; continue; }
    rows.push(r);
  }
  from += PAGE;
  process.stdout.write(`\r  fetched ${from} | kept ${rows.length} | denied ${denied}`);
  if (data.length < PAGE) break;
}
console.log(`\n\nTotal kept: ${rows.length} (excluded ${denied} venue-denylisted)`);

const date = new Date().toISOString().slice(0, 10);
fs.mkdirSync('reports', { recursive: true });

// Per-paper CSV
const header = ['venue', 'title', 'doi', 'year', 'authors', 'publication_type', 'citation_count', 'work_id'];
const lines = [header.join(',')];
for (const r of rows) {
  lines.push([
    csvCell(r.venue), csvCell(r.title), csvCell(r.canonical_doi), csvCell(r.year),
    csvCell(authorsToStr(r.authors)), csvCell(r.publication_type), csvCell(r.citation_count), csvCell(r.id),
  ].join(','));
}
const perPaperPath = `reports/missing-abstracts-${date}.csv`;
fs.writeFileSync(perPaperPath, '﻿' + lines.join('\r\n')); // UTF-8 BOM + CRLF for Excel

// Venue summary
const byVenue = new Map();
for (const r of rows) {
  const v = r.venue || '(no venue)';
  const e = byVenue.get(v) || { total: 0, withDoi: 0 };
  e.total++; if (r.canonical_doi) e.withDoi++;
  byVenue.set(v, e);
}
const summary = [...byVenue.entries()].sort((a, b) => b[1].total - a[1].total);
const sumLines = ['venue,missing_total,missing_with_doi'];
for (const [v, e] of summary) sumLines.push([csvCell(v), e.total, e.withDoi].join(','));
const summaryPath = `reports/missing-abstracts-by-venue-${date}.csv`;
fs.writeFileSync(summaryPath, sumLines.join('\n'));

console.log(`\nWritten:`);
console.log(`  ${perPaperPath}  (${rows.length} papers)`);
console.log(`  ${summaryPath}  (${summary.length} venues)`);
console.log(`\nTop 15 venues by missing count:`);
for (const [v, e] of summary.slice(0, 15)) console.log(`  ${String(e.total).padStart(6)}  (${String(e.withDoi).padStart(6)} w/DOI)  ${v}`);
