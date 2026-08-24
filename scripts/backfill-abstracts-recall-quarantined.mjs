#!/usr/bin/env node
/**
 * Targeted real-abstract recovery for the 2026-07-15 recall-quarantine cohort.
 *
 * Scope (fixed, not configurable): works where
 *   abstract IS NULL AND is_noise = false AND canonical_doi IS NOT NULL
 *   AND raw_data->>abstract_source = 'recall_quarantined'
 *
 * These rows had an LLM-recalled (fabricated) abstract nulled out on
 * 2026-07-15 (scripts/verify-recalled-abstracts.mjs). This script tries ONLY
 * real retrieval sources, in order: OpenAlex (batch), then Crossref
 * (per-DOI), then Semantic Scholar (batch). Gap-only (re-checks abstract IS
 * NULL immediately before writing). On a real hit it:
 *   - sets abstract to the retrieved prose
 *   - sets raw_data.abstract_source to the REAL source name (never a recall
 *     value)
 *   - stamps raw_data.abstract_backfill with source + matched_at
 *   - sets raw_data.sms_stale = true, raw_data.embedding_stale = true
 *   - records raw_data.recall_recovered_at
 * Never overwrites a populated abstract. Never invents text.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-recall-quarantined.mjs --dry-run
 *   node --env-file=.env scripts/backfill-abstracts-recall-quarantined.mjs [--limit N]
 */
import fs from 'node:fs';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { isRealAbstract } from './lib/abstract-quality.mjs';
config();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = parseInt(flag('--limit', '0'), 10) || Infinity;

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || 'horizon-scanner@iadb.org';
const S2_KEY = process.env.S2_API_KEY || process.env.SEMANTIC_SCHOLAR_API_KEY || null;
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_FILLED = 'reports/recall-quarantined-recovered-ids-' + TODAY + '.json';
const OUT_REPORT = 'reports/recall-quarantined-recovery-report-' + TODAY + '.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function stripJats(s) {
  if (!s) return null;
  return String(s)
    .replace(/<jats:[^>]+>/g, '')
    .replace(/<\/jats:[^>]+>/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s*Abstract[\s:.-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function reconstructOAInverted(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const positions = Object.values(invertedIndex).flat();
  if (positions.length === 0) return null;
  const max = Math.max(...positions) + 1;
  const words = Array(max).fill('');
  for (const [w, ps] of Object.entries(invertedIndex)) for (const p of ps) words[p] = w;
  const out = words.join(' ').trim();
  return out || null;
}

function titleMatch(a, b) {
  const tok = (t) => new Set(clean(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4; }));
  const wa = tok(a), wb = tok(b);
  if (!wa.size || !wb.size) return false;
  let hit = 0; for (const w of wb) if (wa.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size) >= 0.5;
}

async function fetchTargets() {
  const all = [];
  let cursor = '';
  while (all.length < LIMIT) {
    let q = sb.from('works')
      .select('id, title, canonical_doi, year, raw_data')
      .is('abstract', null)
      .eq('is_noise', false)
      .not('canonical_doi', 'is', null)
      .filter('raw_data->>abstract_source', 'eq', 'recall_quarantined')
      .order('id', { ascending: true })
      .limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('target load error:', error.message); process.exit(1); }
    if (!data || !data.length) break;
    all.push(...data);
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return all.slice(0, LIMIT);
}

async function fetchOABatch(dois) {
  const filter = 'doi:' + dois.map(function (d) { return d.toLowerCase(); }).join('|');
  const params = new URLSearchParams({
    filter: filter, 'per-page': '50',
    select: 'doi,abstract_inverted_index',
    mailto: MAILTO,
  });
  const url = 'https://api.openalex.org/works?' + params.toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      return json.results || [];
    } catch (e) { await sleep(1500); }
  }
  return [];
}

async function fetchCrossref(doi) {
  const url = 'https://api.crossref.org/works/' + encodeURIComponent(doi);
  const UA = 'HorizonScanner/1.0 (mailto:' + MAILTO + ')';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      return stripJats(json && json.message ? json.message.abstract : null);
    } catch (e) { await sleep(1500); }
  }
  return null;
}

async function fetchS2Batch(rows) {
  const headers = Object.assign({ 'content-type': 'application/json' }, S2_KEY ? { 'x-api-key': S2_KEY } : {});
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,abstract', {
        method: 'POST', headers: headers,
        body: JSON.stringify({ ids: rows.map(function (r) { return 'DOI:' + r.canonical_doi; }) }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) { await sleep(12000 * attempt); continue; }
      if (!res.ok) { await sleep(5000 * attempt); continue; }
      return await res.json();
    } catch (e) { await sleep(5000 * attempt); }
  }
  return null;
}

async function writeAbstract(row, abstract, source) {
  if (DRY) return true;
  const sel = await sb.from('works').select('abstract, raw_data').eq('id', row.id).single();
  if (sel.error) return false;
  const current = sel.data;
  if (current && current.abstract) return false;
  const raw = Object.assign({}, (current && current.raw_data && typeof current.raw_data === 'object') ? current.raw_data : {});
  raw.abstract_source = source;
  raw.abstract_backfill = { source: source, matched_at: new Date().toISOString() };
  raw.recall_recovered_at = new Date().toISOString();
  raw.sms_stale = true;
  raw.embedding_stale = true;
  const upd = await sb.from('works').update({ abstract: abstract, raw_data: raw }).eq('id', row.id);
  return !upd.error;
}

