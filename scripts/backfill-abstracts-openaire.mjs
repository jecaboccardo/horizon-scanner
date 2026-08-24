#!/usr/bin/env node
/**
 * OpenAIRE abstract backfill (2026-07-07).
 *
 * Fourth-pass source after Crossref-JATS, OpenAlex, and Semantic Scholar.
 * OpenAIRE aggregates repository copies (RePEc, institutional repositories),
 * which carry abstracts the publisher APIs withhold — strict-probed 7/10 REAL
 * abstracts on Economics Letters rows that all three earlier passes missed.
 *
 * Batched: comma-separated DOIs (40/request), results mapped back via pid.
 * Junk guard: OpenAIRE descriptions include zbMATH license placeholders and
 * empty stubs — longest description per DOI must pass isRealAbstract + a
 * junk-pattern blacklist + title-overlap.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-openaire.mjs --dry-run --limit 200
 *   node --env-file=.env scripts/backfill-abstracts-openaire.mjs --corpus-source econ_gaps_2026_07,econ_gaps_w2_2026_07
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
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = `reports/abstracts-openaire-filled-ids-${TODAY}.json`;
const BATCH = 40;
const JUNK_RE = /zbMATH|contents unavailable|conflicting licenses|no abstract|not available/i;

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function titleMatch(a, b) {
  const tok = (t) => new Set(clean(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4));
  const wa = tok(a), wb = tok(b);
  if (!wa.size || !wb.size) return false;
  let hit = 0; for (const w of wb) if (wa.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size) >= 0.5;
}

// Load targets — same shape as backfill-abstracts-s2.mjs.
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
console.log(`\nOpenAIRE batch backfill | targets: ${targets.length} | dry: ${DRY}\n`);
if (!targets.length) process.exit(0);

let filled = 0, noAbs = 0, mism = 0, notFound = 0, errors = 0;
const filledIds = [];

async function fetchBatch(rows) {
  const url = 'https://api.openaire.eu/search/publications?format=json&size=' + (rows.length * 3) +
    '&doi=' + encodeURIComponent(rows.map(r => r.id).join(','));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.status === 429) { await sleep(15000 * attempt); continue; }
      if (!res.ok) { await sleep(5000 * attempt); continue; }
      return await res.json();
    } catch { await sleep(5000 * attempt); }
  }
  return null;
}

for (let i = 0; i < targets.length; i += BATCH) {
  const rows = targets.slice(i, i + BATCH);
  const data = await fetchBatch(rows);
  if (!data) { errors += rows.length; console.error(`\n  batch ${i / BATCH + 1}: gave up after retries`); continue; }

  // Map results → DOI via pid; keep the longest non-junk description per DOI.
  const byDoi = new Map();
  for (const res of [].concat(data?.response?.results?.result || [])) {
    const md = res?.metadata?.['oaf:entity']?.['oaf:result'];
    if (!md) continue;
    const pids = [].concat(md.pid || []).map(p => String(p?.$ ?? '').toLowerCase().trim()).filter(p => p.startsWith('10.'));
    const title = (() => { const t = [].concat(md.title || [])[0]; return clean(String(t?.$ ?? t ?? '')); })();
    let best = '';
    for (const desc of [].concat(md.description || [])) {
      const t = clean(String(desc?.$ ?? desc ?? ''));
      if (t.length > best.length && !JUNK_RE.test(t)) best = t;
    }
    for (const pid of pids) {
      const prev = byDoi.get(pid);
      if (!prev || best.length > prev.abs.length) byDoi.set(pid, { abs: best, title });
    }
  }

  for (const w of rows) {
    const hit = byDoi.get(w.id.toLowerCase());
    if (!hit) { notFound++; continue; }
    const abs = hit.abs.replace(/^abstract[:.\s]+/i, '').trim();
    if (!abs || abs.length < 120 || !isRealAbstract(abs)) { noAbs++; continue; }
    if (!titleMatch(hit.title, w.title)) { mism++; continue; }
    if (!DRY) {
      const { data: row } = await sb.from('works').select('raw_data').eq('id', w.id).single();
      const { error } = await sb.from('works').update({
        abstract: abs,
        raw_data: { ...(row?.raw_data || {}), abstract_backfill: { source: 'openaire', status: 'filled', matched_at: new Date().toISOString() } },
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
  await sleep(1200);
}

console.log(`\n\n=== Done ===`);
console.log(`Filled: ${filled} | noAbstract: ${noAbs} | titleMismatch: ${mism} | notFound: ${notFound} | errors: ${errors}`);
if (!DRY && filledIds.length) {
  console.log(`Filled IDs → ${OUT}`);
  console.log(`Next: node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --ids-file ${OUT}`);
}
