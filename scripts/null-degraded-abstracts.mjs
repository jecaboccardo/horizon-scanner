#!/usr/bin/env node
/**
 * Null out degraded "Elsevier Highlights" bullet abstracts so the ScienceDirect
 * CDP scraper can re-fill them with real prose abstracts.
 *
 * Target: canonical non-noise papers whose abstract is a bullet-point highlights
 * list ("•We find...", "Highlights•...", or unstripped HTML) — these pass
 * isRealAbstract's length check but embed very poorly with qwen-768.
 *
 * After running this, run:
 *   node scripts/backfill-abstracts-sciencedirect-cdp.mjs --dois <file>
 * to refill with real prose, followed by:
 *   node scripts/backfill-embed-new.mjs
 * to re-embed.
 *
 * Usage:
 *   node --env-file=.env scripts/null-degraded-abstracts.mjs --dry-run
 *   node --env-file=.env scripts/null-degraded-abstracts.mjs --apply
 *   node --env-file=.env scripts/null-degraded-abstracts.mjs --apply --venues "Journal of Economic Behavior & Organization,World Development"
 *   node --env-file=.env scripts/null-degraded-abstracts.mjs --apply --min-year 2015
 *   node --env-file=.env scripts/null-degraded-abstracts.mjs --restore   (restore from raw_data.abstract_bullet_backup)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { HIGHLIGHTS_RE, HTML_TAG_RE } from './lib/abstract-quality.mjs';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply') && !args.includes('--restore');
const RESTORE = args.includes('--restore');
const VENUES_ARG = (() => { const i = args.indexOf('--venues'); return i >= 0 ? args[i+1].split(',').map(s => s.trim()).filter(Boolean) : []; })();
const MIN_YEAR = (() => { const i = args.indexOf('--min-year'); return i >= 0 ? Number(args[i+1]) : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i+1]) : 10000; })();

function isDegraded(abstract) {
  if (!abstract) return false;
  const s = String(abstract).trim();
  return HIGHLIGHTS_RE.test(s) || HTML_TAG_RE.test(s);
}

function stripHtml(s) {
  // Strip HTML tags — used to check if stripping alone fixes the abstract
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ── RESTORE MODE: put backed-up bullet abstracts back ──────────────────────
if (RESTORE) {
  console.log('RESTORE MODE: restoring abstracts from raw_data.abstract_bullet_backup...');
  let page = 0, restored = 0, skipped = 0, cursor2 = '';
  while (true) {
    let q = sb.from('works')
      .select('id, abstract, raw_data')
      .is('abstract', null)
      .is('canonical_work_id', null)
      .not('raw_data->abstract_bullet_backup', 'is', null)
      .order('id', { ascending: true })
      .limit(500);
    if (cursor2) q = q.gt('id', cursor2);
    const { data, error } = await q;
    if (error || !data?.length) break;
    cursor2 = data[data.length - 1].id;
    for (const r of data) {
      const backup = r.raw_data?.abstract_bullet_backup;
      if (!backup) { skipped++; continue; }
      const rd = { ...r.raw_data };
      delete rd.abstract_bullet_backup;
      const { error: we } = await sb.from('works').update({ abstract: backup, raw_data: rd }).eq('id', r.id).is('abstract', null);
      if (we) { console.error('restore error', r.id, we.message); }
      else restored++;
    }
    process.stdout.write(`\r  restored ${restored}`);
  }
  console.log(`\nDone. Restored: ${restored} | skipped (already has abstract): ${skipped}`);
  process.exit(0);
}

console.log(`Mode: ${DRY_RUN ? 'DRY RUN (pass --apply to write)' : 'APPLY'}`);
if (VENUES_ARG.length) console.log(`Venue filter: ${VENUES_ARG.join(', ')}`);
if (MIN_YEAR) console.log(`Year filter: >= ${MIN_YEAR}`);
console.log('');

// Fetch in pages — PostgREST can't filter on abstract content so we filter in JS
const PAGE = 1000;
let cursor = '', scanned = 0;
const toNull = [];   // { id, canonical_doi, title, venue, year, abstract }
const htmlOnly = []; // HTML-only (stripping might be enough — separate decision)

while (toNull.length + htmlOnly.length < LIMIT) {
  let q = sb.from('works')
    .select('id, canonical_doi, title, venue, year, abstract, citation_count')
    .is('canonical_work_id', null)
    .neq('is_noise', true)
    .not('abstract', 'is', null)
    .order('id', { ascending: true })
    .limit(PAGE);
  if (cursor) q = q.gt('id', cursor);
  if (VENUES_ARG.length) q = q.in('venue', VENUES_ARG);
  if (MIN_YEAR) q = q.gte('year', MIN_YEAR);

  const { data, error } = await q;
  if (error) { console.error('fetch error:', error.message); break; }
  if (!data?.length) break;
  cursor = data[data.length - 1].id;
  scanned += data.length;

  for (const r of data) {
    const s = String(r.abstract || '').trim();
    if (HIGHLIGHTS_RE.test(s)) {
      toNull.push(r);
    } else if (HTML_TAG_RE.test(s)) {
      // For HTML-only: stripping might salvage it without a scraper pass
      const stripped = stripHtml(s);
      if (stripped.length >= 80) {
        htmlOnly.push({ ...r, _stripped: stripped });
      } else {
        toNull.push(r); // too short after stripping — need a real scrape
      }
    }
  }

  process.stdout.write(`\r  scanned ${scanned} | bullet-degraded: ${toNull.length} | html-strip-fixable: ${htmlOnly.length}`);
  if (data.length < PAGE) break;
}

console.log(`\n\n=== Results ===`);
console.log(`Bullet-highlights (null + re-scrape needed): ${toNull.length}`);
console.log(`HTML-only (strip-in-place fixable):          ${htmlOnly.length}`);

// Show top 20 by citation count
const sorted = [...toNull].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
console.log('\nTop 20 bullet-degraded by citation count:');
sorted.slice(0, 20).forEach(r =>
  console.log(`  cit:${r.citation_count||0} | ${String(r.canonical_doi||r.id).slice(0,35)} | ${String(r.venue||'').slice(0,30)} | ${String(r.title||'').slice(0,55)}`));

if (htmlOnly.length > 0) {
  console.log('\nTop 10 HTML-strip-fixable:');
  htmlOnly.sort((a,b) => (b.citation_count||0)-(a.citation_count||0)).slice(0,10).forEach(r =>
    console.log(`  cit:${r.citation_count||0} | ${String(r.canonical_doi||r.id).slice(0,35)} | ${String(r.venue||'').slice(0,30)}`));
}

// Write DOI list for the CDP scraper
const outFile = `reports/_degraded-abstracts-to-rescrape.json`;
fs.writeFileSync(outFile, JSON.stringify(toNull.map(r => ({ id: r.id, doi: r.canonical_doi || r.id, venue: r.venue })), null, 2));
console.log(`\nSaved ${toNull.length} IDs to ${outFile}`);

if (DRY_RUN) {
  console.log('\nDRY RUN — no changes written. Pass --apply to null abstracts + embeddings.');
  process.exit(0);
}

// APPLY: null abstract + embedding for bullet-degraded rows, strip-fix HTML-only rows
// 🔒 BACKUP FIRST: copy bullet abstract to raw_data.abstract_bullet_backup before nulling
// so recovery is always possible even if the CDP scraper session doesn't complete.
console.log('\nApplying (backing up bullet abstracts to raw_data before nulling)...');
let nulled = 0, stripped = 0, errors = 0;

// Null bullet-degraded in chunks — backup abstract into raw_data first
for (let i = 0; i < toNull.length; i += 100) {
  const chunk = toNull.slice(i, i + 100);
  // Fetch current raw_data for backup
  const { data: current } = await sb.from('works').select('id, raw_data, abstract').in('id', chunk.map(r => r.id));
  for (const row of (current || [])) {
    const rd = { ...(row.raw_data || {}), abstract_bullet_backup: row.abstract };
    const { error } = await sb.from('works')
      .update({ abstract: null, embedding: null, raw_data: rd })
      .eq('id', row.id);
    if (error) { console.error(`null ${row.id}: ${error.message}`); errors++; }
    else nulled++;
  }
  process.stdout.write(`\r  backed up + nulled ${nulled}/${toNull.length}`);
}

// Strip-fix HTML-only rows
for (const r of htmlOnly) {
  const { error } = await sb.from('works')
    .update({ abstract: r._stripped, embedding: null })
    .eq('id', r.id)
    .not('abstract', 'is', null); // safety: gap guard
  if (error) { errors++; } else stripped++;
}

console.log(`\n\nDone.`);
console.log(`  Nulled (needs re-scrape):  ${nulled}`);
console.log(`  HTML-stripped (re-embed):  ${stripped}`);
console.log(`  Errors:                    ${errors}`);
console.log(`\nNext steps:`);
console.log(`  1. Re-scrape with ScienceDirect CDP scraper (see reports/_degraded-abstracts-to-rescrape.json)`);
console.log(`  2. Re-embed: node --env-file=.env scripts/backfill-embed-new.mjs`);
