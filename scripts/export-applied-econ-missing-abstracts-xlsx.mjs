#!/usr/bin/env node
/**
 * Export applied-economics journal papers MISSING a usable abstract → a real .xlsx
 * (Year, Title, DOI, Authors, Venue + blank Abstract column to fill on harvest).
 *
 * "Missing" = abstract IS NULL **or** a junk stub (<80 chars, or boilerplate like
 * "Not available" / "International audience" / "ABSTRACT" / "N/A"). The CSV sibling
 * (export-applied-econ-missing-abstracts.mjs) only caught NULL — this catches stubs too.
 *
 * Filters: canonical (canonical_work_id IS NULL), non-noise, has a DOI, in the
 * applied-econ venue set. Year floor optional (default none).
 *
 * Usage:
 *   node --env-file=.env scripts/export-applied-econ-missing-abstracts-xlsx.mjs
 *   node --env-file=.env scripts/export-applied-econ-missing-abstracts-xlsx.mjs --year-min 2000
 *   node --env-file=.env scripts/export-applied-econ-missing-abstracts-xlsx.mjs --venue "Journal of Public Economics"
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const YEAR_MIN = (() => { const i = args.indexOf('--year-min'); return i >= 0 ? Number(args[i + 1]) : null; })();
const ONE_VENUE = (() => { const i = args.indexOf('--venue'); return i >= 0 ? args[i + 1] : null; })();

// Applied-economics journals (mirrors the proquest "applied-econ" preset).
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
  'Journal of Applied Econometrics', 'World Development',
];
const bases = ONE_VENUE ? [ONE_VENUE] : BASE;
// "The"-prefix + &-entity variants so we catch the corpus's stored forms.
const VENUES = [...new Set(bases.flatMap((b) => {
  const amp = b.replace(/&/g, '&amp;');
  return [b, 'The ' + b, amp, 'The ' + amp];
}))];

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
console.log(`applied-econ scanned: ${rows.length} | MISSING usable abstract: ${missing.length}` + (YEAR_MIN != null ? ` (year>=${YEAR_MIN})` : ' (all years)'));
[...byVenue.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log(`  ${String(n).padStart(5)}  ${v}`));

const aoa = [['Year', 'Title', 'DOI', 'Authors', 'Venue', 'Abstract']];
for (const r of missing) aoa.push([r.year ?? '', r.title ?? '', r.canonical_doi ?? '', authors(r.authors), r.venue ?? '', '']);
const ws = XLSX.utils.aoa_to_sheet(aoa);
ws['!cols'] = [{ wch: 6 }, { wch: 70 }, { wch: 30 }, { wch: 40 }, { wch: 32 }, { wch: 60 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Missing abstracts');
const date = new Date().toISOString().slice(0, 10);
const path = `reports/applied-econ-missing-abstracts-${date}.xlsx`;
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(`\nWritten: ${path} (${missing.length} rows; Abstract column blank for harvest)`);
