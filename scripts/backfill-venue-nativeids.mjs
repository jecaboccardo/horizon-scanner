#!/usr/bin/env node
/**
 * Venue backfill for non-DOI ids via their NATIVE id (not DOI):
 *   ss:<paperId>   -> Semantic Scholar /paper/batch by paperId (fields venue,publicationVenue)
 *   oa:<workId>    -> OpenAlex /works/<W...> primary_location.source.display_name
 *
 * Gap-only: only canonical non-noise rows where venue IS NULL. Only writes venue.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-venue-nativeids.mjs --dry-run [--limit N]
 *   node --env-file=.env scripts/backfill-venue-nativeids.mjs [--limit N]
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

async function loadNullVenue(prefix) {
  const rows = []; let cursor = '';
  while (rows.length < LIMIT) {
    let q = sb.from('works').select('id, title').is('venue', null).is('canonical_work_id', null)
      .not('is_noise', 'is', true).like('id', `${prefix}%`).order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data); cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return rows.slice(0, LIMIT);
}

async function ssBatch(paperIds) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=venue,publicationVenue';
  const headers = { 'Content-Type': 'application/json' }; if (SS_KEY) headers['x-api-key'] = SS_KEY;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ids: paperIds }), signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * (attempt + 1)); continue; }
      if (!res.ok) { console.error(`  [SS ${res.status}]`); return new Array(paperIds.length).fill(null); }
      return await res.json();
    } catch (e) { console.error(`  ss err ${e.message}`); await sleep(2000); }
  }
  return new Array(paperIds.length).fill(null);
}

async function oaWork(workId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.openalex.org/works/${workId}?mailto=${MAILTO}`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      return j?.primary_location?.source?.display_name
        || (j?.locations || []).map(l => l.source?.display_name).find(Boolean) || null;
    } catch { await sleep(1000); }
  }
  return null;
}

async function main() {
  console.log(`\n=== Venue backfill for native ids (ss:/oa:) ===\nDry run: ${DRY_RUN} | SS key: ${SS_KEY ? 'yes' : 'NO'}\n`);
  let filled = 0, noVenue = 0, errors = 0;
  const start = Date.now();

  // ---- oa: via OpenAlex ----
  const oaRows = await loadNullVenue('oa:');
  console.log(`oa: targets ${oaRows.length}`);
  for (const r of oaRows) {
    const venue = cleanVenue(await oaWork(r.id.replace(/^oa:/, '')));
    if (!venue) { noVenue++; continue; }
    if (DRY_RUN) { console.log(`  [dry oa] ${r.id} -> "${venue}"`); filled++; continue; }
    const { error } = await sb.from('works').update({ venue }).eq('id', r.id);
    if (error) { errors++; continue; } filled++;
    await sleep(120);
  }

  // ---- ss: via Semantic Scholar batch ----
  const ssRows = await loadNullVenue('ss:');
  console.log(`ss: targets ${ssRows.length}`);
  const BATCH = 100;
  for (let i = 0; i < ssRows.length; i += BATCH) {
    const batch = ssRows.slice(i, i + BATCH);
    const results = await ssBatch(batch.map(r => r.id.replace(/^ss:/, '')));
    for (let j = 0; j < batch.length; j++) {
      const venue = cleanVenue(results[j]?.publicationVenue?.name || results[j]?.venue);
      if (!venue) { noVenue++; continue; }
      if (DRY_RUN) { if (filled < 40) console.log(`  [dry ss] ${batch[j].id.slice(0, 14)} -> "${venue.slice(0, 45)}"`); filled++; continue; }
      const { error } = await sb.from('works').update({ venue }).eq('id', batch[j].id);
      if (error) { errors++; continue; } filled++;
    }
    process.stdout.write(`\r  ss ${Math.min(i + BATCH, ssRows.length)}/${ssRows.length} (filled ${filled}, noVenue ${noVenue}, err ${errors})   `);
    await sleep(1200);
  }

  const summary = { generated_at: new Date().toISOString(), dry_run: DRY_RUN, oa_targets: oaRows.length, ss_targets: ssRows.length, venue_filled: filled, no_venue: noVenue, errors, elapsed_min: ((Date.now() - start) / 60000).toFixed(1) };
  console.log(`\n\n=== Done ===\n${JSON.stringify(summary, null, 2)}`);
  if (!DRY_RUN) { fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync('reports/venue-nativeids-2026-06-22.json', JSON.stringify(summary, null, 2)); }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
