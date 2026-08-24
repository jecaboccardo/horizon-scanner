#!/usr/bin/env node
/**
 * Backfill missing abstracts via Semantic Scholar batch API.
 * Targets works where canonical_doi IS NOT NULL AND abstract IS NULL.
 *
 * SS batch endpoint accepts up to 500 IDs per call. Rate limit: 1 RPS
 * unauthenticated. With ~28k rows, this runs in ~10 minutes.
 *
 * Idempotent — re-running picks up wherever previous runs left off.
 *
 * Usage:
 *   node scripts/backfill-abstracts-ss.mjs              # apply
 *   node scripts/backfill-abstracts-ss.mjs --dry-run    # count only
 *   node scripts/backfill-abstracts-ss.mjs --limit 5000 # cap rows processed
 *   node scripts/backfill-abstracts-ss.mjs --sms-missing --year-min 2010 --order-by citation_count --limit 5000
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { filterDeniedVenues, loadVenueDenylist } from './lib/venue-denylist.mjs';
import { isGenericNonPrimaryTitle } from './lib/generic-title-policy.mjs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();
const YEAR_MIN = (() => {
  const i = args.indexOf('--year-min');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : null;
})();
const MIN_ABS_RATING = (() => {
  const i = args.indexOf('--min-abs-rating');
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 0;
})();
const INCLUDE_GENERIC_TITLES = args.includes('--include-generic-titles');
const SMS_MISSING = args.includes('--sms-missing');
const CORPUS_SOURCE = (() => {
  const i = args.indexOf('--corpus-source');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();
const VENUES = (() => {
  const i = args.indexOf('--venues');
  return i >= 0 && args[i + 1]
    ? args[i + 1].split(',').map((venue) => venue.trim()).filter(Boolean)
    : [];
})();
const ORDER_BY = (() => {
  const i = args.indexOf('--order-by');
  const value = i >= 0 && args[i + 1] ? args[i + 1] : 'id';
  return ['id', 'year', 'citation_count'].includes(value) ? value : 'id';
})();
const VENUE_DENYLIST = loadVenueDenylist();

const SS_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
const BATCH = 500;
// Env override (SS_MIN_INTERVAL_MS) lets a rate-restricted key force its own pace.
// Some free keys are capped at 1 RPS (not the standard ~10 RPS) — set 1100 for those.
const MIN_INTERVAL_MS = Number(process.env.SS_MIN_INTERVAL_MS) || (SS_API_KEY ? 100 : 1100);
const MISS_CACHE = path.resolve('data', 'semantic-scholar-abstract-misses.txt');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const normalizeDoi = (doi) => String(doi || '').trim().toLowerCase();

function isExcludedNonPrimary(row) {
  if (!row) return true;
  if (isGenericNonPrimaryTitle(row.title)) return true;
  if (String(row.publication_type || '').toLowerCase() === 'other') return true;
  if (String(row.venue_kind || '').toLowerCase() === 'commentary') return true;
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  return raw.excluded_from_evidence === true || raw.excluded_reason === 'generic discussion/commentary';
}

function loadMissCache() {
  try {
    const lines = fs.readFileSync(MISS_CACHE, 'utf8').split(/\r?\n/).filter(Boolean);
    return new Set(lines.map(normalizeDoi));
  } catch {
    return new Set();
  }
}

function appendMisses(dois, missCache) {
  const fresh = [];
  for (const doi of dois) {
    const normalized = normalizeDoi(doi);
    if (!normalized || missCache.has(normalized)) continue;
    missCache.add(normalized);
    fresh.push(normalized);
  }
  if (!fresh.length) return 0;
  fs.mkdirSync(path.dirname(MISS_CACHE), { recursive: true });
  fs.appendFileSync(MISS_CACHE, fresh.join('\n') + '\n');
  return fresh.length;
}

async function fetchTargets(missCache) {
  // Pull DOIs in pages so we don't blow memory.
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (all.length < LIMIT) {
    let query = supabase
      .from('works')
      .select('id, title, canonical_doi, year, citation_count, venue, abs_rating, publication_type, venue_kind, raw_data')
      .is('abstract', null)
      .not('canonical_doi', 'is', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true);
    if (SMS_MISSING) query = query.is('sms_level', null);
    if (YEAR_MIN) query = query.gte('year', YEAR_MIN);
    if (MIN_ABS_RATING > 0) query = query.in('abs_rating', ['3', '4', '4*']);
    if (CORPUS_SOURCE) query = query.eq('corpus_source', CORPUS_SOURCE);
    if (VENUES.length) query = query.in('venue', VENUES);
    const { data, error } = await query
      .order(ORDER_BY, { ascending: ORDER_BY === 'id', nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Target query error:', error.message); break; }
    if (!data?.length) break;
    all.push(...filterDeniedVenues(data, VENUE_DENYLIST).filter(row =>
      (INCLUDE_GENERIC_TITLES || !isExcludedNonPrimary(row)) &&
      !missCache.has(normalizeDoi(row.canonical_doi))
    ));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loading targets… ${all.length}`);
  }
  const selected = all.slice(0, LIMIT);
  console.log(`\r  targets: ${selected.length} works missing abstracts (with DOI)`);
  return selected;
}

async function fetchBatchFromSS(dois) {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract';
  const ids = dois.map(d => `DOI:${d}`);
  const headers = { 'Content-Type': 'application/json' };
  if (SS_API_KEY) headers['x-api-key'] = SS_API_KEY;

  let attempts = 0;
  while (attempts < 4) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429) {
        const wait = 5000 * (attempts + 1);
        console.error(`\n  [SS 429] backing off ${wait}ms`);
        await sleep(wait);
        attempts++;
        continue;
      }
      if (!res.ok) {
        console.error(`\n  [SS ${res.status}]`, await res.text().catch(() => ''));
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error(`\n  fetch err: ${err.message}`);
      attempts++;
      await sleep(2000);
    }
  }
  return [];
}

async function applyAbstracts(targets, ssResults) {
  let updated = 0, missing = 0;
  const missingDois = [];
  for (let i = 0; i < targets.length; i++) {
    const ss = ssResults[i];
    if (!ss || !ss.abstract) {
      missing++;
      missingDois.push(targets[i].canonical_doi);
      continue;
    }
    const abstract = String(ss.abstract).trim();
    if (!abstract) {
      missing++;
      missingDois.push(targets[i].canonical_doi);
      continue;
    }
    const { error } = await supabase
      .from('works')
      .update({ abstract })
      .eq('id', targets[i].id);
    if (error) { console.error(`\n  update err ${targets[i].id}: ${error.message}`); continue; }
    updated++;
  }
  return { updated, missing, missingDois };
}

async function main() {
  console.log(`\n=== Abstract backfill (Semantic Scholar) ===`);
  console.log(`API key: ${SS_API_KEY ? 'present' : 'unauthenticated (slower)'}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);
  console.log(`Filters: sms_missing=${SMS_MISSING}, year_min=${YEAR_MIN || 'none'}, corpus_source=${CORPUS_SOURCE || 'any'}, order_by=${ORDER_BY}\n`);
  console.log(`Venues: ${VENUES.length ? VENUES.join(', ') : 'any'}\n`);

  const missCache = loadMissCache();
  console.log(`Miss cache: ${MISS_CACHE} (${missCache.size} DOI misses)\n`);

  const targets = await fetchTargets(missCache);
  if (targets.length === 0) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) { console.log(`Would query SS for ${targets.length} DOIs in ${Math.ceil(targets.length / BATCH)} batches.`); return; }

  let totalUpdated = 0, totalMissing = 0, totalProcessed = 0, totalCachedMisses = 0;
  const startTime = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const dois = slice.map(t => t.canonical_doi);
    const t0 = Date.now();
    const results = await fetchBatchFromSS(dois);
    const { updated, missing, missingDois } = await applyAbstracts(slice, results);
    if (results.length === slice.length) {
      totalCachedMisses += appendMisses(missingDois, missCache);
    }
    totalUpdated += updated;
    totalMissing += missing;
    totalProcessed += slice.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(targets.length / BATCH)} | processed ${totalProcessed} | filled ${totalUpdated} | not in SS ${totalMissing} | ${elapsed}s`);
    const sleepFor = MIN_INTERVAL_MS - (Date.now() - t0);
    if (sleepFor > 0) await sleep(sleepFor);
  }

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:  ${totalProcessed}`);
  console.log(`Filled:     ${totalUpdated}`);
  console.log(`Not in SS:  ${totalMissing}`);
  console.log(`New cached misses: ${totalCachedMisses}`);
  console.log(`Elapsed:    ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
