#!/usr/bin/env node
/**
 * Export papers MISSING a usable abstract for an EXPLICIT set of stored venue
 * strings → a real .xlsx (Year, Title, DOI, Authors, Venue + blank Abstract).
 *
 * Unlike the applied-econ exporter (which guesses "The"/&amp; variants), this
 * takes the EXACT venue strings as stored in works.venue — pass them via a JSON
 * file (array of strings) so there's no fuzzy over-matching. Resolve the exact
 * forms first with an ilike probe (colons are stripped in storage, some carry a
 * "The " prefix, en-dashes become hyphens, etc.).
 *
 * "Missing" = abstract IS NULL or a junk stub (<80 chars / boilerplate).
 * Filters: canonical (canonical_work_id IS NULL), non-noise, has a DOI.
 * Fully paginated → accurate counts (not capped at PostgREST's 1000-row max).
 *
 * Usage:
 *   node --env-file=.env scripts/export-missing-abstracts-by-venue.mjs \
 *     --venues-file reports/venue-list.json --out reports/missing-abstracts-econ-ed-health.xlsx
 *   ... [--year-min 2000]   (optional)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const VENUES_FILE = arg('--venues-file');
const OUT = arg('--out', `reports/missing-abstracts-${new Date().toISOString().slice(0, 10)}.xlsx`);
const YEAR_MIN = (() => { const v = arg('--year-min'); return v != null ? Number(v) : null; })();
if (!VENUES_FILE) { console.error('Provide --venues-file <json array of exact venue strings>'); process.exit(1); }

const VENUES = JSON.parse(fs.readFileSync(VENUES_FILE, 'utf8'));
const STUB = /^(not available|international audience|abstract|n\/?a|none|null)$/i;
const isMissing = (a) => { const t = String(a || '').replace(/\s+/g, ' ').trim(); return t.length < 80 || STUB.test(t); };
const authors = (a) => Array.isArray(a) ? a.map((x) => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean).join('; ') : '';

const rows = [];
const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  let q = sb.from('works')
    .select('venue,title,canonical_doi,year,authors,abstract,citation_count')
    .in('venue', VENUES).is('canonical_work_id', null)
    .not('is_noise', 'is', true).not('canonical_doi', 'is', null)
    .order('venue', { ascending: true }).order('citation_count', { ascending: false, nullsFirst: false })
    .range(from, from + PAGE - 1);
  if (YEAR_MIN != null) q = q.gte('year', YEAR_MIN);
  const { data, error } = await q;
  if (error) { console.error('query error:', error.message); break; }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < PAGE) break;
}

const missing = rows.filter((r) => isMissing(r.abstract));
const byVenue = new Map();
for (const r of missing) byVenue.set(r.venue, (byVenue.get(r.venue) || 0) + 1);
console.log(`venues: ${VENUES.length} | scanned: ${rows.length} | MISSING usable abstract: ${missing.length}` + (YEAR_MIN != null ? ` (year>=${YEAR_MIN})` : ' (all years)'));
[...byVenue.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log(`  ${String(n).padStart(5)}  ${v}`));
const zero = VENUES.filter((v) => !byVenue.has(v));
if (zero.length) console.log('  (0 missing / not found:', zero.join(' | '), ')');

const header = ['Year', 'Title', 'DOI', 'Authors', 'Venue', 'Abstract'];
const json = missing.map((r) => ({
  Year: r.year ?? '',
  Title: r.title ?? '',
  DOI: r.canonical_doi ?? '',
  Authors: authors(r.authors),
  Venue: r.venue ?? '',
  Abstract: '',
}));
const ws = XLSX.utils.json_to_sheet(json, { header });
ws['!cols'] = [{ wch: 6 }, { wch: 70 }, { wch: 30 }, { wch: 40 }, { wch: 34 }, { wch: 60 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Missing abstracts');
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(OUT, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(`\nWritten: ${OUT} (${missing.length} rows; Abstract column blank for harvest)`);