async function main() {
  console.log('\n=== Recall-quarantine real-abstract recovery ===');
  console.log('Dry run: ' + DRY + ' | Limit: ' + (LIMIT === Infinity ? 'none' : LIMIT) + '\n');

  const targets = await fetchTargets();
  console.log('Targets: ' + targets.length + '\n');
  if (!targets.length) { console.log('Nothing to do.'); return; }
  if (DRY) { console.log('Dry run, not fetching.'); return; }

  const stats = { openalex: 0, crossref: 0, s2: 0, still_null: 0, errors: 0 };
  const recoveredIds = [];
  const stillNull = [];

  const remaining1 = [];
  for (let i = 0; i < targets.length; i += 50) {
    const slice = targets.slice(i, i + 50);
    const oaResults = await fetchOABatch(slice.map(function (t) { return t.canonical_doi; }));
    const byDoi = new Map();
    for (const r of oaResults) {
      const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
      if (doi) byDoi.set(doi, r);
    }
    for (const t of slice) {
      const oa = byDoi.get((t.canonical_doi || '').toLowerCase());
      const abs = reconstructOAInverted(oa ? oa.abstract_inverted_index : null);
      if (abs && isRealAbstract(abs)) {
        const ok = await writeAbstract(t, abs, 'openalex');
        if (ok) { stats.openalex++; recoveredIds.push(t.id); } else { stats.errors++; }
      } else {
        remaining1.push(t);
      }
    }
    process.stdout.write('\r  OpenAlex: ' + Math.min(i + 50, targets.length) + '/' + targets.length + ' | hit ' + stats.openalex);
    await sleep(120);
  }
  console.log('\nOpenAlex done: ' + stats.openalex + '/' + targets.length + ' filled. Remaining: ' + remaining1.length);

  const remaining2 = [];
  const CONC = 15;
  for (let i = 0; i < remaining1.length; i += CONC) {
    const slice = remaining1.slice(i, i + CONC);
    await Promise.all(slice.map(async function (t) {
      const abs = await fetchCrossref(t.canonical_doi);
      if (abs && isRealAbstract(abs)) {
        const ok = await writeAbstract(t, abs, 'crossref');
        if (ok) { stats.crossref++; recoveredIds.push(t.id); } else { stats.errors++; }
      } else {
        remaining2.push(t);
      }
    }));
    process.stdout.write('\r  Crossref: ' + Math.min(i + CONC, remaining1.length) + '/' + remaining1.length + ' | hit ' + stats.crossref);
    await sleep(250);
  }
  console.log('\nCrossref done: ' + stats.crossref + '/' + remaining1.length + ' filled. Remaining: ' + remaining2.length);

  for (let i = 0; i < remaining2.length; i += 500) {
    const slice = remaining2.slice(i, i + 500);
    const result = await fetchS2Batch(slice);
    if (!result) { stillNull.push.apply(stillNull, slice); continue; }
    for (let j = 0; j < slice.length; j++) {
      const t = slice[j];
      const p = result[j];
      const abs = clean(p ? p.abstract : null);
      if (abs && isRealAbstract(abs) && titleMatch(p.title, t.title)) {
        const ok = await writeAbstract(t, abs, 's2');
        if (ok) { stats.s2++; recoveredIds.push(t.id); } else { stats.errors++; }
      } else {
        stillNull.push(t);
      }
    }
    process.stdout.write('\r  S2: ' + Math.min(i + 500, remaining2.length) + '/' + remaining2.length + ' | hit ' + stats.s2);
    await sleep(S2_KEY ? 1100 : 3500);
  }
  stats.still_null = stillNull.length;

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT_FILLED, JSON.stringify(recoveredIds, null, 1));
  fs.writeFileSync(OUT_REPORT, JSON.stringify({
    generated_at: new Date().toISOString(),
    targets: targets.length,
    stats: stats,
    recovered_count: recoveredIds.length,
    still_null_ids: stillNull.map(function (t) { return t.id; }),
  }, null, 2));

  console.log('\n\n=== Done ===');
  console.log('Targets:      ' + targets.length);
  console.log('OpenAlex:     ' + stats.openalex);
  console.log('Crossref:     ' + stats.crossref);
  console.log('S2:           ' + stats.s2);
  console.log('Total filled: ' + recoveredIds.length + ' (' + (recoveredIds.length / targets.length * 100).toFixed(1) + '%)');
  console.log('Still null:   ' + stats.still_null);
  console.log('Errors:       ' + stats.errors);
  console.log('Recovered IDs -> ' + OUT_FILLED);
  console.log('Report        -> ' + OUT_REPORT);
  console.log('\nNext: re-embed + reclassify SMS for recovered rows (raw_data.embedding_stale/sms_stale already set):');
  console.log('  node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --stale');
}

main().catch(function (err) { console.error('Fatal:', err.message); process.exit(1); });
