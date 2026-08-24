#!/usr/bin/env node
/**
 * Second-pass abstract backfill via OpenAlex. Targets the remaining 27k
 * works where Crossref had no abstract.
 *
 * OpenAlex uses an inverted-index format that we reconstruct into prose.
 * Bulk filter: `?filter=doi:doi1|doi2|...&per-page=50` allows up to ~50
 * DOIs per request. With polite mailto we get ~10 RPS, so 27k DOIs in
 * 540 batches → ~9 minutes.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/backfill-abstracts-openalex.mjs              # apply
 *   node scripts/backfill-abstracts-openalex.mjs --dry-run    # count only
 *   node scripts/backfill-abstracts-openalex.mjs --limit 5000 # cap
 *   node scripts/backfill-abstracts-openalex.mjs --sms-missing --year-min 2010 --order-by citation_count --limit 5000
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

const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || 'horizon-scanner@iadb.org';
const BATCH = 50;
const MIN_INTERVAL_MS = 110;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const positions = Object.values(invertedIndex).flat();
  if (positions.length === 0) return null;
  const max = Math.max(...positions) + 1;
  const words = Array(max).fill('');
  for (const [w, ps] of Object.entries(invertedIndex)) for (const p of ps) words[p] = w;
  const out = words.join(' ').trim();
  return out || null;
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

async function fetchBatchFromOA(dois) {
  // OA filter accepts pipe-OR'd DOIs. Lowercase + URL-safe.
  const filter = `doi:${dois.map(d => d.toLowerCase()).join('|')}`;
  const params = new URLSearchParams({
    filter,
    'per-page': '50',
    select: 'doi,abstract_inverted_index,cited_by_count',
    mailto: MAILTO,
  });
  const url = `https://api.openalex.org/works?${params.toString()}`;
  let attempts = 0;
  while (attempts < 3) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 429) {
        await sleep(3000 * (attempts + 1));
        attempts++;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`\n  [OA ${res.status}] ${text.slice(0, 200)}`);
        return [];
      }
      const json = await res.json();
      return json.results || [];
    } catch (err) {
      attempts++;
      await sleep(1500);
    }
  }
  return [];
}

async function processBatch(targets) {
  let updated = 0, citationsUpdated = 0, missing = 0, errors = 0;
  const updatedIds = [];
  const startTime = Date.now();
  const TODAY = new Date().toISOString().slice(0, 10);
  const IDS_FILE = `reports/oa-sweep-updated-ids-${TODAY}.json`;

  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const dois = slice.map(t => t.canonical_doi);
    const t0 = Date.now();
    const oaResults = await fetchBatchFromOA(dois);

    // Map OA results back by DOI (lowercase)
    const oaByDoi = new Map();
    for (const r of oaResults) {
      const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
      if (doi) oaByDoi.set(doi, r);
    }

    // Build patches for all papers in this OA batch, then write concurrently
    const patches = [];
    for (const t of slice) {
      const oa = oaByDoi.get((t.canonical_doi || '').toLowerCase());
      const abstract = reconstructAbstract(oa?.abstract_inverted_index);
      const citedBy = (oa?.cited_by_count != null && Number.isFinite(oa.cited_by_count))
        ? oa.cited_by_count : null;

      const patch = {};
      if (abstract) patch.abstract = abstract;
      if (citedBy !== null && (t.citation_count === null || citedBy > t.citation_count)) {
        patch.citation_count = citedBy;
      }
      if (Object.keys(patch).length === 0) { missing++; continue; }
      patches.push({ id: t.id, patch, hasAbstract: !!abstract, hasCite: patch.citation_count !== undefined });
    }

    // Fire all DB writes for this batch concurrently (up to 10 at once)
    const CONCURRENCY = 10;
    for (let k = 0; k < patches.length; k += CONCURRENCY) {
      const chunk = patches.slice(k, k + CONCURRENCY);
      await Promise.all(chunk.map(async ({ id, patch, hasAbstract, hasCite }) => {
        const { error } = await supabase.from('works').update(patch).eq('id', id);
        if (error) { errors++; return; }
        if (hasAbstract) { updated++; updatedIds.push(id); }
        if (hasCite) citationsUpdated++;
      }));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = ((i + slice.length) / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1);
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} | abstracts ${updated} | cites ${citationsUpdated} | not_in_OA ${missing} | err ${errors} | ${rate}/s | ${elapsed}s`);

    // Write updated IDs file every 500 so re-embed can start before full run completes
    if (updatedIds.length % 500 < BATCH) {
      const { createWriteStream } = await import('fs');
      const fs = await import('fs');
      fs.writeFileSync(IDS_FILE, JSON.stringify({ ids: updatedIds, partial: true, updated_at: new Date().toISOString() }, null, 2));
    }

    const sleepFor = MIN_INTERVAL_MS - (Date.now() - t0);
    if (sleepFor > 0) await sleep(sleepFor);
  }

  // Final IDs file
  const fs = await import('fs');
  fs.writeFileSync(IDS_FILE, JSON.stringify({ ids: updatedIds, partial: false, count: updatedIds.length, updated_at: new Date().toISOString() }, null, 2));

  return { updated, citationsUpdated, missing, errors, idsFile: IDS_FILE };
}

async function main() {
  console.log(`\n=== Abstract backfill (OpenAlex inverted-index) ===`);
  console.log(`mailto: ${MAILTO}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);
  console.log(`Filters: sms_missing=${SMS_MISSING}, year_min=${YEAR_MIN || 'none'}, corpus_source=${CORPUS_SOURCE || 'any'}, order_by=${ORDER_BY}\n`);
  if (VENUES.length) console.log(`Venues: ${VENUES.join(', ')}\n`);
  console.log(`Venue denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})\n`);

  const targets = await fetchTargets();
  if (targets.length === 0) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) { console.log(`Would query OA for ${targets.length} DOIs in ${Math.ceil(targets.length / BATCH)} batches.`); return; }

  const startTime = Date.now();
  const { updated, citationsUpdated, missing, errors, idsFile } = await processBatch(targets);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:     ${targets.length}`);
  console.log(`Abstracts:     ${updated} (${(updated / targets.length * 100).toFixed(1)}%)`);
  console.log(`Cites updated: ${citationsUpdated}`);
  console.log(`Not in OA:     ${missing}`);
  console.log(`Errors:        ${errors}`);
  console.log(`Elapsed:       ${elapsed}s`);
  console.log(`IDs file:      ${idsFile}  ← pass to backfill-reembed-with-abstract.mjs`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
