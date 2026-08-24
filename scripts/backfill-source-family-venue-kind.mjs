#!/usr/bin/env node
/**
 * Backfill works.source_family and works.venue_kind, and normalize venue when
 * raw series metadata clearly identifies the publication series.
 *
 * Usage:
 *   node scripts/backfill-source-family-venue-kind.mjs --dry-run --limit 5000
 *   node scripts/backfill-source-family-venue-kind.mjs --limit 50000
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

const PAGE = 1000;
const CONCURRENCY = 10;

const norm = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const has = (value, needle) => norm(value).includes(norm(needle));

function canonicalSeriesVenue(seriesKey, currentVenue, publicationType) {
  if (seriesKey === 'nber') return 'NBER Working Papers';
  if (seriesKey === 'iza') return 'IZA Discussion Papers';
  if (seriesKey === 'cepr') return 'CEPR Discussion Papers';
  if (seriesKey === 'oecd') return 'OECD Working Papers';
  if (seriesKey === 'wb' && publicationType === 'working_paper') return 'World Bank Working Paper / Report';
  return currentVenue || null;
}

function deriveSourceFamily(work) {
  const raw = work.raw_data || {};
  const seriesKey = norm(raw.series_key);
  const venue = norm(work.venue);
  const source = norm(work.source);
  const corpus = norm(work.corpus_source);
  const doi = norm(work.canonical_doi);
  const url = norm(work.url);
  const institution = norm(raw.institution);

  if (seriesKey === 'nber' || doi.startsWith('10.3386/')) return 'NBER';
  if (seriesKey === 'iza') return 'IZA';
  if (seriesKey === 'cepr') return 'CEPR';
  if (seriesKey === 'oecd' || doi.startsWith('10.1787/') || venue.includes('oecd')) return 'OECD';
  if (seriesKey === 'wb' || doi.startsWith('10.1596/') || institution === 'world bank' || venue.includes('world bank') || url.includes('worldbank.org') || url.includes('openknowledge.worldbank')) return 'World Bank';
  if (doi.startsWith('10.18235/') || institution === 'idb' || institution === 'iadb' || source === 'idb' || source === 'idb_publications' || corpus === 'idb_bulk' || venue.includes('idb publication') || url.includes('iadb.org')) return 'IADB';
  if (venue === 'ssrn electronic journal' || doi.startsWith('10.2139/ssrn')) return 'SSRN';
  if (source === 'repec' || venue === 'repec: research papers in economics' || url.includes('ideas.repec.org') || url.includes('econpapers.repec.org')) return 'RePEc';
  return null;
}

function deriveVenueKind(work, sourceFamily, nextVenue) {
  const venue = norm(nextVenue || work.venue);
  const type = work.publication_type;

  if (type === 'journal_article') return 'journal';
  if (sourceFamily === 'NBER' || sourceFamily === 'SSRN') return 'working_paper_series';
  if (sourceFamily === 'IZA' || sourceFamily === 'CEPR') return 'discussion_paper_series';
  if (sourceFamily === 'OECD' && type === 'working_paper') return 'working_paper_series';
  if (sourceFamily === 'World Bank' && type === 'working_paper') return 'working_paper_series';
  if (sourceFamily === 'World Bank' && (venue.includes('open knowledge') || venue.includes('documents & reports'))) return 'repository';
  if (sourceFamily === 'IADB' || venue.includes('idb publication')) return 'institutional_publication';
  if (venue.includes('ebook') || venue.includes('ebooks')) return 'book_series';
  if (type === 'working_paper') return 'working_paper_series';
  if (type === 'discussion_paper') return 'discussion_paper_series';
  if (type === 'report') return 'institutional_publication';
  return 'other';
}

function derive(work) {
  const raw = work.raw_data || {};
  const seriesKey = norm(raw.series_key);
  const sourceFamily = deriveSourceFamily(work);
  const nextVenue = canonicalSeriesVenue(seriesKey, work.venue, work.publication_type);
  const venueKind = deriveVenueKind(work, sourceFamily, nextVenue);

  const patch = {
    source_family: sourceFamily,
    venue_kind: venueKind,
  };

  if (
    sourceFamily === 'NBER' &&
    ['other', 'report', 'journal_article', null, undefined].includes(work.publication_type)
  ) {
    patch.publication_type = 'working_paper';
    patch.publication_type_method = 'source_family_nber';
    patch.publication_type_confidence = 0.95;
  }

  if (
    sourceFamily === 'SSRN' &&
    norm(nextVenue) === 'ssrn electronic journal' &&
    work.publication_type !== 'working_paper'
  ) {
    patch.publication_type = 'working_paper';
    patch.publication_type_method = 'source_family_ssrn';
    patch.publication_type_confidence = 0.95;
  }

  if (nextVenue && nextVenue !== work.venue) {
    patch.venue = nextVenue;
  }

  return patch;
}

function needsUpdate(work, patch) {
  return (
    (work.source_family ?? null) !== (patch.source_family ?? null) ||
    (work.venue_kind ?? null) !== (patch.venue_kind ?? null) ||
    (patch.publication_type != null && patch.publication_type !== work.publication_type) ||
    (patch.venue != null && patch.venue !== work.venue)
  );
}

async function* iterateTargets() {
  let lastId = '';
  let processed = 0;
  while (processed < LIMIT) {
    const pageSize = Math.min(PAGE, LIMIT - processed);
    const { data, error } = await supabase
      .from('works')
      .select('id,title,venue,source,corpus_source,canonical_doi,url,publication_type,source_family,venue_kind,raw_data')
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(pageSize);
    if (error) throw new Error(`target fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    yield data;
    lastId = data[data.length - 1].id;
    processed += data.length;
    if (data.length < PAGE) break;
  }
}

async function applyUpdates(updates) {
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (u) => {
      const { id, ...fields } = u;
      const { error } = await supabase.from('works').update(fields).eq('id', id);
      if (error) {
        console.error(`  [warn] update ${id}: ${error.message}`);
        return false;
      }
      return true;
    }));
    ok += results.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('='.repeat(72));
  console.log('Backfill source_family + venue_kind');
  console.log('='.repeat(72));
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit:   ${LIMIT === Infinity ? '(unlimited)' : LIMIT.toLocaleString()}\n`);

  let scanned = 0;
  let changed = 0;
  let written = 0;
  const sourceCounts = {};
  const kindCounts = {};
  const venueChanges = {};

  for await (const page of iterateTargets()) {
    const updates = [];
    for (const work of page) {
      scanned += 1;
      const patch = derive(work);
      sourceCounts[patch.source_family || 'NULL'] = (sourceCounts[patch.source_family || 'NULL'] || 0) + 1;
      kindCounts[patch.venue_kind || 'NULL'] = (kindCounts[patch.venue_kind || 'NULL'] || 0) + 1;
      if (patch.venue && patch.venue !== work.venue) {
        const key = `${work.venue || 'NULL'} -> ${patch.venue}`;
        venueChanges[key] = (venueChanges[key] || 0) + 1;
      }
      if (needsUpdate(work, patch)) {
        changed += 1;
        updates.push({ id: work.id, ...patch });
      }
    }
    if (!DRY_RUN) written += await applyUpdates(updates);
    console.log(`  ${scanned.toLocaleString()} scanned · ${changed.toLocaleString()} changed · ${written.toLocaleString()} written`);
  }

  console.log('\nSource families:');
  for (const [k, v] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${v.toLocaleString()}`);
  }
  console.log('\nVenue kinds:');
  for (const [k, v] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v.toLocaleString()}`);
  }
  console.log('\nVenue normalizations:');
  for (const [k, v] of Object.entries(venueChanges).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${v.toLocaleString().padStart(7)}  ${k}`);
  }
}

main().catch((err) => {
  console.error('[backfill-source-family-venue-kind] failed:', err.message);
  process.exit(1);
});
