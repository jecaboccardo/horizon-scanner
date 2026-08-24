#!/usr/bin/env node
/**
 * Semantic Scholar (S2) abstract backfill (2026-07-07).
 *
 * Third-pass source after Crossref-JATS (at ingest) and OpenAlex: the S2 Graph
 * API's batch endpoint takes 500 DOIs per POST and carries abstracts for ~36%
 * of the Elsevier econ rows that OpenAlex/Crossref withhold (probed on
 * Ecological Economics 2026-07-07). Unauthenticated is fine at this scale
 * (17k rows = ~35 requests); honors S2_API_KEY if present.
 *
 * Gap-only (abstract IS NULL), title-overlap guard, shared isRealAbstract
 * quality gate, incremental filled-ids file for the re-embed step.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-s2.mjs --dry-run --limit 500
 *   node --env-file=.env scripts/backfill-abstracts-s2.mjs --corpus-source econ_gaps_2026_07,econ_gaps_w2_2026_07
 *   node --env-file=.env scripts/backfill-abstracts-s2.mjs --year-min 2010 --limit 5000
 *
 * Next: node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --ids-file <printed path>
 */
import fs from 'node:fs';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { isRealAbstract } from './lib/abstract-quality.mjs';
config();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;
const YEAR_MIN = flag('--year-min', null) ? Number(flag('--year-min', null)) : null;
const CORPUS_SOURCES = (flag('--corpus-source', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const S2_KEY = process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || null;
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = `reports/abstracts-s2-filled-ids-${TODAY}.json`;
const BATCH = 500;

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Same token-overlap guard as backfill-abstracts-springer-api.mjs: ≥50% of the
// shorter title's meaningful tokens must appear in the other.
function titleMatch(a, b) {
  const tok = (t) => new Set(clean(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4));
  const wa = tok(a), wb = tok(b);
  if (!wa.size || !wb.size) return false;
  let hit = 0; for (const w of wb) if (wa.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size) >= 0.5;
}

// Load targets: null abstract, has DOI, canonical, non-noise — keyset by id.
let targets = [];
let cursor = '';
while (targets.length < LIMIT) {
  let q = sb.from('works').select('id,title,year')
    .is('abstract', null).not('canonical_doi', 'is', null)
    .is('canonical_work_id', null).not('is_noise', 'is', true)
    .order('id', { ascending: true }).limit(1000);
  if (CORPUS_SOURCES.length) q = q.in('corpus_source', CORPUS_SOURCES);
  if (YEAR_MIN) q = q.gte('year', YEAR_MIN);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q;
  if (error) { console.error('target load error:', error.message); process.exit(1); }
  if (!data?.length) break;
  targets.push(...data);
  cursor = data[data.length - 1].id;
  if (data.length < 1000) break;
}
targets = targets.slice(0, LIMIT);
console.log(`\nS2 batch backfill | targets: ${targets.length} | dry: ${DRY} | key: ${S2_KEY ? 'yes' : 'no (public pool)'}\n`);
if (!targets.length) process.exit(0);

let filled = 0, noAbs = 0, mism = 0, notFound = 0, errors = 0;
const filledIds = [];

async function fetchBatch(rows) {
  const headers = { 'content-type': 'application/json', ...(S2_KEY ? { 'x-api-key': S2_KEY } : {}) };
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,abstract', {
        method: 'POST', headers,
        body: JSON.stringify({ ids: rows.map(r => 'DOI:' + r.id) }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) { await sleep(12000 * attempt); continue; }
      if (!res.ok) { await sleep(5000 * attempt); continue; }
      return await res.json();
    } catch { await sleep(5000 * attempt); }
  }
  return null;
}

for (let i = 0; i < targets.length; i += BATCH) {
  const rows = targets.slice(i, i + BATCH);
  const result = await fetchBatch(rows);
  if (!result) { errors += rows.length; console.error(`\n  batch ${i / BATCH + 1}: gave up after retries`); continue; }

  for (let j = 0; j < rows.length; j++) {
    const w = rows[j];
    const p = result[j];
    if (!p) { notFound++; continue; }
    const abs = clean(p.abstract);
    if (!abs || abs.length < 60 || !isRealAbstract(abs)) { noAbs++; continue; }
    if (!titleMatch(p.title, w.title)) { mism++; continue; }
    if (!DRY) {
      const { data: row } = await sb.from('works').select('raw_data').eq('id', w.id).single();
      const { error } = await sb.from('works').update({
        abstract: abs,
        raw_data: { ...(row?.raw_data || {}), abstract_backfill: { source: 'semantic_scholar', status: 'filled', matched_at: new Date().toISOString() } },
      }).eq('id', w.id);
      if (error) { errors++; continue; }
    }
    filled++; filledIds.push(w.id);
  }

  process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} | filled ${filled} | noAbs ${noAbs} | mism ${mism} | notFound ${notFound} | err ${errors}   `);
  if (!DRY && filledIds.length) {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(filledIds, null, 1)); // incremental — survives a kill
  }
  await sleep(S2_KEY ? 1100 : 3500);
}

console.log(`\n\n=== Done ===`);
console.log(`Filled: ${filled} | noAbstract: ${noAbs} | titleMismatch: ${mism} | notFound: ${notFound} | errors: ${errors}`);
if (!DRY && filledIds.length) {
  console.log(`Filled IDs → ${OUT}`);
  console.log(`Next: node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --ids-file ${OUT}`);
}
