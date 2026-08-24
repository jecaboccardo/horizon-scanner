#!/usr/bin/env node
/**
 * Venue + publication_type backfill via Crossref.
 *
 * Targets canonical non-noise rows where venue IS NULL and id LIKE '10.%'.
 * OpenAlex (the original venue source) leaves book chapters / proceedings /
 * grey-lit sourceless; Crossref carries the host title in `container-title`.
 *
 *  - venue: filled from Crossref container-title[0] (gap-only — venue is null).
 *  - publication_type: CORRECTED only when Crossref's type maps to a more-specific
 *    value AND the current value is 'journal_article' or null (the known mistype:
 *    book chapters / proceedings stored as journal_article). Never overwrites an
 *    already-specific non-journal type. Golden rule: only fills/corrects, never
 *    replaces good data with worse.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-venue-pubtype-crossref.mjs --dry-run [--limit N]
 *   node --env-file=.env scripts/backfill-venue-pubtype-crossref.mjs [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();
const EMAIL = process.env.CROSSREF_EMAIL || 'horizon-scanner@iadb.org';
const PARALLEL = 4; // Crossref throttles bursts; 4-wide + 429-retry keeps us in the polite pool
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Crossref type -> our CHECK-verified enum (same map as backfill-pubtype-openalex)
function mapType(t) {
  if (!t) return null;
  const m = String(t).toLowerCase();
  if (m === 'article' || m === 'journal-article') return 'journal_article';
  if (m === 'book-chapter') return 'book_chapter';
  if (m === 'book' || m === 'monograph' || m === 'reference-book') return 'book';
  if (m === 'dissertation' || m === 'thesis') return 'dissertation';
  if (m === 'report' || m === 'report-component') return 'report';
  if (m === 'posted-content' || m === 'preprint') return 'preprint';
  if (m === 'proceedings-article' || m === 'proceedings') return 'conference_paper';
  if (m === 'dataset') return 'dataset';
  return null; // anything else: leave pub_type alone
}

async function fetchCrossref(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': `HorizonScanner/1.0 (mailto:${EMAIL})` }, signal: AbortSignal.timeout(10000) });
      if (r.status === 429 || r.status === 503) { await sleep(1500 * attempt); continue; }
      if (r.status === 404) return { notFound: true };
      if (!r.ok) return null;
      const m = (await r.json())?.message;
      if (!m) return null;
      const venue = Array.isArray(m['container-title']) ? m['container-title'].find(Boolean) : null;
      return { venue: venue || null, type: mapType(m.type) };
    } catch { await sleep(1000); }
  }
  return null;
}

async function main() {
  console.log(`\n=== Venue + pub_type backfill (Crossref) ===\nDry run: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  // Load gap set: null venue, canonical, non-noise, with DOI
  const rows = [];
  let cursor = '';
  while (rows.length < LIMIT) {
    let q = sb.from('works').select('id, canonical_doi, publication_type, title')
      .is('venue', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .like('id', '10.%').order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('fetch:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  const targets = rows.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} null-venue rows with DOI`);

  let venueFilled = 0, typeFixed = 0, noVenue = 0, notInCrossref = 0, errors = 0;
  const typeChanges = {};
  const start = Date.now();

  for (let i = 0; i < targets.length; i += PARALLEL) {
    const chunk = targets.slice(i, i + PARALLEL);
    const results = await Promise.all(chunk.map(r => fetchCrossref(r.canonical_doi || r.id)));
    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      const cr = results[j];
      if (!cr) { errors++; continue; }
      if (cr.notFound) { notInCrossref++; continue; }
      const update = {};
      if (cr.venue) update.venue = cr.venue; else noVenue++;
      // conservative pub_type correction
      const cur = row.publication_type;
      if (cr.type && cr.type !== cur && (cur === 'journal_article' || cur == null) && cr.type !== 'journal_article') {
        update.publication_type = cr.type;
      }
      if (!Object.keys(update).length) continue;
      if (DRY_RUN) {
        if (venueFilled + typeFixed < 25) {
          const parts = [];
          if (update.venue) parts.push(`venue="${update.venue.slice(0, 45)}"`);
          if (update.publication_type) parts.push(`type ${cur}→${update.publication_type}`);
          console.log(`  [dry] ${row.id}: ${parts.join(' | ')}`);
        }
        if (update.venue) venueFilled++;
        if (update.publication_type) { typeFixed++; typeChanges[`${cur}->${update.publication_type}`] = (typeChanges[`${cur}->${update.publication_type}`] || 0) + 1; }
        continue;
      }
      const { error } = await sb.from('works').update(update).eq('id', row.id);
      if (error) { console.error(`update ${row.id}:`, error.message); errors++; continue; }
      if (update.venue) venueFilled++;
      if (update.publication_type) { typeFixed++; typeChanges[`${cur}->${update.publication_type}`] = (typeChanges[`${cur}->${update.publication_type}`] || 0) + 1; }
    }
    if ((i / PARALLEL) % 20 === 0) process.stdout.write(`\r  ${Math.min(i + PARALLEL, targets.length)}/${targets.length} (venue ${venueFilled}, type ${typeFixed}, noVenue ${noVenue}, err ${errors})   `);
    await sleep(50);
  }

  const summary = {
    generated_at: new Date().toISOString(), dry_run: DRY_RUN, targets: targets.length,
    venue_filled: venueFilled, pub_type_fixed: typeFixed, no_container_title: noVenue, not_in_crossref: notInCrossref, errors,
    type_changes: typeChanges, elapsed_min: ((Date.now() - start) / 60000).toFixed(1),
  };
  console.log(`\n\n=== Done ===\n${JSON.stringify(summary, null, 2)}`);
  if (!DRY_RUN) {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/venue-pubtype-crossref-2026-06-22.json', JSON.stringify(summary, null, 2));
  }
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
