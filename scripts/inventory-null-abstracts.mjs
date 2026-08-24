#!/usr/bin/env node
/**
 * STEP 0 inventory: segment the null-abstract canonical non-noise papers.
 *
 * Reports: DOI vs no-DOI; by DOI prefix (registrant); by year bucket; top venues.
 * Read-only. Writes reports/null-abstract-inventory-YYYY-MM-DD.json.
 *
 * Usage: node --env-file=.env scripts/inventory-null-abstracts.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const PREFIX_LABELS = {
  '10.3386': 'NBER working papers',
  '10.2307': 'JSTOR (legacy journals)',
  '10.1257': 'AEA journals',
  '10.2139': 'SSRN',
  '10.1016': 'Elsevier',
  '10.1111': 'Wiley',
  '10.1093': 'Oxford UP',
  '10.1007': 'Springer',
  '10.1086': 'U Chicago Press',
  '10.1162': 'MIT Press',
  '10.1257': 'AEA',
  '10.18235': 'IADB (IDB Publications)',
  '10.1596': 'World Bank',
  '10.48550': 'arXiv',
  '10.5018': 'RePEc/various',
};

function prefixOf(doi) {
  if (!doi) return '(no DOI)';
  const m = String(doi).match(/^(10\.\d{4,9})\//);
  return m ? m[1] : '(non-standard)';
}

function yearBucket(y) {
  if (y == null) return 'null-year';
  if (y < 1990) return '<1990';
  if (y < 2000) return '1990-1999';
  if (y < 2010) return '2000-2009';
  if (y < 2020) return '2010-2019';
  return '2020+';
}

async function main() {
  console.log('Loading null-abstract canonical non-noise papers (id, canonical_doi, year, venue)...');
  const prefixCounts = {};
  const prefixWithDoi = {};
  const yearCounts = {};
  const venueCounts = {};
  let total = 0, withDoi = 0, arxivLike = 0;

  let cursor = null;
  while (true) {
    let q = sb.from('works')
      .select('id, canonical_doi, year, venue')
      .is('abstract', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .order('id')
      .range(0, 999); // PostgREST caps at 1000 rows/page
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    const pageSize = data.length;
    for (const r of data) {
      total++;
      const doi = r.canonical_doi;
      if (doi) withDoi++;
      const pfx = prefixOf(doi);
      prefixCounts[pfx] = (prefixCounts[pfx] || 0) + 1;
      yearCounts[yearBucket(r.year)] = (yearCounts[yearBucket(r.year)] || 0) + 1;
      const v = (r.venue || '(no venue)').slice(0, 80);
      venueCounts[v] = (venueCounts[v] || 0) + 1;
      // arXiv detection: id or doi
      if (/arxiv/i.test(String(r.id)) || /10\.48550/.test(String(doi))) arxivLike++;
    }
    cursor = data[data.length - 1].id;
    process.stdout.write(`\r  scanned ${total}`);
    if (pageSize < 1000) break;
  }
  process.stdout.write('\n');

  const topPrefixes = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([p, c]) => ({ prefix: p, label: PREFIX_LABELS[p] || '', count: c }));
  const topVenues = Object.entries(venueCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([v, c]) => ({ venue: v, count: c }));
  const yearTable = Object.entries(yearCounts).sort((a, b) => a[0].localeCompare(b[0]));

  const report = {
    generatedAt: new Date().toISOString(),
    total,
    withDoi,
    withoutDoi: total - withDoi,
    arxivLike,
    byDoiPrefix: topPrefixes,
    byYearBucket: Object.fromEntries(yearTable),
    topVenues,
  };

  console.log('\n=== Null-abstract inventory ===');
  console.log(`Total: ${total} | with DOI: ${withDoi} | without DOI: ${total - withDoi}`);
  console.log('\nBy DOI prefix (top 25):');
  for (const p of topPrefixes) console.log(`  ${p.prefix.padEnd(14)} ${String(p.count).padStart(7)}  ${p.label}`);
  console.log('\nBy year bucket:');
  for (const [b, c] of yearTable) console.log(`  ${b.padEnd(12)} ${String(c).padStart(7)}`);
  console.log('\nTop venues (top 30):');
  for (const v of topVenues) console.log(`  ${String(v.count).padStart(6)}  ${v.venue}`);

  fs.mkdirSync('reports', { recursive: true });
  const path = `reports/null-abstract-inventory-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
