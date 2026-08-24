#!/usr/bin/env node
/**
 * Citation count refresh via OpenAlex.
 * Targets canonical non-noise papers where citation_count IS NULL and id LIKE '10.%'.
 * Also refreshes papers where last_updated_at is old (if that column exists) — but
 * for now just fills nulls since there are only ~3,228 of them.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-citations-openalex.mjs [--dry-run] [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();

const BATCH = 50;
const SLEEP_MS = 110;
const MAILTO = process.env.OPENALEX_MAILTO || 'horizon-scanner@iadb.org';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOA(dois) {
  const filter = `doi:${dois.map(d => d.toLowerCase()).join('|')}`;
  const params = new URLSearchParams({ filter, 'per-page': '50', select: 'doi,cited_by_count', mailto: MAILTO });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep(3000 * attempt); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      return json.results ?? [];
    } catch { await sleep(1500); }
  }
  return [];
}

async function main() {
  console.log(`\n=== Citation count backfill (OpenAlex) ===`);
  console.log(`Dry run: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  // Load all null-citation papers with DOIs
  const rows = [];
  let from = 0;
  while (rows.length < LIMIT) {
    const { data, error } = await sb.from('works')
      .select('id')
      .is('citation_count', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .like('id', '10.%')
      .order('id')
      .range(from, from + 999);
    if (error || !data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const targets = rows.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} papers with null citation_count`);
  if (DRY_RUN || targets.length === 0) return;

  let updated = 0, notFound = 0, errors = 0;
  const start = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const t0 = Date.now();
    const results = await fetchOA(batch.map(r => r.id));

    const byDoi = new Map();
    for (const r of results) {
      const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
      if (doi) byDoi.set(doi, r);
    }

    for (const row of batch) {
      const oa = byDoi.get(row.id.toLowerCase());
      if (!oa || oa.cited_by_count == null) { notFound++; continue; }
      const { error } = await sb.from('works').update({ citation_count: oa.cited_by_count }).eq('id', row.id);
      if (error) errors++;
      else updated++;
    }

    const rate = ((i + batch.length) / Math.max(1, (Date.now() - start) / 1000)).toFixed(1);
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} | updated ${updated} | not_found ${notFound} | err ${errors} | ${rate}/s`);

    const rem = SLEEP_MS - (Date.now() - t0);
    if (rem > 0) await sleep(rem);
  }

  process.stdout.write('\n');
  const summary = { updated, notFound, errors, total: targets.length, elapsed_s: Math.round((Date.now() - start) / 1000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(`reports/backfill-citations-openalex-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ summary }, null, 2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
