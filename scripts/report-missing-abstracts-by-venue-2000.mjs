#!/usr/bin/env node
// Data-driven: which venues (canonical, non-noise, year>=2000) have the most
// missing-abstract papers? No hardcoded journal list — ranks by actual gap size.
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MIN_YEAR = Number(process.argv.find(a => a.startsWith('--min-year='))?.split('=')[1] ?? 2000);
const TOP_N = Number(process.argv.find(a => a.startsWith('--top='))?.split('=')[1] ?? 60);

async function fetchAllMissing() {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await sb
      .from('works')
      .select('venue, year')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .is('abstract', null)
      .gte('year', MIN_YEAR)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(JSON.stringify(error));
    if (!data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchVenueTotal(venue) {
  const { count, error } = await sb
    .from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .gte('year', MIN_YEAR)
    .eq('venue', venue);
  if (error) throw new Error(JSON.stringify(error));
  return count;
}

console.log(`Fetching missing-abstract rows (year>=${MIN_YEAR}, canonical, non-noise)...`);
const rows = await fetchAllMissing();
console.log(`Fetched ${rows.length} missing-abstract rows.\n`);

const byVenue = new Map();
for (const r of rows) {
  const v = r.venue || '(no venue / working paper)';
  byVenue.set(v, (byVenue.get(v) || 0) + 1);
}

const ranked = [...byVenue.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);

console.log('Resolving totals per venue (for % missing)...');
const withTotals = [];
for (const [venue, miss] of ranked) {
  const total = venue === '(no venue / working paper)' ? null : await fetchVenueTotal(venue);
  withTotals.push({ venue, miss, total });
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log(`\nTop ${TOP_N} venues by missing-abstract count (year>=${MIN_YEAR})\n`);
console.log(pad('Venue', 55), padl('Missing', 9), padl('Total', 8), padl('%miss', 7));
console.log('-'.repeat(80));
let sumMiss = 0;
for (const { venue, miss, total } of withTotals) {
  sumMiss += miss;
  const pct = total ? ((miss / total) * 100).toFixed(0) : '-';
  console.log(pad(venue.slice(0, 54), 55), padl(miss, 9), padl(total ?? '-', 8), padl(pct, 7));
}
console.log('-'.repeat(80));
console.log(`Sum of top ${TOP_N}: ${sumMiss} / ${rows.length} total missing-abstract rows (year>=${MIN_YEAR})`);
