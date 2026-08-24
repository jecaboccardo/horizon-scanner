#!/usr/bin/env node
/**
 * Corpus-wide repair: find `works` rows whose array-typed JSONB columns hold a
 * JSON-ENCODED STRING instead of an array (e.g. authors stored as
 * '["Gaaitzen J. de Vries","Elisabetta Gentile"]' — a string, not an array).
 *
 * Origin: a legacy OpenAlex ingest (~2026-04) wrote stringified arrays into jsonb
 * columns. On a search, vectorSearch reads `row.authors ?? []` (string passes
 * through) → synthesis stores it in the brief verbatim → BriefView crashes on
 * `authors.slice(...).join(...)` (String.slice returns a string, no .join). The
 * retrieval upsert ALSO coerces non-arrays to [] (paperToRow), silently ERASING
 * the names on every search. This recovers them before they erode.
 *
 * Scans EVERY works row (keyset paginated by id). For each at-risk JSONB array
 * column, if the value is a non-null non-array it is parsed back to a real array
 * (JSON.parse a "[...]" string; wrap a plain string). text[] columns (geography,
 * ux_region) can't hold a scalar — they're report-only sanity checks (expect 0).
 *
 * 🔒 Touches only the listed columns on `works`. Golden-rule aligned: it REPAIRS a
 * malformed populated value into its correct array form (never nulls real data).
 *
 *   node --env-file=.env scripts/repair-works-stringified-arrays.mjs --dry-run
 *   node --env-file=.env scripts/repair-works-stringified-arrays.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

// jsonb array columns we will REPAIR; text[] columns we only REPORT (immune by type).
const JSONB_ARRAY_COLS = ['authors', 'fields_of_study', 'scl_topics'];
const TEXTARR_COLS = ['geography', 'ux_region'];
const ALL = [...JSONB_ARRAY_COLS, ...TEXTARR_COLS];

function toArrParsed(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

const PAGE = 1000;
let cursor = '';
let scanned = 0, updated = 0, errors = 0;
const bad = Object.fromEntries(ALL.map((c) => [c, { count: 0, samples: [] }]));
const fixIds = [];

for (;;) {
  let q = sb.from('works').select(`id, ${ALL.join(', ')}`).order('id', { ascending: true }).limit(PAGE);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q;
  if (error) { console.error('scan:', error.message); break; }
  if (!data?.length) break;

  for (const row of data) {
    scanned++;
    const patch = {};
    for (const c of ALL) {
      const v = row[c];
      if (v != null && !Array.isArray(v)) {
        bad[c].count++;
        if (bad[c].samples.length < 8) bad[c].samples.push({ id: row.id, typ: typeof v, val: JSON.stringify(v).slice(0, 90) });
        if (JSONB_ARRAY_COLS.includes(c)) patch[c] = toArrParsed(v); // only repair jsonb cols
      }
    }
    if (Object.keys(patch).length) {
      fixIds.push(row.id);
      if (APPLY) {
        const { error: e } = await sb.from('works').update(patch).eq('id', row.id);
        if (e) { errors++; if (errors <= 5) console.error('update', row.id, e.message); } else updated++;
      }
    }
  }
  cursor = data[data.length - 1].id;
  process.stdout.write(`\r  scanned ${scanned} | bad authors=${bad.authors.count} fos=${bad.fields_of_study.count} scl=${bad.scl_topics.count} geo=${bad.geography.count} ux=${bad.ux_region.count} | ${APPLY ? 'updated ' + updated : 'toFix ' + fixIds.length}`);
  if (data.length < PAGE) break;
}

console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'DRY-RUN'} — scanned ${scanned} works ===`);
for (const c of ALL) {
  const kind = JSONB_ARRAY_COLS.includes(c) ? 'jsonb (repairable)' : 'text[] (report-only)';
  console.log(`\n${c}  [${kind}] — non-array values: ${bad[c].count}`);
  for (const s of bad[c].samples) console.log(`   ${s.id} [${s.typ}] ${s.val}`);
}
console.log(`\nrows needing repair: ${fixIds.length} | ${APPLY ? `updated: ${updated} | errors: ${errors}` : '(dry-run, no writes)'}`);

fs.mkdirSync('reports', { recursive: true });
const tag = APPLY ? 'apply' : 'dryrun';
fs.writeFileSync(`reports/works-stringified-arrays-${tag}-2026-06-26.json`,
  JSON.stringify({ generated_at: new Date().toISOString(), apply: APPLY, scanned, bad, fixIds }, null, 2));
console.log(`report -> reports/works-stringified-arrays-${tag}-2026-06-26.json`);
if (!APPLY) console.log('\nRe-run with --apply to parse the string values back into arrays.');
