#!/usr/bin/env node
/**
 * Export ALL canonical papers with a missing abstract (abstract IS NULL) to .xlsx.
 * Includes BOTH noise and non-noise rows, with an is_noise column.
 *
 * Columns: DOI | Authors | Title | Venue | PublicationType | Year | IsNoise
 *
 * Usage:
 *   node --env-file=.env scripts/export-missing-abstracts-xlsx.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const authorsToStr = (a) => {
  if (!Array.isArray(a)) return '';
  return a.map((x) => (typeof x === 'string' ? x : (x?.name || x?.full_name || ''))).filter(Boolean).join('; ');
};

const PAGE = 1000;
const rows = [];
let cursor = '';
const t0 = Date.now();

console.log('Fetching canonical rows with missing abstract (noise + non-noise)...');
while (true) {
  let q = sb.from('works')
    .select('id, canonical_doi, authors, title, venue, publication_type, year, is_noise')
    .is('canonical_work_id', null)
    .is('abstract', null)
    .order('id', { ascending: true })
    .limit(PAGE);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q;
  if (error) { console.error('fetch:', error.message); await new Promise(r => setTimeout(r, 2000)); continue; }
  if (!data?.length) break;
  cursor = data[data.length - 1].id;
  for (const r of data) {
    rows.push({
      DOI: r.canonical_doi || (String(r.id).startsWith('10.') ? r.id : ''),
      Authors: authorsToStr(r.authors),
      Title: r.title || '',
      Venue: r.venue || '',
      PublicationType: r.publication_type || '',
      Year: r.year ?? '',
      IsNoise: r.is_noise === true ? 'TRUE' : 'FALSE',
    });
  }
  if (rows.length % 20000 < PAGE) process.stdout.write(`\r  ${rows.length} rows...`);
  if (data.length < PAGE) break;
}
console.log(`\nFetched ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);

const noise = rows.filter(r => r.IsNoise === 'TRUE').length;
console.log(`  is_noise TRUE: ${noise}  |  FALSE: ${rows.length - noise}`);

const ws = XLSX.utils.json_to_sheet(rows, { header: ['DOI', 'Authors', 'Title', 'Venue', 'PublicationType', 'Year', 'IsNoise'] });
ws['!cols'] = [{ wch: 28 }, { wch: 32 }, { wch: 60 }, { wch: 30 }, { wch: 16 }, { wch: 6 }, { wch: 8 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Missing abstracts');

fs.mkdirSync('reports', { recursive: true });
const out = 'reports/missing-abstracts-2026-06-22.xlsx';
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
fs.writeFileSync(out, buf);
console.log(`\nWritten: ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
