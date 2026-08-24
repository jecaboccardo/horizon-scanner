/**
 * scripts/backfill-abs-rating.mjs
 *
 * Backfills the abs_rating column on works using the abs_rankings table.
 * Only updates rows where abs_rating IS NULL and publication_type = journal_article.
 * Uses the same normalization logic as journalRankings.ts.
 *
 * Approach: iterate over abs_rankings entries (1,635 journals), for each look up
 * matching works by venue name (case-insensitive) and batch-update abs_rating.
 * Gap-only — never overwrites existing values.
 *
 * Usage:
 *   node --env-file="D:/IADB work/Horizon-scanner-IADB/.env" scripts/backfill-abs-rating.mjs --dry-run
 *   node --env-file="D:/IADB work/Horizon-scanner-IADB/.env" scripts/backfill-abs-rating.mjs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();

const isDryRun = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Mirror of journalRankings.ts normalize()
function normalize(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')   // strip "(United Kingdom)" etc.
    .replace(/&/g, ' and ')            // & → and
    .replace(/^the\s+/i, '')           // strip leading "the "
    .replace(/[^a-z0-9\s]/g, '')       // remove punctuation (colons, hyphens…)
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAll(table, columns) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(columns).range(offset, offset + PAGE - 1);
    if (error) { console.error(`fetchAll(${table}):`, error.message); break; }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function countVenue(venue) {
  const { count, error } = await sb
    .from('works')
    .select('id', { count: 'exact', head: true })
    .eq('venue', venue)
    .eq('publication_type', 'journal_article')
    .is('canonical_work_id', null)
    .is('abs_rating', null);
  if (error) return 0;
  return count ?? 0;
}

async function main() {
  console.log(`\nabs_rating backfill${isDryRun ? ' [DRY RUN]' : ''}\n`);

  // 1. Load all abs_rankings
  console.log('Loading abs_rankings…');
  const rankings = await fetchAll('abs_rankings', 'journal_name, abs_rating');
  console.log(`  ${rankings.length} rankings entries\n`);

  // 2. For each ranking, find matching works venues.
  // Build a map from normalized key → (abs_rating, variants[])
  // Then check which exact venue strings in works match.
  //
  // Since we can't do a lower() scan of works via PostgREST efficiently,
  // we'll collect the distinct venues from the abs_rankings table itself
  // and then group rankings by normalized key. For each normalized key,
  // we try the original name and common variants.
  const byNorm = new Map(); // normalized → { absRating, names[] }
  for (const r of rankings) {
    const key = normalize(r.journal_name);
    if (!key) continue;
    if (!byNorm.has(key)) byNorm.set(key, { absRating: r.abs_rating, names: [] });
    byNorm.get(key).names.push(r.journal_name);
  }

  // Generate venue name candidates to try for each entry
  // (original, with "The " prefix, without "The " prefix, & ↔ and variants)
  function candidates(names) {
    const set = new Set();
    for (const n of names) {
      set.add(n);
      if (n.startsWith('The ')) set.add(n.slice(4));
      else set.add('The ' + n);
      // & ↔ and
      if (n.includes('&')) set.add(n.replace(/&/g, 'and').replace(/\s+/g, ' ').trim());
      if (n.includes(' and ')) set.add(n.replace(/ and /g, ' & '));
      // Colon variants
      if (n.includes(':')) set.add(n.replace(/:/g, '').replace(/\s+/g, ' ').trim());
      if (n.includes('  ')) set.add(n.replace(/\s+/g, ' '));
    }
    return [...set];
  }

  // 3. Check each journal against the DB
  const toUpdate = []; // { venue, absRating, count }
  let checked = 0;
  let found = 0;

  for (const [, { absRating, names }] of byNorm) {
    checked++;
    if (checked % 100 === 0) process.stdout.write(`\r  Checked ${checked}/${byNorm.size}…`);

    for (const candidate of candidates(names)) {
      const count = await countVenue(candidate);
      if (count > 0) {
        toUpdate.push({ venue: candidate, absRating, count });
        found++;
        break; // found a match, move to next journal
      }
    }
  }
  console.log(`\r  Checked ${byNorm.size}/${byNorm.size} journals`);

  const totalPapers = toUpdate.reduce((s, u) => s + u.count, 0);
  console.log(`\nMatched: ${toUpdate.length} journals → ${totalPapers} papers to update\n`);

  if (toUpdate.length === 0) { console.log('Nothing to update.'); return; }

  // Show preview
  const preview = [...toUpdate].sort((a, b) => b.count - a.count).slice(0, 30);
  console.log('Top 30 matches:');
  preview.forEach(u =>
    console.log(`  ${String(u.count).padStart(6)}  ABS=${u.absRating.padEnd(3)}  ${u.venue.slice(0, 65)}`),
  );

  const dist = {};
  for (const u of toUpdate) dist[u.absRating] = (dist[u.absRating] || 0) + u.count;
  console.log('\nRating distribution (papers):');
  Object.entries(dist).sort().forEach(([r, c]) => console.log(`  ABS=${r.padEnd(4)} ${c} papers`));

  if (isDryRun) {
    console.log('\n[DRY RUN] No updates written. Remove --dry-run to apply.');
    return;
  }

  // 4. Apply updates
  console.log('\nApplying updates…');
  let totalUpdated = 0;
  let errors = 0;
  for (const u of toUpdate) {
    const { error } = await sb
      .from('works')
      .update({ abs_rating: u.absRating })
      .eq('venue', u.venue)
      .eq('publication_type', 'journal_article')
      .is('canonical_work_id', null)
      .is('abs_rating', null);
    if (error) {
      console.error(`  ERROR "${u.venue}":`, error.message);
      errors++;
    } else {
      totalUpdated += u.count;
      process.stdout.write(`\r  Updated ~${totalUpdated} papers…`);
    }
  }
  console.log(`\n\nDone. ~${totalUpdated} papers updated across ${toUpdate.length} journals. ${errors} errors.`);
}

main().catch(e => { console.error(e); process.exit(1); });
