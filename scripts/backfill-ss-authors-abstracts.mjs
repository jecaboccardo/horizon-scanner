#!/usr/bin/env node
/**
 * Backfill missing authors AND abstracts via Semantic Scholar batch API.
 * Targets canonical works with a DOI that are missing authors (authors=[])
 * OR missing abstract. Fetches both fields in one SS batch call.
 *
 * SS batch: up to 500 DOIs/request. With API key: ~10 RPS. 135k rows ≈ 45 min.
 * Idempotent — re-running skips already-populated fields.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-ss-authors-abstracts.mjs
 *   node --env-file=.env scripts/backfill-ss-authors-abstracts.mjs --dry-run
 *   node --env-file=.env scripts/backfill-ss-authors-abstracts.mjs --limit 5000
 *   node --env-file=.env scripts/backfill-ss-authors-abstracts.mjs --order-by citation_count
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : fallback; };
const DRY_RUN   = args.includes('--dry-run');
const LIMIT     = parseInt(flag('--limit', '0')) || Infinity;
const ORDER_BY  = ['id', 'year', 'citation_count'].includes(flag('--order-by', 'id')) ? flag('--order-by', 'id') : 'id';
const BATCH     = 500;

const SS_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
// With key: ~10 RPS (100ms). Without: 1 RPS (1100ms).
const MIN_INTERVAL_MS = SS_API_KEY ? 100 : 1100;

const MISS_CACHE_FILE = path.resolve('data', 'ss-authors-abstracts-misses.txt');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const normDoi = (doi) => String(doi || '').trim().toLowerCase();

function loadMissCache() {
  try { return new Set(fs.readFileSync(MISS_CACHE_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(normDoi)); }
  catch { return new Set(); }
}
function appendMisses(dois, cache) {
  const fresh = dois.map(normDoi).filter(d => d && !cache.has(d));
  if (!fresh.length) return;
  fresh.forEach(d => cache.add(d));
  fs.mkdirSync(path.dirname(MISS_CACHE_FILE), { recursive: true });
  fs.appendFileSync(MISS_CACHE_FILE, fresh.join('\n') + '\n');
}

async function fetchTargets(missCache) {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (all.length < LIMIT) {
    const { data, error } = await supabase
      .from('works')
      .select('id, canonical_doi, authors, abstract')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .not('canonical_doi', 'is', null)
      // Target papers missing authors OR abstract (or both)
      .or('authors.eq.[],abstract.is.null')
      .order(ORDER_BY, { ascending: ORDER_BY !== 'citation_count', nullsFirst: false })
      .range(from, from + PAGE - 1);

    if (error) { console.error('Query error:', error.message); break; }
    if (!data?.length) break;
    all.push(...data.filter(r => !missCache.has(normDoi(r.canonical_doi))));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loading… ${all.length}`);
  }
  console.log(`\r  targets: ${Math.min(all.length, LIMIT === Infinity ? Infinity : LIMIT).toLocaleString()} papers`);
  return all.slice(0, LIMIT === Infinity ? all.length : LIMIT);
}

async function fetchBatchFromSS(dois) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract,authors';
  const ids = dois.map(d => `DOI:${d}`);
  const headers = { 'Content-Type': 'application/json' };
  if (SS_API_KEY) headers['x-api-key'] = SS_API_KEY;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429) {
        const wait = 5000 * (attempt + 1);
        console.error(`\n  [SS 429] backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) { console.error(`\n  [SS ${res.status}]`); return new Array(dois.length).fill(null); }
      return await res.json();
    } catch (err) {
      console.error(`\n  fetch err: ${err.message}`);
      await sleep(2000);
    }
  }
  return new Array(dois.length).fill(null);
}

async function applyBatch(targets, ssResults, missCache) {
  let updatedAbstracts = 0, updatedAuthors = 0, updatedBoth = 0, missing = 0;
  const missDois = [];

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const ss = ssResults[i];
    if (!ss) { missing++; missDois.push(row.canonical_doi); continue; }

    const newAbstract = (ss.abstract && String(ss.abstract).trim().length > 20)
      ? String(ss.abstract).trim() : null;
    const newAuthors = Array.isArray(ss.authors) && ss.authors.length > 0
      ? ss.authors.map(a => a.name).filter(Boolean) : null;

    const needsAbstract = !row.abstract && newAbstract;
    const needsAuthors  = (!row.authors || row.authors.length === 0) && newAuthors;

    if (!needsAbstract && !needsAuthors) {
      missing++;
      missDois.push(row.canonical_doi);
      continue;
    }

    const patch = {};
    if (needsAbstract) patch.abstract = newAbstract;
    if (needsAuthors)  patch.authors  = newAuthors;

    if (DRY_RUN) {
      if (needsAbstract && needsAuthors) updatedBoth++;
      else if (needsAbstract) updatedAbstracts++;
      else updatedAuthors++;
      continue;
    }

    const { error } = await supabase.from('works').update(patch).eq('id', row.id);
    if (error) { console.error(`\n  update err ${row.id}: ${error.message}`); continue; }

    if (needsAbstract && needsAuthors) updatedBoth++;
    else if (needsAbstract) updatedAbstracts++;
    else updatedAuthors++;
  }

  if (missDois.length) appendMisses(missDois, missCache);
  return { updatedAbstracts, updatedAuthors, updatedBoth, missing };
}

async function main() {
  console.log('\n=== Semantic Scholar — authors + abstracts backfill ===');
  console.log(`API key: ${SS_API_KEY ? 'present (~10 RPS)' : 'absent (1 RPS)'}`);
  console.log(`Dry run: ${DRY_RUN} | Order by: ${ORDER_BY} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  const missCache = loadMissCache();
  console.log(`Miss cache: ${missCache.size} DOIs already tried\n`);

  const targets = await fetchTargets(missCache);
  if (!targets.length) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) {
    console.log(`Dry run: would send ${Math.ceil(targets.length / BATCH)} SS batches for ${targets.length} papers.`);
    return;
  }

  let totAbstracts = 0, totAuthors = 0, totBoth = 0, totMissing = 0, totProcessed = 0;
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const dois = batch.map(r => r.canonical_doi);
    const ssResults = await fetchBatchFromSS(dois);
    const { updatedAbstracts, updatedAuthors, updatedBoth, missing } = await applyBatch(batch, ssResults, missCache);

    totAbstracts += updatedAbstracts;
    totAuthors   += updatedAuthors;
    totBoth      += updatedBoth;
    totMissing   += missing;
    totProcessed += batch.length;

    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    const rate = Math.round(totProcessed / ((Date.now() - t0) / 60000));
    process.stdout.write(
      `\r  ${totProcessed.toLocaleString()}/${targets.length.toLocaleString()} | ` +
      `abstracts +${totAbstracts} | authors +${totAuthors} | both +${totBoth} | ` +
      `miss ${totMissing} | ${elapsed}min | ${rate}/min`
    );

    const elapsed_ms = Date.now() - t0;
    const expected_ms = ((i + BATCH) / BATCH) * MIN_INTERVAL_MS;
    const wait = expected_ms - elapsed_ms;
    if (wait > 0) await sleep(wait);
  }

  console.log('\n\n=== Done ===');
  console.log(`Abstracts added: ${totAbstracts}`);
  console.log(`Authors added:   ${totAuthors}`);
  console.log(`Both added:      ${totBoth}`);
  console.log(`SS misses:       ${totMissing}`);
  console.log(`Total processed: ${totProcessed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
