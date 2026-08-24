#!/usr/bin/env node
/**
 * Revert OpenAlex-mis-merge venues wrongly written by backfill-venue-ss-mag-openalex.mjs.
 *
 * OpenAlex returns a garbage `primary_location.source` (e.g. "Medical Entomology and
 * Zoology", "CERN Document Server", "Journal of Chemical Physics") mis-merged onto
 * unrelated econ/dev works. The MAG hop copied those. This sets venue back to NULL for
 * ss: rows whose written venue matches a clearly non-economics topical pattern — a wrong
 * venue is worse than blank, and these titles are econ/social-science (verified by audit).
 *
 * Scope: canonical non-noise ss: rows with a non-null venue matching NONECON_VENUE_RE.
 * Only nulls venue. Dry-run by default.
 *
 * Usage:
 *   node --env-file=.env scripts/revert-bad-ss-venues-2026-06-22.mjs --dry-run
 *   node --env-file=.env scripts/revert-bad-ss-venues-2026-06-22.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY_RUN = process.argv.includes('--dry-run');

// Clearly non-economics venue topics. An econ-corpus paper carrying one of these as its
// OpenAlex source is a mis-merge (audited: titles are econ/dev/social-science).
const NONECON_VENUE_RE = /entomolog|zoolog|\bcern\b|nuclear|plasma physics|chemical physics|\bphysics\b|chemistr|nursing|nutrition|metabolism|endocrinolog|\bmedical\b|clinical|\bcancer\b|surgery|surgical|veterinar|astro|neuroscience|epidemiolog|\bkonseling\b|islamic thought|indian medical|bone|pediatr|cardiol|psychiatr|biolog|genetic|chemistry/i;

async function main() {
  console.log(`\n=== Revert mis-merge ss: venues ===\nDry run: ${DRY_RUN}\n`);
  const rows = [];
  let cursor = '';
  while (true) {
    let q = sb.from('works').select('id, venue, title')
      .not('venue', 'is', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .like('id', 'ss:%').order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data); cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  const bad = rows.filter(r => NONECON_VENUE_RE.test(r.venue || ''));
  console.log(`venued ss: rows: ${rows.length} | matching non-econ mis-merge pattern: ${bad.length}\n`);
  const byV = {};
  for (const r of bad) byV[r.venue] = (byV[r.venue] || 0) + 1;
  Object.entries(byV).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log('  ', String(n).padStart(4), v));

  if (DRY_RUN) { console.log(`\nDRY-RUN — would null venue on ${bad.length} rows.`); return; }
  let reverted = 0, errors = 0;
  for (const r of bad) {
    const { error } = await sb.from('works').update({ venue: null }).eq('id', r.id);
    if (error) { errors++; continue; }
    reverted++;
  }
  console.log(`\nReverted ${reverted} venues to null (errors ${errors}).`);
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/revert-bad-ss-venues-2026-06-22.json', JSON.stringify({ generated_at: new Date().toISOString(), reverted, errors, by_venue: byV }, null, 2));
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
