#!/usr/bin/env node
/**
 * Exhaustive multi-source abstract backfill for null-abstract canonical non-noise
 * papers. Fills REAL abstracts only — NEVER synthesizes (no LLM recall).
 *
 * CASCADE (accept FIRST real abstract found):
 *   WITH DOI (trusted — DOI identifies one paper):
 *     OpenAlex (batched) → Crossref → Semantic Scholar → Europe PMC
 *     → publisher landing-page meta tags (via doi.org resolve)
 *   NO DOI (strict gate: title sim>=0.92 + year +-1 + first-author surname):
 *     OpenAlex title → Crossref title → arXiv title
 *
 * GOLDEN RULE: gap-only. Only writes where abstract IS NULL; never overwrites an
 * existing abstract or any other curated field. Records provenance in
 * raw_data.abstract_backfill = { source, matchedBy, fetchedAt }, merged into raw_data.
 *
 * Resumable: sidecar JSON of processed/filled/unmatched ids. Idempotent.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-multisource.mjs --limit 400 [--sample]
 *   node --env-file=.env scripts/backfill-abstracts-multisource.mjs               # full sweep
 *   node --env-file=.env scripts/backfill-abstracts-multisource.mjs --dry-run --limit 50
 *   Flags: --no-landing (skip landing-page fetch), --order-by citation_count|year|id
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
import {
  openAlexBatch, crossrefOne, s2One, europePmcOne, landingPageMetaOne,
  openAlexTitleSearch, crossrefTitleSearch, arxivTitleSearch, normDoi, sleep,
} from './lib/abstract-sources.mjs';
import { passesGate } from './lib/matchGate.mjs';

config();

const args = process.argv.slice(2);
const flag = (n, f) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : f; };
const DRY_RUN = args.includes('--dry-run');
const SAMPLE = args.includes('--sample');           // stratified sample (validation batch)
// Landing-page meta scraping measured ~0% recovery on this residual (publishers block
// bots / JS-render), so it is OFF by default. Opt in with --landing if a publisher set
// is known to expose citation_abstract meta tags.
const NO_LANDING = !args.includes('--landing');
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;
const ORDER_BY = ['id', 'year', 'citation_count'].includes(flag('--order-by', 'id')) ? flag('--order-by', 'id') : 'id';

const OA_BATCH = 50;          // OpenAlex pipe-OR batch size
const SLEEP_OA_MS = 120;      // polite ~8 rps to OpenAlex
const SLEEP_SECONDARY_MS = 200; // per-paper secondary source pacing
const TODAY = new Date().toISOString().slice(0, 10);
const SIDECAR = `reports/abstract-multisource-progress-${SAMPLE ? 'sample-' : ''}${TODAY}.json`;

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ─── resumable sidecar ───────────────────────────────────────────────────────
function loadSidecar() {
  try {
    if (fs.existsSync(SIDECAR)) {
      const j = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      return {
        processed: new Set(j.processed || []),
        filledIds: j.filledIds || [],
        unmatched: j.unmatched || [],
        sourceCounts: j.sourceCounts || {},
      };
    }
  } catch { /* fresh */ }
  return { processed: new Set(), filledIds: [], unmatched: [], sourceCounts: {} };
}
function saveSidecar(s) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(SIDECAR, JSON.stringify({
    updatedAt: new Date().toISOString(),
    processedCount: s.processed.size,
    filledCount: s.filledIds.length,
    unmatchedCount: s.unmatched.length,
    sourceCounts: s.sourceCounts,
    processed: [...s.processed],
    filledIds: s.filledIds,
    unmatched: s.unmatched,
  }, null, 2));
}

