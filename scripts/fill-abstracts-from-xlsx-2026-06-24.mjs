#!/usr/bin/env node
/**
 * Fill abstracts from papers_with_abstracts_final (1).xlsx (cols: Title, Venue, Year, DOI, Abstract).
 * Gap-only: only writes abstract where the matched corpus row currently has a NULL abstract
 * (golden rule — never overwrites a populated abstract). Matches by DOI (works.id, fallback
 * canonical_doi). Canonical non-noise only.
 *
 * 🔴 CONTAMINATION GUARDS specific to this file (audited 2026-06-24):
 *   - STUB: 333 rows are "See abstract at: <url>" pointers, NOT real abstracts -> dropped.
 *   - PLACEHOLDER: non-research short-form + "Springer Nature remains neutral..." award-note
 *     boilerplate (Kuznets-Prize entries) -> dropped.
 *   - DROP_DOIS: 2 rows have an abstract that belongs to a DIFFERENT paper (verified mismatch):
 *       10.1086/739830        "Glass Walls" (JPE) carried a Karnataka agriculture-services abstract.
 *       10.1016/j.jpubeco.2018.05.006  special-issue editorial header w/ a balanced-budget-rules abstract.
 *     A title/abstract token-overlap scan flagged 7/509 fill-targets; the other 5 were
 *     verified genuine matches (false positives of the heuristic) and are KEPT.
 *
 * Writes reports/abstracts-from-xlsx-filled-ids-<file>.json (ids that got a new abstract)
 * for the re-embed step (backfill-reembed-with-abstract.mjs --ids-file).
 *
 * Usage:
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-24.mjs --dry-run
 *   node --env-file=.env scripts/fill-abstracts-from-xlsx-2026-06-24.mjs
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
const XLSX_PATH = fileArg || 'D:/Downloads/papers_with_abstracts_final (1).xlsx';
const OUT_IDS = `reports/abstracts-from-xlsx-filled-ids-${(XLSX_PATH.match(/([^/\\]+)\.xlsx$/)?.[1] || 'file').replace(/[^\w.-]+/g, '_')}.json`;

const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// Placeholder/stub guard is the SHARED isRealAbstract (scripts/lib/abstract-quality.mjs) —
// do NOT re-inline a local copy. Divergent local copies caused the 503 link-stub fills
// ("Abstract available at: <link>") that polluted the corpus (found + reverted 2026-06-24).
const DROP_DOIS = new Set(['10.1086/739830', '10.1016/j.jpubeco.2018.05.006']);

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const xrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
const byDoi = new Map();
let skipPlaceholder = 0, skipDrop = 0;
for (const r of xrows) {
  const doi = normDoi(r.DOI);
  const abs = r.Abstract ? String(r.Abstract).trim() : '';
  if (!doi || !abs) continue;
  if (DROP_DOIS.has(doi)) { skipDrop++; continue; }
  if (isApparatusTitle(r.Title) || !isRealAbstract(abs)) { skipPlaceholder++; continue; }
  byDoi.set(doi, abs);
}
console.log(`xlsx rows: ${xrows.length} | REAL abstracts: ${byDoi.size} | skipped stub/placeholder/short: ${skipPlaceholder} | verified-mismatch drop: ${skipDrop}\n`);

const dois = [...byDoi.keys()];
let matched = 0, filled = 0, alreadyHad = 0, noiseSkip = 0, errors = 0;
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

console.log(`matched in corpus : ${matched}`);
console.log(`  abstract FILLED : ${filled}`);
console.log(`  already had abs : ${alreadyHad}`);
console.log(`  noise/shadow skip: ${noiseSkip}`);
console.log(`not found in corpus: ${byDoi.size - matched}`);
console.log(`errors            : ${errors}`);

if (!DRY_RUN) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT_IDS, JSON.stringify(filledIds, null, 2));
  console.log(`\nFilled ids -> ${OUT_IDS} (${filledIds.length})  [re-embed next]`);
} else {
  console.log(`\n[dry-run] would fill ${filled} abstracts.`);
}
