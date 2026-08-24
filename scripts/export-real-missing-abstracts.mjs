#!/usr/bin/env node
/**
 * Export canonical papers that are FOR-REAL missing an abstract, with a single
 * `Status` column so you can tell apart the rows worth backfilling from the rows
 * that should be left alone (noise / venue-denylisted / journal apparatus).
 *
 * "For real missing" = `abstract IS NULL` on a canonical row (shadows excluded).
 * Stubs that were reverted to null by the 2026-06-24 abstract-quality fix are
 * therefore included; apparatus titles (front matter, editorials) are KEPT but
 * flagged `apparatus` because they legitimately have no abstract.
 *
 * Status (one column):
 *   clean           — non-noise, real title, worth a backfill attempt  ← the list you want
 *   apparatus       — front matter / editorial / erratum (legit no abstract; skip)
 *   venue-denylist  — venue is on data/corpus-venue-denylist.json (skip)
 *   noise           — is_noise = true (skip)
 *
 * Writes:
 *   reports/real-missing-abstracts-<date>.csv
 *   reports/real-missing-abstracts-<date>.xlsx
 *
 * Usage:
 *   node --env-file=.env scripts/export-real-missing-abstracts.mjs
 *   node --env-file=.env scripts/export-real-missing-abstracts.mjs --clean-only
 *   node --env-file=.env scripts/export-real-missing-abstracts.mjs --year-min 2000
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
import { isApparatusTitle, isRealAbstract } from './lib/abstract-quality.mjs';
import { loadVenueDenylist, isDeniedVenue } from './lib/venue-denylist.mjs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const args = process.argv.slice(2);
const CLEAN_ONLY = args.includes('--clean-only');
const YEAR_MIN = (() => { const i = args.indexOf('--year-min'); return i >= 0 ? Number(args[i + 1]) : null; })();

const denylist = loadVenueDenylist();
console.log(`Venue denylist: ${denylist.venues.length} venues loaded`);
console.log(`Mode: ${CLEAN_ONLY ? 'CLEAN rows only' : 'all rows, status-tagged'}${YEAR_MIN ? ` | year>=${YEAR_MIN}` : ''}\n`);

const authorsToStr = (a) => {
  if (!Array.isArray(a)) return '';
  return a.map((x) => (typeof x === 'string' ? x : (x?.name || x?.full_name || ''))).filter(Boolean).join('; ');
};
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function statusOf(r) {
  if (r.is_noise === true) return 'noise';
  if (isDeniedVenue(r.venue, denylist)) return 'venue-denylist';
  if (isApparatusTitle(r.title)) return 'apparatus';
  return 'clean';
}

const PAGE = 1000;
const rows = [];
let cursor = '';
const counts = { clean: 0, apparatus: 0, 'venue-denylist': 0, noise: 0 };
const t0 = Date.now();

while (true) {
  let q = sb.from('works')
    .select('id, canonical_doi, authors, title, venue, publication_type, year, citation_count, is_noise')
    .is('canonical_work_id', null)
    .is('abstract', null)
    .order('id', { ascending: true })
    .limit(PAGE);
  if (cursor) q = q.gt('id', cursor);
  if (YEAR_MIN) q = q.gte('year', YEAR_MIN);
  const { data, error } = await q;
  if (error) { console.error('fetch:', error.message); await new Promise(r => setTimeout(r, 2000)); continue; }
  if (!data?.length) break;
  cursor = data[data.length - 1].id;
  for (const r of data) {
    const status = statusOf(r);
    counts[status]++;
    if (CLEAN_ONLY && status !== 'clean') continue;
    rows.push({
      DOI: r.canonical_doi || (String(r.id).startsWith('10.') ? r.id : ''),
      Title: r.title || '',
      Venue: r.venue || '',
      Year: r.year ?? '',
      Authors: authorsToStr(r.authors),
      PublicationType: r.publication_type || '',
      CitationCount: r.citation_count ?? '',
      Noise: r.is_noise === true ? 'yes' : 'no',
      Status: status,
      WorkID: r.id,
    });
  }
  process.stdout.write(`\r  scanned ${counts.clean + counts.apparatus + counts['venue-denylist'] + counts.noise} | kept ${rows.length}`);
  if (data.length < PAGE) break;
}

console.log(`\n\nStatus breakdown (all missing-abstract canonical rows):`);
for (const k of ['clean', 'apparatus', 'venue-denylist', 'noise']) {
  console.log(`  ${String(counts[k]).padStart(7)}  ${k}`);
}

// ── Hardening (2026-06-26): drop rows that DUPLICATE an already-abstracted paper.
// The corpus can hold a paper twice — an abstract-less OpenAlex copy alongside the
// proper 10.3386/w<num> row that HAS the abstract. Such a row is "missing" per-row
// but the abstract already exists, so listing it sends sourcing effort to a dup.
// Targeted, efficient check: if the title carries an NBER WP number whose
// 10.3386/w<num> twin has a real abstract, exclude it. (The broader OpenAlex↔DOI
// duplication is resolved by dedup → canonical_work_id, which the canonical filter
// above already excludes; this is belt-and-suspenders for any not-yet-deduped dup.)
const wpNum = (t) => { const m = String(t || '').match(/\bno\.?\s*(\d{4,6})\b/i) || String(t || '').match(/\bw(\d{4,6})\b/i); return m ? m[1] : null; };
const twinByRow = new Map();
const twinIds = new Set();
for (const r of rows) {
  const n = wpNum(r.Title);
  if (n && (/nber/i.test(r.Venue) || /nber working paper/i.test(r.Title))) { const tw = `10.3386/w${n}`; twinByRow.set(r.WorkID, tw); twinIds.add(tw); }
}
const twinHasAbs = new Set();
const twinArr = [...twinIds];
for (let i = 0; i < twinArr.length; i += 200) {
  const { data } = await sb.from('works').select('id, abstract').in('id', twinArr.slice(i, i + 200));
  for (const w of (data || [])) if (w.abstract && isRealAbstract(w.abstract)) twinHasAbs.add(w.id);
}
const beforeLen = rows.length;
const keep = rows.filter((r) => { const tw = twinByRow.get(r.WorkID); return !(tw && twinHasAbs.has(tw)); });
const droppedDup = beforeLen - keep.length;
rows.length = 0; for (const r of keep) rows.push(r); // loop, not spread (100k+ would overflow the stack)
if (droppedDup) console.log(`\nHardening: excluded ${droppedDup} rows that duplicate an already-abstracted NBER twin (10.3386/w<num>).`);

console.log(`\nRows written: ${rows.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

const date = new Date().toISOString().slice(0, 10);
fs.mkdirSync('reports', { recursive: true });
const header = ['DOI', 'Title', 'Venue', 'Year', 'Authors', 'PublicationType', 'CitationCount', 'Noise', 'Status', 'WorkID'];

// CSV (UTF-8 BOM + CRLF for Excel)
const lines = [header.join(',')];
for (const r of rows) lines.push(header.map(h => csvCell(r[h])).join(','));
const csvPath = `reports/real-missing-abstracts-${date}.csv`;
fs.writeFileSync(csvPath, '﻿' + lines.join('\r\n'));

// XLSX
const ws = XLSX.utils.json_to_sheet(rows, { header });
ws['!cols'] = [{ wch: 28 }, { wch: 60 }, { wch: 30 }, { wch: 6 }, { wch: 32 }, { wch: 16 }, { wch: 8 }, { wch: 6 }, { wch: 16 }, { wch: 18 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Missing abstracts');
let xlsxPath = `reports/real-missing-abstracts-${date}.xlsx`;
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
try {
  fs.writeFileSync(xlsxPath, buf);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    // file open in Excel — write a fallback name so the run still produces an xlsx
    xlsxPath = `reports/real-missing-abstracts-${date}-${Date.now()}.xlsx`;
    fs.writeFileSync(xlsxPath, buf);
    console.log(`\n(default xlsx was locked — wrote fallback)`);
  } else throw e;
}

console.log(`\nWritten:\n  ${csvPath}\n  ${xlsxPath}`);
