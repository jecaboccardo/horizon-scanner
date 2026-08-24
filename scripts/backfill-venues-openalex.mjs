#!/usr/bin/env node
/**
 * Backfill missing `venue` (journal / repository name) on works from OpenAlex.
 *
 * Targets works where `venue` IS NULL and `canonical_doi` IS NOT NULL.
 * Pulls primary_location.source.display_name (and falls back to
 * host_venue.display_name on older OA records).
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   node scripts/backfill-venues-openalex.mjs              # apply
 *   node scripts/backfill-venues-openalex.mjs --dry-run    # count only
 *   node scripts/backfill-venues-openalex.mjs --limit 5000 # cap
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();

const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || 'horizon-scanner@iadb.org';
const BATCH = 50;
const MIN_INTERVAL_MS = 110;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickVenue(oa) {
  if (!oa) return null;
  const primary = oa.primary_location?.source?.display_name;
  if (primary && typeof primary === 'string') return primary.trim() || null;
  const host = oa.host_venue?.display_name;
  if (host && typeof host === 'string') return host.trim() || null;
  return null;
}

async function fetchTargets() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (all.length < LIMIT) {
    const { data, error } = await supabase
      .from('works')
      .select('id, canonical_doi')
      .is('venue', null)
      .not('canonical_doi', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('Target query error:', error.message);
      break;
    }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loading targets… ${all.length}`);
  }
  console.log(`\r  targets: ${all.length} works missing venue (with DOI)`);
  return all.slice(0, LIMIT);
}

async function fetchBatchFromOA(dois) {
  const filter = `doi:${dois.map((d) => d.toLowerCase()).join('|')}`;
  const params = new URLSearchParams({
    filter,
    'per-page': '50',
    select: 'doi,primary_location',
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
  let updated = 0;
  let missing = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const dois = slice.map((t) => t.canonical_doi);
    const t0 = Date.now();
    const oaResults = await fetchBatchFromOA(dois);

    const oaByDoi = new Map();
    for (const r of oaResults) {
      const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
      if (doi) oaByDoi.set(doi, r);
    }

    for (const t of slice) {
      const oa = oaByDoi.get((t.canonical_doi || '').toLowerCase());
      const venue = pickVenue(oa);
      if (!venue) {
        missing++;
        continue;
      }
      const { error } = await supabase
        .from('works')
        .update({ venue })
        .eq('id', t.id);
      if (error) {
        errors++;
        continue;
      }
      updated++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = ((i + slice.length) / Math.max(1, (Date.now() - startTime) / 1000)).toFixed(1);
    process.stdout.write(
      `\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} | filled ${updated} | not in OA ${missing} | err ${errors} | ${rate} RPS | ${elapsed}s`,
    );

    const sleepFor = MIN_INTERVAL_MS - (Date.now() - t0);
    if (sleepFor > 0) await sleep(sleepFor);
  }

  return { updated, missing, errors };
}

async function main() {
  console.log(`\n=== Venue backfill (OpenAlex primary_location.source.display_name) ===`);
  console.log(`mailto: ${MAILTO}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  const targets = await fetchTargets();
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }
  if (DRY_RUN) {
    console.log(`Would query OA for ${targets.length} DOIs in ${Math.ceil(targets.length / BATCH)} batches.`);
    return;
  }

  const startTime = Date.now();
  const { updated, missing, errors } = await processBatch(targets);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:  ${targets.length}`);
  console.log(`Filled:     ${updated} (${((updated / targets.length) * 100).toFixed(1)}%)`);
  console.log(`Not in OA:  ${missing}`);
  console.log(`Errors:     ${errors}`);
  console.log(`Elapsed:    ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
