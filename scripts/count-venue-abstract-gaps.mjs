#!/usr/bin/env node
// Counts abstract gaps per venue (canonical, non-noise).
// Patterns are "The"-prefix / colon tolerant (corpus stores e.g. "The Quarterly Journal of Economics").
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// [label, ilike-pattern]
const VENUES = [
  ['Journal of Development Economics',            'Journal of Development Economics'],
  ['Journal of Labor Economics',                 'Journal of Labor Economics'],
  ['AEJ: Applied Economics',                     'American Economic Journal%Applied Economics'],
  ['AEJ: Economic Policy',                        'American Economic Journal%Economic Policy'],
  ['American Economic Review',                    'American Economic Review'],
  ['Quarterly Journal of Economics',             '%Quarterly Journal of Economics'],
  ['Review of Economics and Statistics',         '%Review of Economics and Statistics'],
  ['Journal of Political Economy',               'Journal of Political Economy'],
  ['Journal of Public Economics',                'Journal of Public Economics'],
  ['World Bank Economic Review',                 '%World Bank Economic Review'],
  ['Economic Development and Cultural Change',    'Economic Development and Cultural Change'],
  ['World Development',                            'World Development'],
  ['Journal of Human Resources',                 '%Journal of Human Resources'],
  ['Labour Economics',                            'Labour Economics'],
  ['Oxford Open Economics',                       'Oxford Open Economics'],
  ['Economics of Education Review',               'Economics of Education Review'],
  ['Educational Evaluation and Policy Analysis',  'Educational Evaluation and Policy Analysis'],
  ['Comparative Education Review',                'Comparative Education Review'],
  ['International Journal of Educational Devt',    'International Journal of Educational Development'],
  ['Journal of Policy Analysis and Management',   'Journal of Policy Analysis and Management'],
];

async function cnt(extraFilters = []) {
  let q = sb.from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true);
  for (const f of extraFilters) q = q[f[0]](...f.slice(1));
  const { count, error } = await q;
  if (error) throw new Error(JSON.stringify(error));
  return count;
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log('Venue abstract-gap report (canonical, non-noise)\n');
console.log(pad('Venue', 44), padl('Total', 8), padl('NoAbs', 8), padl('%miss', 7));
console.log('-'.repeat(69));

let sumTotal = 0, sumMiss = 0;
for (const [label, pat] of VENUES) {
  const total = await cnt([['ilike', 'venue', pat]]);
  const miss = await cnt([['ilike', 'venue', pat], ['is', 'abstract', null]]);
  sumTotal += total; sumMiss += miss;
  const pct = total ? ((miss / total) * 100).toFixed(0) : '-';
  console.log(pad(label.slice(0, 43), 44), padl(total, 8), padl(miss, 8), padl(pct, 7));
}
console.log('-'.repeat(69));
console.log(pad('JOURNAL SUBTOTAL', 44), padl(sumTotal, 8), padl(sumMiss, 8),
  padl(sumTotal ? ((sumMiss / sumTotal) * 100).toFixed(0) : '-', 7));

console.log('\nWorking-paper repositories:');
for (const [label, filters] of [
  ['NBER (id 10.3386 prefix)', [['like', 'id', '10.3386%']]],
  ['NBER (venue ilike)', [['ilike', 'venue', '%NBER%']]],
  ['RePEc / IDEAS (venue ilike)', [['ilike', 'venue', '%RePEc%']]],
]) {
  const total = await cnt(filters);
  const miss = await cnt([...filters, ['is', 'abstract', null]]);
  const pct = total ? ((miss / total) * 100).toFixed(0) : '-';
  console.log(pad(label, 44), padl(total, 8), padl(miss, 8), padl(pct, 7));
}