// ─── target selection ────────────────────────────────────────────────────────
async function fetchTargets() {
  if (SAMPLE) return fetchStratifiedSample();
  // Full sweep: cursor-paginate in id order (resumable via sidecar).
  const rows = [];
  let cursor = null;
  while (rows.length < LIMIT) {
    let q = sb.from('works')
      .select('id, title, canonical_doi, year, authors, raw_data')
      .is('abstract', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .order('id')
      .range(0, 999);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('target query:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
    if (rows.length >= LIMIT) break;
    process.stdout.write(`\r  loading targets… ${rows.length}`);
  }
  process.stdout.write('\n');
  return rows.slice(0, LIMIT);
}

// Stratified sample: deliberately covers each major DOI prefix × era cell, plus
// no-DOI papers. Uses random DB offsets per cell so we don't cluster by id.
async function fetchStratifiedSample() {
  const n = Number.isFinite(LIMIT) ? LIMIT : 400;
  // Prefixes chosen from the inventory (big + representative slices).
  const prefixes = ['10.1016', '10.2307', '10.1111', '10.1086', '10.1007',
                    '10.1257', '10.3386', '10.1093', '10.2139'];
  const eras = [
    { tag: 'pre90', gte: null, lt: 1990 },
    { tag: '90s00s', gte: 1990, lt: 2010 },
    { tag: '10s', gte: 2010, lt: 2020 },
    { tag: '20s', gte: 2020, lt: null },
  ];
  const select = 'id, title, canonical_doi, year, authors, raw_data';
  const base = () => sb.from('works').select(select)
    .is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true);

  const cells = prefixes.length * eras.length;
  const perCell = Math.max(2, Math.floor((n * 0.9) / cells)); // 90% DOI cells
  const picked = [];
  const seen = new Set();

  for (const p of prefixes) {
    for (const e of eras) {
      // Count this cell (separate builder, single .select with head+count).
      let cq = sb.from('works').select('id', { head: true, count: 'exact' })
        .is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true)
        .like('canonical_doi', `${p}/%`);
      if (e.gte != null) cq = cq.gte('year', e.gte);
      if (e.lt != null) cq = cq.lt('year', e.lt);
      const { count } = await cq;
      // Random offset to avoid clustering at the oldest/least-covered ids.
      const maxOff = Math.max(0, (count || 0) - perCell);
      const off = maxOff > 0 ? Math.floor(Math.random() * maxOff) : 0;
      let q = base().like('canonical_doi', `${p}/%`);
      if (e.gte != null) q = q.gte('year', e.gte);
      if (e.lt != null) q = q.lt('year', e.lt);
      const { data } = await q.order('id').range(off, off + perCell - 1);
      for (const r of data || []) if (!seen.has(r.id)) { seen.add(r.id); picked.push(r); }
    }
  }
  // ~10% no-DOI papers
  const noDoiQuota = Math.round(n * 0.1);
  const { data: noDoi } = await base().is('canonical_doi', null).order('id').range(0, noDoiQuota * 3);
  for (let i = 0; i < (noDoi || []).length && picked.length < n; i += 3) {
    const r = noDoi[i];
    if (!seen.has(r.id)) { seen.add(r.id); picked.push(r); }
  }
  console.log(`  stratified sample: ${picked.length} papers across ${prefixes.length} prefixes × ${eras.length} eras + no-DOI`);
  return picked.slice(0, n);
}

// ─── cascade per paper ───────────────────────────────────────────────────────
// oaMap: pre-fetched OpenAlex batch results Map<normDoi, abstract>
async function resolveAbstract(paper, oaMap) {
  const doi = paper.canonical_doi ? normDoi(paper.canonical_doi) : null;

  if (doi) {
    // 1. OpenAlex (already batched)
    const oa = oaMap.get(doi);
    if (oa) return { abstract: oa, source: 'openalex', matchedBy: 'doi' };
    // 2. Crossref
    const cr = await crossrefOne(doi); await sleep(SLEEP_SECONDARY_MS);
    if (cr) return { abstract: cr, source: 'crossref', matchedBy: 'doi' };
    // 3. Semantic Scholar
    const s2 = await s2One(doi); await sleep(SLEEP_SECONDARY_MS);
    if (s2) return { abstract: s2, source: 'semantic_scholar', matchedBy: 'doi' };
    // 4. Europe PMC
    const ep = await europePmcOne(doi); await sleep(SLEEP_SECONDARY_MS);
    if (ep) return { abstract: ep, source: 'europepmc', matchedBy: 'doi' };
    // 5. Publisher landing page meta
    if (!NO_LANDING) {
      const lp = await landingPageMetaOne(doi); await sleep(SLEEP_SECONDARY_MS);
      if (lp) return { abstract: lp, source: 'landing_page', matchedBy: 'doi' };
    }
    return null;
  }

  // NO DOI — strict gate on every candidate
  const title = paper.title;
  if (!title || title.length < 10) return null;
  for (const [fn, srcName] of [
    [openAlexTitleSearch, 'openalex_title'],
    [crossrefTitleSearch, 'crossref_title'],
    [arxivTitleSearch, 'arxiv_title'],
  ]) {
    let cands = [];
    try { cands = await fn(title, paper.year); } catch { cands = []; }
    await sleep(SLEEP_SECONDARY_MS);
    for (const c of cands) {
      const g = passesGate(paper, c);
      if (g.ok) return { abstract: c.abstract, source: srcName, matchedBy: 'title', sim: g.sim };
    }
  }
  return null;
}

