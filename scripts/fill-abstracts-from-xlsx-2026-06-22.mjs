#!/usr/bin/env node
/**
 * Fill abstracts from D:/Downloads/papers_with_abstracts.xlsx (cols: Title, DOI, Year,
 * Authors, Abstract). Gap-only: only writes abstract where the matched row currently has
 * a NULL abstract (golden rule — never overwrites a populated abstract). Matches by DOI
 * (works.id, fallback canonical_doi). Canonical non-noise only.
 *
 * Writes reports/abstracts-from-xlsx-filled-ids-2026-06-22.json (the ids that got a new
 * abstract) for the re-embed step.
 *
 * Usage:
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-22.mjs --dry-run
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-22.mjs
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
const XLSX_PATH = fileArg || 'D:/Downloads/papers_with_abstracts.xlsx';
const OUT_IDS = `reports/abstracts-from-xlsx-filled-ids-${(XLSX_PATH.match(/([^/\\]+)\.xlsx$/)?.[1] || 'file')}.json`;

const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const xrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
const byDoi = new Map();
let skipped = 0;
for (const r of xrows) {
  const doi = normDoi(r.DOI);
  const abs = r.Abstract ? String(r.Abstract).trim() : '';
  if (!doi) continue;
  // SHARED guard (scripts/lib/abstract-quality.mjs). This script ORIGINALLY accepted any
  // abstract > 20 chars with NO stub guard — that wrote ~503 "Abstract available at: <link>"
  // stubs into the corpus (found + reverted 2026-06-24). Never relax this back to a length-only check.
  if (isApparatusTitle(r.Title) || !isRealAbstract(abs)) { skipped++; continue; }
  byDoi.set(doi, abs);
}
console.log(`xlsx rows: ${xrows.length} | REAL abstracts (DOI + real): ${byDoi.size} | skipped stub/placeholder/short: ${skipped}\n`);

const dois = [...byDoi.keys()];
let matched = 0, filled = 0, alreadyHad = 0, notFound = 0, noiseSkip = 0, errors = 0;
const filledIds = [];
const foundIds = new Set();

// Pass 1: match by works.id
for (const batch of chunk(dois, 200)) {
  const { data, error } = await sb.from('works')
    .select('id, abstract, is_noise, canonical_work_id')
    .in('id', batch);
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
const unmatched = dois.filter(d => !foundIds.has(d));
for (const batch of chunk(unmatched, 200)) {
  const { data, error } = await sb.from('works')
    .select('id, canonical_doi, abstract, is_noise, canonical_work_id')
    .in('canonical_doi', batch);
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
  console.log(`\nFilled ids -> ${OUT_IDS} (${filledIds.length})`);
} else {
  console.log(`\n[dry-run] would fill ${filled} abstracts.`);
}
