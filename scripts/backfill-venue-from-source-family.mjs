#!/usr/bin/env node
/**
 * Deterministic venue label from source_family — for null-venue institutional /
 * working-paper rows whose host isn't in Crossref/S2/OpenAlex as a journal venue.
 *
 * Gap-only: canonical non-noise rows where venue IS NULL and source_family is set
 * and maps to a known label. Only writes venue. No API calls.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-venue-from-source-family.mjs --dry-run
 *   node --env-file=.env scripts/backfill-venue-from-source-family.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY_RUN = process.argv.includes('--dry-run');

// source_family -> venue label. Working-paper families get a series label; institutions
// get the institution name. Only families we can label confidently are listed.
const LABEL = {
  'IADB': 'Inter-American Development Bank',
  'World Bank': 'World Bank',
  'WB': 'World Bank',
  'NBER': 'NBER Working Papers',
  'OECD': 'OECD',
  'IMF': 'IMF Working Papers',
  'IZA': 'IZA Discussion Papers',
  'CEPR': 'CEPR Discussion Papers',
  'CEPR_REPEC': 'CEPR Discussion Papers',
  'RePEc': 'RePEc: Research Papers in Economics',
  'SSRN': 'SSRN Electronic Journal',
};

async function main() {
  console.log(`\n=== Venue from source_family ===\nDry run: ${DRY_RUN}\n`);
  const rows = [];
  let cursor = '';
  while (true) {
    let q = sb.from('works').select('id, source_family, title')
      .is('venue', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .not('source_family', 'is', null).order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data); cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  console.log(`null-venue rows with a source_family: ${rows.length}`);

  let filled = 0, unmapped = 0, errors = 0;
  const byLabel = {};
  for (const r of rows) {
    const venue = LABEL[r.source_family];
    if (!venue) { unmapped++; continue; }
    byLabel[venue] = (byLabel[venue] || 0) + 1;
    if (DRY_RUN) { filled++; continue; }
    const { error } = await sb.from('works').update({ venue }).eq('id', r.id);
    if (error) { errors++; continue; }
    filled++;
  }
  console.log(`\n${DRY_RUN ? 'would fill' : 'filled'}: ${filled} | unmapped source_family: ${unmapped} | errors: ${errors}`);
  console.log('by label:'); Object.entries(byLabel).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', String(v).padStart(4), k));
  if (!DRY_RUN) {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/venue-from-source-family-2026-06-22.json', JSON.stringify({ generated_at: new Date().toISOString(), filled, unmapped, errors, byLabel }, null, 2));
  }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