// ─── gap-only write (provenance merged into raw_data) ────────────────────────
async function writeAbstract(paper, result) {
  // Re-read to confirm abstract is STILL null (golden rule, race-safe) + get fresh raw_data.
  const { data: cur, error: rerr } = await sb.from('works')
    .select('abstract, raw_data').eq('id', paper.id).single();
  if (rerr) return { ok: false, reason: 'reread error' };
  if (cur.abstract != null) return { ok: false, reason: 'already has abstract (skipped)' };

  // Merge provenance WITHOUT clobbering raw_data. raw_data may be [] (array) or object or null.
  // Clone (don't mutate the read object) and preserve every existing key.
  let raw = cur.raw_data;
  raw = (raw == null || Array.isArray(raw) || typeof raw !== 'object') ? {} : { ...raw };
  raw.abstract_backfill = {
    source: result.source,
    matchedBy: result.matchedBy,
    ...(result.sim != null ? { titleSim: Number(result.sim.toFixed(3)) } : {}),
    fetchedAt: new Date().toISOString(),
  };
  // The JEL evidence-table export reads the FLAT abstract_source for its `unverified`
  // flag and never looks inside abstract_backfill — stamp both, or a genuinely
  // retrieved abstract ships indistinguishable from untagged legacy text.
  raw.abstract_source = result.source;

  const { error } = await sb.from('works')
    .update({ abstract: result.abstract, raw_data: raw })
    .eq('id', paper.id)
    .is('abstract', null); // DB-level gap-only guard
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Multi-source abstract backfill ===');
  console.log(`Mode: ${SAMPLE ? 'STRATIFIED SAMPLE' : 'sweep'} | dry-run: ${DRY_RUN} | limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
  console.log(`Landing-page source: ${NO_LANDING ? 'OFF' : 'ON'} | sidecar: ${SIDECAR}\n`);

  const state = loadSidecar();
  if (state.processed.size) console.log(`Resuming: ${state.processed.size} already processed.\n`);

  let targets = await fetchTargets();
  targets = targets.filter(t => !state.processed.has(t.id));
  console.log(`Targets this run: ${targets.length}\n`);
  if (!targets.length) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) { console.log('Dry run — no fetches/writes.'); return; }

  let filled = 0, unmatchedRun = 0, errors = 0, processed = 0;
  const start = Date.now();

  for (let i = 0; i < targets.length; i += OA_BATCH) {
    const slice = targets.slice(i, i + OA_BATCH);
    const doiSlice = slice.filter(t => t.canonical_doi).map(t => t.canonical_doi);

    // Batch OpenAlex once for the whole slice's DOIs.
    let oaMap = new Map();
    if (doiSlice.length) {
      try { oaMap = await openAlexBatch(doiSlice); } catch { oaMap = new Map(); }
      await sleep(SLEEP_OA_MS);
    }

    for (const paper of slice) {
      let result = null;
      try {
        result = await resolveAbstract(paper, oaMap);
      } catch (e) {
        errors++;
      }
      state.processed.add(paper.id);
      processed++;
      if (result) {
        const w = await writeAbstract(paper, result);
        if (w.ok) {
          filled++;
          state.filledIds.push(paper.id);
          state.sourceCounts[result.source] = (state.sourceCounts[result.source] || 0) + 1;
        } else {
          // re-read showed it's no longer null, or write error
          if (!/already has/.test(w.reason)) errors++;
        }
      } else {
        unmatchedRun++;
        state.unmatched.push(paper.id);
      }

      if (processed % 25 === 0) {
        const rate = (processed / Math.max(1, (Date.now() - start) / 1000)).toFixed(2);
        process.stdout.write(`\r  ${processed}/${targets.length} | filled ${filled} | unmatched ${unmatchedRun} | err ${errors} | ${rate}/s`);
        saveSidecar(state);
      }
    }
    saveSidecar(state);
  }

  saveSidecar(state);
  const elapsed = Math.round((Date.now() - start) / 1000);
  const recoveryPct = processed ? (filled / processed * 100).toFixed(1) : '0';

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:   ${processed}`);
  console.log(`Filled:      ${filled} (${recoveryPct}%)`);
  console.log(`Unmatched:   ${unmatchedRun}`);
  console.log(`Errors:      ${errors}`);
  console.log(`Elapsed:     ${elapsed}s`);
  console.log(`\nBy source:`);
  for (const [s, c] of Object.entries(state.sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(18)} ${c}`);
  }
  console.log(`\nSidecar: ${SIDECAR}`);
  console.log(`Filled IDs are in sidecar.filledIds → feed to backfill-reembed-with-abstract.mjs`);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
