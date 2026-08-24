#!/usr/bin/env node
/**
 * Fill abstracts from an xlsx (cols: Title, Venue, Year, Authors, DOI, Abstract).
 * Gap-only: only writes abstract where the matched row currently has a NULL abstract
 * (golden rule — never overwrites a populated abstract). Matches by DOI (works.id,
 * fallback canonical_doi). Canonical non-noise only.
 *
 * 🔴 PLACEHOLDER GUARD (2026-06-23): the source xlsx uses "No abstract available
 * (letter/correspondence/editorial | book review | acknowledgment | …)" for non-research
 * short-form items. Those strings are >20 chars and would pass a naive length filter →
 * a REAL abstract must be long AND not match the placeholder pattern.
 *
 * Writes reports/abstracts-from-xlsx-filled-ids-<file>.json (the ids that got a new
 * abstract) for the DEFERRED re-embed step.
 *
 * Usage:
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-23.mjs --file "D:/Downloads/papers_metadata (1).xlsx" --dry-run
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-23.mjs --file "D:/Downloads/papers_metadata (1).xlsx"
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
import { isRealAbstract, isApparatusTitle } from './lib/abstract-quality.mjs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();
const XLSX_PATH = fileArg || 'D:/Downloads/papers_metadata (1).xlsx';
const OUT_IDS = `reports/abstracts-from-xlsx-filled-ids-${(XLSX_PATH.match(/([^/\\]+)\.xlsx$/)?.[1] || 'file').replace(/[^\w.-]+/g, '_')}.json`;

const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// A real abstract guard = the SHARED isRealAbstract (scripts/lib/abstract-quality.mjs).
// The local copy here MISSED "Abstract available at: <link>" stubs → corpus pollution
// (found + reverted 2026-06-24). Do NOT re-inline a local placeholder regex.

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const xrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
const byDoi = new Map();
let skippedPlaceholder = 0;
for (const r of xrows) {
  const doi = normDoi(r.DOI);
  const abs = r.Abstract ? String(r.Abstract).trim() : '';
  if (!doi || !abs) continue;
  if (isApparatusTitle(r.Title) || !isRealAbstract(abs)) { skippedPlaceholder++; continue; }
  byDoi.set(doi, abs);
}
console.log(`xlsx rows: ${xrows.length} | REAL abstracts (DOI + real): ${byDoi.size} | skipped placeholder/short: ${skippedPlaceholder}\n`);

const dois = [...byDoi.keys()];
let matched = 0, filled = 0, alreadyHad = 0, notFound = 0, noiseSkip = 0, errors = 0;
const filledIds = [];
const foundIds = new Set();

// Pass 1: match by works.id
for (const batch of chunk(dois, 200)) {
  const { data, error } = await sb.from('works').select('id, abstract, is_noise, canonical_work_id').in('id', batch);
  if (error) { console.error('select by id:', error.message); continue; }
  for (const row of (data || [])) {
    foundIds.add(row.id.toLowerCase());
    matched++;
    if (row.canonical_work_id != null || row.is_noise === true) { noiseSkip++; continue; }
    if (row.abstract != null) { alreadyHad++; continue; }
    const abs = byDoi.get(row.id.toLowerCase());
    if (!abs) continue;
    if (DRY_RUN) { filled++; filledIds.push(row.id); continue; }
    const { error: e } = await sb.from('works').update({ abstract: abs }).eq('id', row.id);
    if (e) { errors++; continue; }
    filled++; filledIds.push(row.id);
  }
}

// Pass 2: DOIs not matched by id -> try canonical_doi
const unmatched = dois.filter((d) => !foundIds.has(d));
for (const batch of chunk(unmatched, 200)) {
  const { data, error } = await sb.from('works').select('id, canonical_doi, abstract, is_noise, canonical_work_id').in('canonical_doi', batch);
  if (error) { console.error('select by canonical_doi:', error.message); continue; }
  for (const row of (data || [])) {
    matched++;
    if (row.canonical_work_id != null || row.is_noise === true) { noiseSkip++; continue; }
    if (row.abstract != null) { alreadyHad++; continue; }
    const abs = byDoi.get(normDoi(row.canonical_doi));
    if (!abs) continue;
    if (DRY_RUN) { filled++; filledIds.push(row.id); continue; }
    const { error: e } = await sb.from('works').update({ abstract: abs }).eq('id', row.id);
    if (e) { errors++; continue; }
    filled++; filledIds.push(row.id);
  }
}
notFound = byDoi.size - matched;

console.log(`matched in corpus : ${matched}`);
console.log(`  abstract FILLED : ${filled}`);
console.log(`  already had abs : ${alreadyHad}`);
console.log(`  noise/shadow skip: ${noiseSkip}`);
console.log(`not found in corpus: ${notFound}`);
console.log(`errors            : ${errors}`);

if (!DRY_RUN) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT_IDS, JSON.stringify(filledIds, null, 2));
  console.log(`\nFilled ids -> ${OUT_IDS} (${filledIds.length})  [re-embed deferred]`);
} else {
  console.log(`\n[dry-run] would fill ${filled} abstracts.`);
}
