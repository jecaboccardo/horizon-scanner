#!/usr/bin/env node
/**
 * Export applied-economics journal papers MISSING an abstract (canonical, non-noise,
 * year >= 2000, with a DOI) → an Excel-ready CSV to feed an external abstract harvest.
 * Excludes World Development (done separately). Venue match is "The"-prefix / &-entity
 * tolerant.
 *
 * Usage:
 *   node scripts/export-applied-econ-missing-abstracts.mjs                 # year>=2000
 *   node scripts/export-applied-econ-missing-abstracts.mjs --year-min 2010
 *   node scripts/export-applied-econ-missing-abstracts.mjs --venue "Journal of Public Economics"
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const YEAR_MIN = (() => { const i = args.indexOf('--year-min'); return i >= 0 ? Number(args[i + 1]) : 2000; })();
const ONE_VENUE = (() => { const i = args.indexOf('--venue'); return i >= 0 ? args[i + 1] : null; })();

// Applied-economics journals (mirrors the proquest "applied-econ" preset), minus World Development.
const BASE = [
  'Journal of Health Economics', 'Journal of Environmental Economics and Management',
  'Journal of International Money and Finance', 'European Economic Review',
  'Journal of Economic Behavior & Organization', 'Journal of Development Economics',
  'Journal of Public Economics', 'Journal of International Economics',
  'American Journal of Agricultural Economics', 'Journal of Comparative Economics',
  'Economic Development and Cultural Change', 'Industrial and Labor Relations Review',
  'British Journal of Industrial Relations', 'Journal of Population Economics',
  'Labour Economics', 'Journal of Human Resources', 'Journal of Labor Economics',
  'Review of Economics and Statistics', 'Energy Economics',
  'Journal of Policy Analysis and Management', 'Personnel Psychology',
  'Public Administration Review', 'Empirical Economics', 'National Tax Journal',
  'Journal of Applied Econometrics',
];
const bases = ONE_VENUE ? [ONE_VENUE] : BASE;
// "The"-prefix + &-entity variants so we catch the corpus's stored forms.
const VENUES = [...new Set(bases.flatMap((b) => {
  const amp = b.replace(/&/g, '&amp;');
  return [b, 'The ' + b, amp, 'The ' + amp];
}))];

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const authors = (a) => Array.isArray(a) ? a.map((x) => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean).join('; ') : '';

const rows = [];
const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb.from('works')
    .select('venue,title,canonical_doi,year,authors,citation_count')
    .in('venue', VENUES).is('abstract', null).is('canonical_work_id', null)
    .not('is_noise', 'is', true).not('canonical_doi', 'is', null).gte('year', YEAR_MIN)
    .order('venue', { ascending: true }).order('citation_count', { ascending: false, nullsFirst: false })
    .range(from, from + PAGE - 1);
  if (error) { console.error('query error:', error.message); break; }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < PAGE) break;
}

const byVenue = new Map();
for (const r of rows) byVenue.set(r.venue, (byVenue.get(r.venue) || 0) + 1);
console.log(`applied-econ missing abstracts (year>=${YEAR_MIN}, non-noise, with DOI): ${rows.length}`);
[...byVenue.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log(`  ${String(n).padStart(5)}  ${v}`));

const header = ['Title', 'DOI', 'Year', 'Authors', 'Venue', 'Abstract'];
const lines = [header.join(',')];
for (const r of rows) lines.push([csvCell(r.title), csvCell(r.canonical_doi), csvCell(r.year), csvCell(authors(r.authors)), csvCell(r.venue), ''].join(','));
const date = new Date().toISOString().slice(0, 10);
const path = `reports/applied-econ-missing-abstracts-${date}.csv`;
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(path, '﻿' + lines.join('\r\n'));   // BOM + CRLF for Excel
console.log(`\nWritten: ${path} (${rows.length} rows, Abstract column blank for harvest)`);
