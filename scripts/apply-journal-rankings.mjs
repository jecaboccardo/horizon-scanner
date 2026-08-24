#!/usr/bin/env node
/**
 * Apply existing ABS + IDEAS/RePEc rankings to works.
 *
 * Reads from public.abs_rankings (1,635 entries) and
 * public.ideas_repec_rankings (3,356 entries) — these are already
 * loaded but never matched against works at scale.
 *
 * Match strategy: normalize venue name (lowercase, trim, strip leading
 * "The ", collapse whitespace, strip trailing punctuation). Exact match
 * against normalized journal_name in each ranking table.
 *
 * Writes:
 *   works.abs_rating          — from abs_rankings.abs_rating
 *   works.repec_rank          — from ideas_repec_rankings.rank
 *   works.repec_percentile    — from ideas_repec_rankings.percentile
 *
 * Idempotent. Safe to re-run. Updates only rows where the target column
 * is NULL (won't overwrite existing values).
 *
 * Usage:
 *   node scripts/apply-journal-rankings.mjs --dry-run         # report match rate, no writes
 *   node scripts/apply-journal-rankings.mjs --limit 5000      # cap test run
 *   node scripts/apply-journal-rankings.mjs                   # apply all
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
const BATCH_UPDATE = 200;

function normalizeJournalName(name) {
  if (!name || typeof name !== 'string') return null;
  let s = name.trim().toLowerCase();
  s = s.replace(/^the\s+/, '');                 // drop leading "The "
  s = s.replace(/\s*&\s*/g, ' and ');            // & → and
  s = s.replace(/[\.,;:'"`]+/g, '');             // strip punctuation
  s = s.replace(/\s+/g, ' ').trim();             // collapse whitespace
  return s || null;
}

async function loadAllRows(table, cols) {
  // PostgREST default limit is 1,000. Paginate to load every row.
  const out = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(cols)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

async function loadRankings() {
  const abs = new Map();
  const repec = new Map();

  const absRows = await loadAllRows('abs_rankings', 'journal_name, abs_rating');
  for (const r of absRows) {
    const key = normalizeJournalName(r.journal_name);
    if (key && r.abs_rating) abs.set(key, r.abs_rating);
  }

  const repecRows = await loadAllRows('ideas_repec_rankings', 'journal_name, rank, percentile');
  for (const r of repecRows) {
    const key = normalizeJournalName(r.journal_name);
    if (key) repec.set(key, { rank: r.rank ?? null, percentile: r.percentile ?? null });
  }

  return { abs, repec };
}

async function fetchPageWithRetry(offset, attempt = 0) {
  try {
    const { data, error } = await supabase
      .from('works')
      .select('id, venue, abs_rating, repec_percentile')
      .not('venue', 'is', null)
      .or('abs_rating.is.null,repec_percentile.is.null')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    return data;
  } catch (err) {
    if (attempt < 3) {
      const wait = 2000 * (attempt + 1);
      console.error(`  [retry ${attempt + 1}] page offset=${offset}: ${err.message} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return fetchPageWithRetry(offset, attempt + 1);
    }
    throw err;
  }
}

async function* iterateTargets() {
  // Targets: works with a venue but missing BOTH abs_rating AND repec_percentile.
  // We're aggressive — if either is set, skip (idempotency).
  let offset = 0;
  while (offset < LIMIT) {
    const data = await fetchPageWithRetry(offset);
    if (!data || data.length === 0) break;
    yield data;
    if (data.length < PAGE) break;
    offset += PAGE;
  }
}

async function applyUpdates(updates) {
  if (updates.length === 0) return 0;
  // Per-row UPDATE — upsert routes through INSERT...ON CONFLICT and fails the
  // not-null check on `title` because we don't send all required columns.
  // Limited concurrency keeps Kong happy.
  const CONCURRENCY = 10;
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (u) => {
        const { id, ...fields } = u;
        try {
          const { error } = await supabase.from('works').update(fields).eq('id', id);
          if (error) {
            console.error(`  [warn] update ${id} failed: ${error.message}`);
            return false;
          }
          return true;
        } catch (err) {
          console.error(`  [warn] update ${id} threw: ${err.message}`);
          return false;
        }
      }),
    );
    ok += results.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Apply journal rankings to works');
  console.log('='.repeat(70));
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit:   ${LIMIT === Infinity ? '(unlimited)' : LIMIT.toLocaleString()}\n`);

  console.log('Loading ranking tables...');
  const { abs, repec } = await loadRankings();
  console.log(`  abs_rankings:         ${abs.size.toLocaleString()} unique normalized names`);
  console.log(`  ideas_repec_rankings: ${repec.size.toLocaleString()} unique normalized names\n`);

  let processed = 0;
  let absMatches = 0;
  let repecMatches = 0;
  let bothMatches = 0;
  let noMatch = 0;
  let writtenTotal = 0;
  let pendingPage = [];

  console.log('Scanning works (flush after each page)...\n');
  for await (const page of iterateTargets()) {
    for (const w of page) {
      processed += 1;
      const key = normalizeJournalName(w.venue);
      if (!key) { noMatch += 1; continue; }
      const absHit = abs.get(key);
      const repecHit = repec.get(key);
      if (!absHit && !repecHit) { noMatch += 1; continue; }

      const update = { id: w.id };
      if (absHit && w.abs_rating == null) {
        update.abs_rating = absHit;
        absMatches += 1;
      }
      if (repecHit && w.repec_percentile == null) {
        update.repec_rank = repecHit.rank;
        update.repec_percentile = repecHit.percentile;
        repecMatches += 1;
      }
      if (absHit && repecHit) bothMatches += 1;
      if (Object.keys(update).length > 1) pendingPage.push(update);
    }

    // Flush after each page so a mid-run crash doesn't lose progress.
    if (!DRY_RUN && pendingPage.length > 0) {
      const ok = await applyUpdates(pendingPage);
      writtenTotal += ok;
      pendingPage = [];
    }

    console.log(`  ${processed.toLocaleString()} scanned · ${absMatches.toLocaleString()} ABS · ${repecMatches.toLocaleString()} RePEc · ${noMatch.toLocaleString()} no-match · ${writtenTotal.toLocaleString()} written`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Summary:');
  console.log(`  Works scanned:    ${processed.toLocaleString()}`);
  console.log(`  ABS matches:      ${absMatches.toLocaleString()} (${(absMatches / Math.max(processed, 1) * 100).toFixed(1)}%)`);
  console.log(`  RePEc matches:    ${repecMatches.toLocaleString()} (${(repecMatches / Math.max(processed, 1) * 100).toFixed(1)}%)`);
  console.log(`  Both:             ${bothMatches.toLocaleString()}`);
  console.log(`  No match:         ${noMatch.toLocaleString()} (${(noMatch / Math.max(processed, 1) * 100).toFixed(1)}%)`);
  console.log(`  Written:          ${writtenTotal.toLocaleString()}`);

  if (DRY_RUN) console.log('\nDry run — no writes performed.');
}

main().catch((err) => {
  console.error('[apply-journal-rankings] failed:', err.message);
  process.exit(1);
});
