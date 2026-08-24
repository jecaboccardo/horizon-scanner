#!/usr/bin/env node
// Derive works.ux_region (text[]) from works.geography — JS batched (small commits,
// low lock contention, resumable) because bulk single-statement UPDATEs on the wide
// `works` table (768-dim embedding + raw_data per row) rewrite the full row → huge
// IO + long lock holds that contend with live prod writes.
//
// 6 UX filter buckets; United States+Canada grouped as 'USA and Canada'; papers
// matching no bucket (empty geography, or East-Asia/Oceania/OECD-only) → ['Global'].
// Multi-value. Resumable: only rows where ux_region IS NULL. Keyset by id.
//   node --env-file=.env scripts/_ux-region-derive.mjs [--limit N]
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
// --fix-global: also RE-derive rows already tagged ['Global'] whose geography now
// maps (fixes stale values + the new Latin America / US / UK vocab). Writes only
// when the computed value differs. Default (no flag) = original ux_region IS NULL only.
const FIX_GLOBAL = process.argv.includes('--fix-global');
// --ids-file: FORCE re-derive ux_region for exactly these ids regardless of the
// current value (writes only when the computed value differs). Needed after a
// geography RE-extraction, where the stale ux_region is non-null AND non-Global
// (derived from the old wrong tag), so --fix-global can't reach it. Accepts
// ["id",...] or [{id},...].
const IDS_FILE = (() => { const i = process.argv.indexOf('--ids-file'); return i >= 0 ? process.argv[i + 1] : null; })();
const PAGE = 1000, CONCURRENCY = 25;
const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

const REGION_OF = new Map();
const add = (region, countries) => countries.forEach((c) => REGION_OF.set(c.toLowerCase(), region));
add('LAC', ['Brazil','Mexico','Colombia','Argentina','Chile','Peru','Ecuador','Bolivia','Uruguay','Paraguay','Venezuela','Costa Rica','Panama','Honduras','Guatemala','El Salvador','Nicaragua','Dominican Republic','Haiti','Jamaica','Trinidad and Tobago','Barbados','Guyana','Suriname','Belize','LAC','Central America','Caribbean','Latin America','Latin America and the Caribbean','Latin America and Caribbean','South America']);
add('Sub-Saharan Africa', ['Nigeria','Kenya','South Africa','Ethiopia','Ghana','Tanzania','Uganda','Africa']);
add('South & Southeast Asia', ['India','Pakistan','Bangladesh','Sri Lanka','Indonesia','Vietnam','Thailand','Philippines','Malaysia','Singapore','South Asia','Southeast Asia']);
add('USA and Canada', ['United States','Canada','US','USA']);
add('Europe & Central Asia', ['United Kingdom','Germany','France','Italy','Spain','Portugal','Netherlands','Sweden','Norway','Denmark','Finland','Switzerland','Austria','Belgium','Ireland','Greece','Poland','Turkey','Russia','Ukraine','Europe','UK']);
add('MENA', ['Egypt','Morocco','Middle East']);
// China/Japan/South Korea/Australia/New Zealand/OECD/East Asia → unmapped → Global

function uxRegion(geography) {
  const buckets = new Set();
  for (const tag of (geography || [])) {
    const r = REGION_OF.get(String(tag).toLowerCase());
    if (r) buckets.add(r);
  }
  return buckets.size ? [...buckets].sort() : ['Global'];
}

let cursor = '', done = 0, region = 0, global = 0, unchanged = 0;
const t0 = Date.now();

// IDS-FILE mode: force re-derive the listed rows (write only when different).
if (IDS_FILE) {
  const raw = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
  const ids = raw.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('works').select('id, geography, ux_region').in('id', ids.slice(i, i + 200));
    if (error) { console.error('fetch:', error.message); await new Promise(r => setTimeout(r, 3000)); i -= 200; continue; }
    for (let j = 0; j < (data || []).length; j += CONCURRENCY) {
      await Promise.all(data.slice(j, j + CONCURRENCY).map(async (w) => {
        const ux = uxRegion(w.geography);
        if (sameArr(ux, w.ux_region)) { unchanged++; return; }
        if (ux[0] === 'Global') global++; else region++;
        const { error: e } = await sb.from('works').update({ ux_region: ux }).eq('id', w.id);
        if (e) console.error(`  upd ${w.id}: ${e.message}`); else done++;
      }));
    }
    process.stdout.write(`\r  ${done} written (region=${region} global=${global} unchanged=${unchanged})   `);
  }
  console.log(`\nDone (ids-file). ${done} rows written (region=${region}, global=${global}), ${unchanged} unchanged, in ${((Date.now()-t0)/60000).toFixed(1)}m`);
  process.exit(0);
}

while (done + unchanged < LIMIT) {
  let q = sb.from('works').select('id, geography, ux_region')
    .is('canonical_work_id', null).not('is_noise', 'is', true)
    .order('id', { ascending: true }).limit(PAGE);
  if (FIX_GLOBAL) q = q.not('geography', 'eq', '{}').or('ux_region.is.null,ux_region.eq.{Global}');
  else q = q.is('ux_region', null);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q;
  if (error) { console.error('fetch:', error.message); await new Promise(r => setTimeout(r, 3000)); continue; }
  if (!data?.length) break;
  cursor = data[data.length - 1].id;
  for (let i = 0; i < data.length; i += CONCURRENCY) {
    const slice = data.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (w) => {
      const ux = uxRegion(w.geography);
      if (FIX_GLOBAL && sameArr(ux, w.ux_region)) { unchanged++; return; } // no-op — skip write
      if (ux[0] === 'Global') global++; else region++;
      const { error: e } = await sb.from('works').update({ ux_region: ux }).eq('id', w.id);
      if (e) console.error(`  upd ${w.id}: ${e.message}`);
      else done++;
    }));
  }
  const rate = done / ((Date.now() - t0) / 1000);
  process.stdout.write(`\r  ${done} written (region=${region} global=${global} unchanged=${unchanged}) ${rate.toFixed(0)}/s   `);
}
console.log(`\nDone. ${done} rows written (region=${region}, global=${global}), ${unchanged} unchanged, in ${((Date.now()-t0)/60000).toFixed(1)}m`);
