#!/usr/bin/env node
/**
 * Ingest externally-harvested abstracts (xlsx → JSON) into the corpus, matched
 * by DOI (venue-agnostic). 🔒 GAP-ONLY: writes `abstract` only when currently NULL.
 *
 * Works for ANY journal — the harvest JSON just needs {doi, abstract, title?}.
 * Optional `--title-venue "X"` enables a normalized-title fallback scoped to that
 * venue for rows whose DOI doesn't resolve (rarely needed; DOIs are reliable).
 *
 * Usage:
 *   node scripts/ingest-harvested-abstracts.mjs --file reports/<name>-abstracts.json            # dry-run
 *   node scripts/ingest-harvested-abstracts.mjs --file reports/<name>-abstracts.json --apply
 *   node scripts/ingest-harvested-abstracts.mjs --file ... --apply --source proquest_applied_econ
 *   ... --apply --title-venue "Energy Economics"   # enable title fallback for that venue
 *
 * On --apply it also writes reports/<name>-written-ids.json for the re-embed step:
 *   node scripts/backfill-reembed-with-abstract.mjs --ids-file reports/<name>-written-ids.json
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FILE = (() => { const i = args.indexOf('--file'); return i >= 0 ? args[i + 1] : null; })();
const SOURCE = (() => { const i = args.indexOf('--source'); return i >= 0 ? args[i + 1] : 'chrome_xlsx'; })();
const TITLE_VENUE = (() => { const i = args.indexOf('--title-venue'); return i >= 0 ? args[i + 1] : null; })();
if (!FILE) { console.error('Provide --file <harvest json>'); process.exit(1); }

const normDoi = (d) => String(d || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
const normTitle = (t) => String(t || '').toLowerCase().replace(/\s*\((en|es|pt|fr)\)\s*$/, '').replace(/[-‐‑‒–—]+/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const good = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length >= 80 && t.length <= 8000 ? t : null; };

const records = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const usable = records.map(r => ({ ...r, doi: normDoi(r.doi), abs: good(r.abstract) })).filter(r => r.abs && (r.doi || r.title));
console.log(`records: ${records.length} | usable abstract: ${usable.length} | apply: ${APPLY} | source: ${SOURCE}`);

const dois = [...new Set(usable.map(r => r.doi).filter(Boolean))];
const byKey = new Map();
for (let i = 0; i < dois.length; i += 150) {
  const chunk = dois.slice(i, i + 150);
  for (const col of ['id', 'canonical_doi']) {
    const { data } = await sb.from('works').select('id,canonical_doi,title,venue,abstract,raw_data,is_noise,canonical_work_id').in(col, chunk);
    for (const w of data || []) { byKey.set(normDoi(w.id), w); if (w.canonical_doi) byKey.set(normDoi(w.canonical_doi), w); }
  }
}

let matched = 0, alreadyHas = 0, noMatch = 0, noise = 0, shadow = 0, wrote = 0, errs = 0, titleMatched = 0;
const writtenIds = [], samples = [];
for (const r of usable) {
  let w = r.doi ? byKey.get(r.doi) : null, via = 'doi';
  if (!w && r.title && TITLE_VENUE) {
    const { data } = await sb.from('works').select('id,title,venue,abstract,raw_data,is_noise,canonical_work_id')
      .ilike('venue', TITLE_VENUE).is('abstract', null)
      .ilike('title', `%${String(r.title).slice(0, 40).replace(/[%_]/g, ' ')}%`).limit(50);
    w = (data || []).find(x => normTitle(x.title) === normTitle(r.title)) || null;
    if (w) { via = 'title'; titleMatched++; }
  }
  if (!w) { noMatch++; continue; }
  if (w.is_noise) { noise++; continue; }
  if (w.canonical_work_id) { shadow++; continue; }
  matched++;
  if (w.abstract && w.abstract.trim()) { alreadyHas++; continue; }
  if (samples.length < 6) samples.push(`${via} ${w.id} :: ${r.abs.slice(0, 64)}...`);
  if (APPLY) {
    const rd = { ...(w.raw_data || {}), abstract_backfill: { source: SOURCE, status: 'formal_abstract', via, matched_at: new Date().toISOString() } };
    const { error } = await sb.from('works').update({ abstract: r.abs, raw_data: rd }).eq('id', w.id).is('abstract', null);
    if (error) errs++; else { wrote++; writtenIds.push(w.id); }
  }
}
console.log(`\nmatched: ${matched} (title-only=${titleMatched}) | already had abstract: ${alreadyHas} | no corpus match: ${noMatch} | noise: ${noise} | shadow: ${shadow}`);
console.log(`GAP rows ${APPLY ? 'written' : 'WOULD write'}: ${APPLY ? wrote : (matched - alreadyHas)} | errors: ${errs}`);
samples.forEach(s => console.log('  ' + s));
if (APPLY) {
  const idsPath = FILE.replace(/\.json$/, '').replace(/-abstracts$/, '') + '-written-ids.json';
  fs.writeFileSync(idsPath, JSON.stringify({ ids: writtenIds }));
  console.log(`\nwrote ${writtenIds.length} ids → ${idsPath}  (feed to backfill-reembed-with-abstract.mjs --ids-file)`);
} else {
  console.log('\n(dry-run — re-run with --apply)');
}
