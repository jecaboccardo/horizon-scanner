#!/usr/bin/env node
/**
 * Backfill missing abstracts via Crossref. Targets works where canonical_doi
 * IS NOT NULL AND abstract IS NULL. Crossref has decent coverage for SciELO
 * (10.1590), Salud Pública de México (10.21149), Pan Am J Public Health
 * (10.26633), and most peer-reviewed DOIs that Semantic Scholar misses.
 *
 * Crossref has no batch endpoint — fetches are per-DOI. Polite rate (mailto
 * in UA) gets ~50 RPS, so we run with concurrency=20 to keep within bounds.
 *
 * Idempotent — re-running picks up where prior runs left off.
 *
 * Usage:
 *   node scripts/backfill-abstracts-crossref.mjs              # apply
 *   node scripts/backfill-abstracts-crossref.mjs --dry-run    # count only
 *   node scripts/backfill-abstracts-crossref.mjs --limit 5000 # cap rows
 *   node scripts/backfill-abstracts-crossref.mjs --sms-missing --year-min 2010 --order-by citation_count --limit 5000
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
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
  const value = i >= 0 && args[i + 1] ? args[i + 1] : '';
  return value.split(',').map((venue) => venue.trim()).filter(Boolean);
})();
const ORDER_BY = (() => {
  const i = args.indexOf('--order-by');
  const value = i >= 0 && args[i + 1] ? args[i + 1] : 'id';
  return ['id', 'year', 'citation_count'].includes(value) ? value : 'id';
})();
const VENUE_DENYLIST = loadVenueDenylist();

const CONCURRENCY = 20;
const MAILTO = process.env.CROSSREF_MAILTO || 'horizon-scanner@iadb.org';
const UA = `HorizonScanner/1.0 (mailto:${MAILTO})`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stripJats(s) {
  if (!s) return null;
  // Crossref returns abstracts wrapped in JATS XML. Strip tags + leading
  // "Abstract" boilerplate.
  return String(s)
    .replace(/<jats:[^>]+>/g, '')
    .replace(/<\/jats:[^>]+>/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s*Abstract[\s:.\-—]*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function isExcludedNonPrimary(row) {
  if (!row) return true;
  if (isGenericNonPrimaryTitle(row.title)) return true;
  if (String(row.publication_type || '').toLowerCase() === 'other') return true;
  if (String(row.venue_kind || '').toLowerCase() === 'commentary') return true;
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  return raw.excluded_from_evidence === true || raw.excluded_reason === 'generic discussion/commentary';
}

async function fetchTargets() {
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
    all.push(...filterDeniedVenues(data, VENUE_DENYLIST).filter(row => INCLUDE_GENERIC_TITLES || !isExcludedNonPrimary(row)));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loading targets… ${all.length}`);
  }
  const selected = all.slice(0, LIMIT);
  console.log(`\r  targets: ${selected.length} works missing abstracts (with DOI)`);
  return selected;
}

async function fetchAbstract(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  let attempts = 0;
  while (attempts < 3) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429) {
        await sleep(2000 * (attempts + 1));
        attempts++;
        continue;
      }
      if (!res.ok) return null;
      const json = await res.json();
      return stripJats(json?.message?.abstract);
    } catch {
      attempts++;
      await sleep(800);
    }
  }
  return null;
}

async function processBatch(targets) {
  // Promise pool with CONCURRENCY workers
  let cursor = 0;
  let updated = 0, missing = 0, errors = 0;
  const work = async () => {
    while (cursor < targets.length) {
      const i = cursor++;
      const t = targets[i];
      try {
        const abstract = await fetchAbstract(t.canonical_doi);
        if (!abstract) { missing++; continue; }
        const { error } = await supabase
          .from('works')
          .update({ abstract })
          .eq('id', t.id);
        if (error) { errors++; continue; }
        updated++;
      } catch {
        errors++;
      }
    }
  };
  const workers = Array.from({ length: CONCURRENCY }, () => work());
  // Progress reporter
  const startTime = Date.now();
  const reporter = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (cursor / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1);
    process.stdout.write(`\r  ${cursor}/${targets.length} | filled ${updated} | not in CR ${missing} | err ${errors} | ${rate} RPS | ${elapsed}s`);
  }, 1000);
  await Promise.all(workers);
  clearInterval(reporter);
  return { updated, missing, errors };
}

async function main() {
  console.log(`\n=== Abstract backfill (Crossref) ===`);
  console.log(`UA: ${UA}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);
  console.log(`Filters: sms_missing=${SMS_MISSING}, year_min=${YEAR_MIN || 'none'}, corpus_source=${CORPUS_SOURCE || 'any'}, order_by=${ORDER_BY}\n`);
  if (VENUES.length) console.log(`Venues: ${VENUES.join(', ')}\n`);
  console.log(`Venue denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})\n`);

  const targets = await fetchTargets();
  if (targets.length === 0) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) { console.log(`Would query Crossref for ${targets.length} DOIs.`); return; }

  const startTime = Date.now();
  const { updated, missing, errors } = await processBatch(targets);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:  ${targets.length}`);
  console.log(`Filled:     ${updated} (${(updated/targets.length*100).toFixed(1)}%)`);
  console.log(`Not in CR:  ${missing}`);
  console.log(`Errors:     ${errors}`);
  console.log(`Elapsed:    ${elapsed}s`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
