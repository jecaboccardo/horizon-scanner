#!/usr/bin/env node
/**
 * Venue backfill via Semantic Scholar batch API — the "afterwards" pass for
 * null-venue rows Crossref couldn't fill (no container-title / not in Crossref).
 *
 * Targets canonical non-noise rows where venue IS NULL and id LIKE '10.%'.
 * Gap-only: only writes venue where it is currently null. Never touches other cols.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-venue-s2.mjs --dry-run [--limit N]
 *   node --env-file=.env scripts/backfill-venue-s2.mjs [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();
const SS_API_KEY = process.env.SS_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || '';
const BATCH = 200;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBatch(dois) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=venue,publicationVenue';
  const ids = dois.map(d => `DOI:${d}`);
  const headers = { 'Content-Type': 'application/json' };
  if (SS_API_KEY) headers['x-api-key'] = SS_API_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) { console.error(`\n  [SS ${res.status}]`); return new Array(dois.length).fill(null); }
      return await res.json();
    } catch (e) { console.error(`\n  fetch err: ${e.message}`); await sleep(2000); }
  }
  return new Array(dois.length).fill(null);
}

const venueOf = (ss) => {
  const v = ss?.publicationVenue?.name || ss?.venue;
  const s = v ? String(v).trim() : '';
  return s.length > 1 ? s : null;
};

async function main() {
  console.log(`\n=== Venue backfill (Semantic Scholar) ===\nDry run: ${DRY_RUN} | API key: ${SS_API_KEY ? 'yes' : 'NO (lower rate)'}\n`);
  const rows = [];
  let cursor = '';
  while (rows.length < LIMIT) {
    let q = sb.from('works').select('id, canonical_doi, title')
      .is('venue', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .like('id', '10.%').order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  const targets = rows.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} null-venue rows with DOI`);

  let filled = 0, noVenue = 0, errors = 0;
  const start = Date.now();
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await fetchBatch(batch.map(r => r.canonical_doi || r.id));
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const venue = venueOf(results[j]);
      if (!venue) { noVenue++; continue; }
      if (DRY_RUN) { if (filled < 25) console.log(`  [dry] ${row.id} -> "${venue.slice(0, 50)}"`); filled++; continue; }
      const { error } = await sb.from('works').update({ venue }).eq('id', row.id);
      if (error) { console.error(`update ${row.id}:`, error.message); errors++; continue; }
      filled++;
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} (filled ${filled}, noVenue ${noVenue}, err ${errors})   `);
    await sleep(1100); // ~1 req/s without key; polite with key
  }
  const summary = { generated_at: new Date().toISOString(), dry_run: DRY_RUN, targets: targets.length, venue_filled: filled, no_venue_in_s2: noVenue, errors, elapsed_min: ((Date.now() - start) / 60000).toFixed(1) };
  console.log(`\n\n=== Done ===\n${JSON.stringify(summary, null, 2)}`);
  if (!DRY_RUN) { fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync('reports/venue-s2-2026-06-22.json', JSON.stringify(summary, null, 2)); }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
