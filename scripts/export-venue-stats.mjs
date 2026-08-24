#!/usr/bin/env node
/**
 * Export venue/journal statistics to CSV.
 * Columns: venue, total_papers, papers_2009_below, papers_2010_2020,
 *          papers_2021_plus, missing_abstract, missing_sms
 *
 * Canonical non-noise papers only.
 *
 * Usage:
 *   node --env-file=.env scripts/export-venue-stats.mjs
 *   node --env-file=.env scripts/export-venue-stats.mjs --out reports/venue-stats.csv
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const outIdx = process.argv.indexOf('--out');
const OUT = (outIdx >= 0 && process.argv[outIdx + 1]) ? process.argv[outIdx + 1] : `reports/venue-stats-${new Date().toISOString().slice(0,10)}.csv`;
const PAGE = 1000; // PostgREST default max

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log('Loading papers from DB (canonical, non-noise)…');

const venueMap = new Map(); // venue → { total, pre2010, y2010_2020, post2020, noAbstract, noSms }

function getOrCreate(venue) {
  const key = (venue || '(no venue)').trim();
  if (!venueMap.has(key)) {
    venueMap.set(key, { venue: key, total: 0, pre2010: 0, y2010_2020: 0, post2020: 0, noAbstract: 0, noSms: 0 });
  }
  return venueMap.get(key);
}

let from = 0;
let totalRows = 0;

while (true) {
  const { data, error } = await sb
    .from('works')
    .select('venue, year, abstract, sms_level')
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .range(from, from + PAGE - 1)
    .order('id');

  if (error) { console.error('DB error:', error.message); break; }
  if (!data || data.length === 0) break;

  for (const row of data) {
    const rec = getOrCreate(row.venue);
    rec.total++;
    const y = row.year ?? 0;
    if (y <= 2009)       rec.pre2010++;
    else if (y <= 2020)  rec.y2010_2020++;
    else                 rec.post2020++;
    if (!row.abstract)   rec.noAbstract++;
    if (row.sms_level == null) rec.noSms++;
  }

  totalRows += data.length;
  process.stdout.write(`\r  loaded ${totalRows.toLocaleString()} papers, ${venueMap.size} venues…`);
  if (data.length < PAGE) break;
  from += PAGE;
}

process.stdout.write('\n');
console.log(`Done: ${totalRows.toLocaleString()} papers across ${venueMap.size} venues`);

// Sort by total papers descending
const rows = [...venueMap.values()].sort((a, b) => b.total - a.total);

// Build CSV
const header = 'venue,total_papers,papers_2009_below,papers_2010_2020,papers_2021_plus,missing_abstract,missing_sms';
const csvRows = rows.map(r => [
  `"${r.venue.replace(/"/g, '""')}"`,
  r.total,
  r.pre2010,
  r.y2010_2020,
  r.post2020,
  r.noAbstract,
  r.noSms,
].join(','));

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(OUT, [header, ...csvRows].join('\n'), 'utf8');
console.log(`Written: ${OUT} (${rows.length} venue rows)`);

// Quick summary
const top10 = rows.slice(0, 10);
console.log('\nTop 10 venues by paper count:');
console.log('venue | total | missing_abstract | missing_sms');
top10.forEach(r => console.log(`${r.venue.slice(0,50).padEnd(50)} | ${String(r.total).padStart(6)} | ${String(r.noAbstract).padStart(16)} | ${String(r.noSms).padStart(10)}`));
