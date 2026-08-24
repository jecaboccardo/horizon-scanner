#!/usr/bin/env node
/**
 * GAP-ONLY backfill of works.source_family.
 *
 * Fills source_family ONLY on rows where it is currently NULL, using the same
 * deterministic derivation as backfill-source-family-venue-kind.mjs. NEVER
 * overwrites a populated source_family (golden rule). Also fills venue_kind
 * only where it is currently NULL (additive, used by display, not the filter).
 *
 * Why: the default source-universe filter (resolveSourceDefaults, 2026-06-17)
 * matches institutional papers by source_family OR venue text. ~7,270 wb:
 * papers (and others) have NULL source_family, so they pass only via venue
 * hints — fragile. Tagging the family makes the match robust.
 *
 * Usage:
 *   node scripts/backfill-source-family-gaponly.mjs --dry-run
 *   node scripts/backfill-source-family-gaponly.mjs            # apply
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
const PAGE = 1000;
const CONCURRENCY = 10;

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Same derivation as backfill-source-family-venue-kind.mjs (deterministic).
function deriveSourceFamily(work) {
  const raw = work.raw_data || {};
  const seriesKey = norm(raw.series_key);
  const venue = norm(work.venue);
  const source = norm(work.source);
  const corpus = norm(work.corpus_source);
  const doi = norm(work.canonical_doi);
  const url = norm(work.url);
  const institution = norm(raw.institution);
  const id = norm(work.id);

  if (seriesKey === 'nber' || doi.startsWith('10.3386/')) return 'NBER';
  if (seriesKey === 'iza') return 'IZA';
  if (seriesKey === 'cepr') return 'CEPR';
  if (seriesKey === 'oecd' || doi.startsWith('10.1787/') || venue.includes('oecd')) return 'OECD';
  if (seriesKey === 'wb' || id.startsWith('wb:') || doi.startsWith('10.1596/') || institution === 'world bank' ||
      venue.includes('world bank') || venue.includes('policy research working paper') ||
      url.includes('worldbank.org') || url.includes('openknowledge.worldbank')) return 'World Bank';
  if (id.startsWith('idb:') || id.startsWith('iadb:') || doi.startsWith('10.18235/') ||
      institution === 'idb' || institution === 'iadb' || source === 'idb' || source === 'idb_publications' ||
      corpus === 'idb_bulk' || venue.includes('idb publication') || url.includes('iadb.org')) return 'IADB';
  if (venue.includes('international monetary fund') || venue.includes('imf working paper') ||
      venue.includes('imf staff') || /\bimf\b/.test(venue)) return 'IMF';
  if (venue === 'ssrn electronic journal' || doi.startsWith('10.2139/ssrn')) return 'SSRN';
  if (source === 'repec' || venue === 'repec: research papers in economics' ||
      url.includes('ideas.repec.org') || url.includes('econpapers.repec.org')) return 'RePEc';
  return null;
}

function deriveVenueKind(work, sf) {
  const venue = norm(work.venue);
  const type = work.publication_type;
  if (type === 'journal_article') return 'journal';
  if (sf === 'NBER' || sf === 'SSRN') return 'working_paper_series';
  if (sf === 'IZA' || sf === 'CEPR') return 'discussion_paper_series';
  if ((sf === 'OECD' || sf === 'World Bank' || sf === 'IMF') && type === 'working_paper') return 'working_paper_series';
  if (sf === 'World Bank' && (venue.includes('open knowledge') || venue.includes('documents & reports'))) return 'repository';
  if (sf === 'IADB' || venue.includes('idb publication')) return 'institutional_publication';
  if (type === 'working_paper') return 'working_paper_series';
  if (type === 'discussion_paper') return 'discussion_paper_series';
  if (type === 'report') return 'institutional_publication';
  return null; // don't force 'other' on gap-fill
}

async function* iterateNullFamily() {
  let lastId = '';
  for (;;) {
    const { data, error } = await supabase
      .from('works')
      .select('id,title,venue,source,corpus_source,canonical_doi,url,publication_type,source_family,venue_kind,raw_data')
      .is('source_family', null)
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(PAGE);
    if (error) throw new Error(`fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    yield data;
    lastId = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
}

async function applyUpdates(updates) {
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const res = await Promise.all(slice.map(async (u) => {
      const { id, ...fields } = u;
      const { error } = await supabase.from('works').update(fields).eq('id', id);
      if (error) { console.error(`  [warn] ${id}: ${error.message}`); return false; }
      return true;
    }));
    ok += res.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('GAP-ONLY source_family backfill — dry-run:', DRY_RUN);
  let scanned = 0, family = 0, written = 0;
  const counts = {};
  for await (const page of iterateNullFamily()) {
    const updates = [];
    for (const w of page) {
      scanned += 1;
      const sf = deriveSourceFamily(w);
      counts[sf || '(undetermined)'] = (counts[sf || '(undetermined)'] || 0) + 1;
      if (!sf) continue;                       // can't determine → leave null
      family += 1;
      const patch = { source_family: sf };
      if (w.venue_kind == null) {              // gap-only on venue_kind too
        const vk = deriveVenueKind(w, sf);
        if (vk) patch.venue_kind = vk;
      }
      updates.push({ id: w.id, ...patch });
    }
    if (!DRY_RUN && updates.length) written += await applyUpdates(updates);
    process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · derivable ${family.toLocaleString()} · written ${written.toLocaleString()}   `);
  }
  console.log('\n\nNull-family rows by derived family:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${v.toLocaleString()}`);
  }
  console.log(`\nTotal scanned (null source_family): ${scanned.toLocaleString()}`);
  console.log(`Derivable (would be filled):        ${family.toLocaleString()}`);
  console.log(`Left null (undetermined):           ${(scanned - family).toLocaleString()}`);
  if (!DRY_RUN) console.log(`Written:                            ${written.toLocaleString()}`);
}

main().catch((e) => { console.error('\nfailed:', e.message); process.exit(1); });
