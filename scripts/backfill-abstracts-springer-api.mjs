#!/usr/bin/env node
/**
 * Springer Nature meta/v2 API abstract backfill (2026-07-01).
 *
 * Free tier: 1000 req/day, ~4 concurrent. Covers all Springer Nature journals
 * (10.1007 DOI prefix). Returns abstract field directly in JSON.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-springer-api.mjs
 *   node --env-file=.env scripts/backfill-abstracts-springer-api.mjs --dry-run --limit 20
 *   node --env-file=.env scripts/backfill-abstracts-springer-api.mjs --year-min 2005
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SPRINGER_KEY = process.env.SPRINGER_API_KEY;
if (!SPRINGER_KEY) { console.error('SPRINGER_API_KEY not set in .env'); process.exit(1); }

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;
const YEAR_MIN = parseInt(flag('--year-min', '0')) || 0;
const CONCURRENCY = 4;
const SLEEP_MS = 500;
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = `reports/abstracts-springer-api-filled-ids-${TODAY}.json`;

const clean = s => (s || '').replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function titleMatch(a, b) {
  const norm = t => String(t||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const wa = new Set(norm(a).split(' ').filter(w=>w.length>3));
  const wb = new Set(norm(b).split(' ').filter(w=>w.length>3));
  if (!wa.size || !wb.size) return true;
  let hit=0; for (const w of wb) if (wa.has(w)) hit++;
  return hit/Math.min(wa.size,wb.size) >= 0.5;
}

async function fetchSpringerAbstract(doi) {
  const url = `https://api.springernature.com/meta/v2/json?q=doi:${encodeURIComponent(doi)}&api_key=${SPRINGER_KEY}&p=1`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { await sleep(5000 * attempt); continue; }
      if (!res.ok) return null;
      const d = await res.json();
      const rec = d.records?.[0];
      if (!rec) return null;
      return { title: clean(rec.title || ''), abstract: clean(rec.abstract || '') };
    } catch { if (attempt === 3) return null; await sleep(2000 * attempt); }
  }
  return null;
}

// Load targets: 10.1007 DOI prefix, null abstract — keyset by id
let targets = [];
let cursor = '';
while (targets.length < LIMIT) {
  let q = sb.from('works').select('id,title,year')
    .ilike('id', '10.1007%').is('abstract', null)
    .is('canonical_work_id', null).not('is_noise', 'is', true)
    .order('id', { ascending: true }).limit(1000);
  if (YEAR_MIN) q = q.gte('year', YEAR_MIN);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q;
  if (error || !data?.length) break;
  targets.push(...data);
  cursor = data[data.length-1].id;
  if (data.length < 1000) break;
}
targets = targets.slice(0, LIMIT);
console.log(`\nSpringer API backfill | targets: ${targets.length} | dry: ${DRY} | key: ...${SPRINGER_KEY.slice(-8)}\n`);

let filled = 0, noAbs = 0, mism = 0, errors = 0;
const filledIds = [];
let done = 0;

async function processOne(w) {
  const rec = await fetchSpringerAbstract(w.id);
  if (!rec) { errors++; return; }
  if (!rec.abstract || rec.abstract.length < 60) { noAbs++; return; }
  if (!titleMatch(rec.title, w.title)) { mism++; return; }
  if (!DRY) {
    const { data: row } = await sb.from('works').select('raw_data').eq('id', w.id).single();
    const { error } = await sb.from('works').update({
      abstract: rec.abstract,
      raw_data: { ...(row?.raw_data||{}), abstract_backfill: { source: 'springer_api', matched_at: new Date().toISOString() } }
    }).eq('id', w.id).is('abstract', null);
    if (error) { errors++; return; }
  }
  filled++; filledIds.push(w.id);
}

for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = targets.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(w => processOne(w).then(() => { done++; })));
  process.stdout.write(`\r  ${done}/${targets.length} | filled ${filled} | noAbs ${noAbs} | mism ${mism} | err ${errors}   `);
  await sleep(SLEEP_MS);
}
process.stdout.write('\n');
console.log(`\n=== Done ===\nFilled: ${filled} | noAbstract: ${noAbs} | mismatch: ${mism} | errors: ${errors}`);
if (!DRY && filledIds.length) {
  fs.writeFileSync(OUT, JSON.stringify(filledIds));
  console.log(`Filled IDs → ${OUT}`);
  console.log(`Next: node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --ids-file ${OUT}`);
}
