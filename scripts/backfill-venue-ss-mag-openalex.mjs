#!/usr/bin/env node
/**
 * Venue recovery for ss: working-paper rows via MAG -> OpenAlex.
 *
 * S2 has the paper but no venue; it DOES carry a MAG id in externalIds. OpenAlex
 * absorbed MAG and can be queried by mag:<id> (or by doi if S2 has one) to get the
 * host source/venue S2 lacks.
 *
 * Hop: S2 batch (ss paperId -> externalIds{MAG,DOI}) -> OpenAlex /works/mag:<id>
 *      (or /works/https://doi.org/<doi>) -> primary_location.source.display_name.
 *
 * Gap-only: canonical non-noise rows where venue IS NULL, id LIKE 'ss:%'. Only writes venue.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-venue-ss-mag-openalex.mjs --dry-run [--limit N]
 *   node --env-file=.env scripts/backfill-venue-ss-mag-openalex.mjs [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();
const SS_KEY = process.env.SS_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || '';
const MAILTO = process.env.OPENALEX_MAILTO || 'horizon-scanner@iadb.org';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanVenue = (v) => { const s = v ? String(v).trim() : ''; return s.length > 1 ? s : null; };

async function ssExternalIds(paperIds) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds';
  const headers = { 'Content-Type': 'application/json' }; if (SS_KEY) headers['x-api-key'] = SS_KEY;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ids: paperIds }), signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * (a + 1)); continue; }
      if (!res.ok) { console.error(`  [SS ${res.status}]`); return new Array(paperIds.length).fill(null); }
      return await res.json();
    } catch (e) { console.error(`  ss err ${e.message}`); await sleep(2000); }
  }
  return new Array(paperIds.length).fill(null);
}

async function oaVenue(path) {
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(`https://api.openalex.org/works/${path}?mailto=${MAILTO}&select=primary_location,locations`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { await sleep(2000 * a); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      return j?.primary_location?.source?.display_name
        || (j?.locations || []).map(l => l.source?.display_name).find(Boolean) || null;
    } catch { await sleep(1000); }
  }
  return null;
}

async function main() {
  console.log(`\n=== ss: venue via MAG->OpenAlex ===\nDry run: ${DRY_RUN} | SS key: ${SS_KEY ? 'yes' : 'NO'}\n`);
  const rows = [];
  let cursor = '';
  while (rows.length < LIMIT) {
    let q = sb.from('works').select('id, title').is('venue', null).is('canonical_work_id', null)
      .not('is_noise', 'is', true).like('id', 'ss:%').order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data); cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  const targets = rows.slice(0, LIMIT);
  console.log(`ss: null-venue targets: ${targets.length}`);

  let filled = 0, noMag = 0, oaNoVenue = 0, errors = 0;
  const start = Date.now();
  const SS_BATCH = 100, OA_CONC = 6;

  for (let i = 0; i < targets.length; i += SS_BATCH) {
    const batch = targets.slice(i, i + SS_BATCH);
    const ext = await ssExternalIds(batch.map(r => r.id.replace(/^ss:/, '')));
    // build lookup tasks
    const tasks = batch.map((row, k) => {
      const e = ext[k]?.externalIds || ext[k] || {};
      const mag = e.MAG || e.Mag || e.mag;
      const doi = e.DOI || e.doi;
      if (mag) return { row, path: `mag:${mag}` };
      if (doi) return { row, path: `https://doi.org/${String(doi).toLowerCase()}` };
      return { row, path: null };
    });
    for (let j = 0; j < tasks.length; j += OA_CONC) {
      const slice = tasks.slice(j, j + OA_CONC);
      const venues = await Promise.all(slice.map(t => t.path ? oaVenue(t.path) : Promise.resolve(null)));
      for (let s = 0; s < slice.length; s++) {
        const { row, path } = slice[s];
        if (!path) { noMag++; continue; }
        const venue = cleanVenue(venues[s]);
        if (!venue) { oaNoVenue++; continue; }
        if (DRY_RUN) { if (filled < 40) console.log(`  [dry] ${row.id.slice(0, 14)} -> "${venue.slice(0, 50)}"`); filled++; continue; }
        const { error } = await sb.from('works').update({ venue }).eq('id', row.id);
        if (error) { errors++; continue; }
        filled++;
      }
      await sleep(250);
    }
    process.stdout.write(`\r  ${Math.min(i + SS_BATCH, targets.length)}/${targets.length} (filled ${filled}, noMag ${noMag}, oaNoVenue ${oaNoVenue}, err ${errors})   `);
  }

  const summary = { generated_at: new Date().toISOString(), dry_run: DRY_RUN, targets: targets.length, venue_filled: filled, no_mag_or_doi: noMag, oa_no_venue: oaNoVenue, errors, elapsed_min: ((Date.now() - start) / 60000).toFixed(1) };
  console.log(`\n\n=== Done ===\n${JSON.stringify(summary, null, 2)}`);
  if (!DRY_RUN) { fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync('reports/venue-ss-mag-openalex-2026-06-22.json', JSON.stringify(summary, null, 2)); }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
