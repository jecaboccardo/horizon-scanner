#!/usr/bin/env node
/**
 * Repair briefs whose persisted sections.evidenceRows[].authors (or .geography) were
 * stored as a JSON-ENCODED STRING instead of an array — e.g.
 *   authors: "[\"Gaaitzen J. de Vries\",\"Elisabetta Gentile\"]"   (a string)
 * This crashes BriefView (`row.authors.slice(0,2).join(...)` → "slice(...).join is not
 * a function", because String.slice returns a string with no .join). Root cause:
 * synthesis.ts built rows with `work.authors || []`, which passes a string through when
 * the live-retrieved paper carried a stringified author list.
 *
 * Coerces those fields back to real arrays (JSON.parse a "[...]" string; otherwise wrap a
 * plain string). Only writes when a brief actually changed. Touches the `briefs` table
 * only (NOT `works` — golden rule unaffected). Dry-run by default.
 *
 *   node --env-file=.env scripts/repair-brief-authors-arrays.mjs --dry-run
 *   node --env-file=.env scripts/repair-brief-authors-arrays.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

/** Coerce any value to a string[]. Parses a JSON-array string; wraps a plain string. */
function toStrArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

const PAGE = 500;
let from = 0, scanned = 0, affected = 0, fixedRows = 0, errors = 0;
const affectedIds = [];

for (;;) {
  const { data, error } = await sb.from('briefs').select('id, sections').range(from, from + PAGE - 1);
  if (error) { console.error('fetch:', error.message); break; }
  if (!data?.length) break;
  for (const b of data) {
    scanned++;
    const s = b.sections;
    const rows = s?.evidenceRows;
    if (!Array.isArray(rows)) continue;
    let changed = 0;
    for (const r of rows) {
      if (r.authors != null && !Array.isArray(r.authors)) { r.authors = toStrArray(r.authors); changed++; }
      if (r.geography != null && !Array.isArray(r.geography)) { r.geography = toStrArray(r.geography); changed++; }
    }
    if (changed > 0) {
      affected++; fixedRows += changed; affectedIds.push(b.id);
      if (APPLY) {
        const { error: e } = await sb.from('briefs').update({ sections: s }).eq('id', b.id);
        if (e) { errors++; console.error('update', b.id, e.message); }
      }
    }
  }
  from += PAGE;
  process.stdout.write(`\r  scanned ${scanned} | affected ${affected} | fields ${fixedRows}`);
}
console.log(`\n\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — briefs scanned=${scanned} affected=${affected} fieldsCoerced=${fixedRows} errors=${errors}`);
if (affectedIds.length) console.log('affected brief ids (first 20):', affectedIds.slice(0, 20));
if (!APPLY) console.log('\nRe-run with --apply to write the array coercion back.');
