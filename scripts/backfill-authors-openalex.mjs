#!/usr/bin/env node
/**
 * Author backfill via OpenAlex (batch DOI lookup).
 *
 * Targets canonical non-noise papers where authors = [] (empty) and id LIKE '10.%'.
 * OpenAlex indexes grey-lit / working-paper / institutional DOIs that Crossref 404s,
 * so it resolves authors for the real-paper subset of the empty-author gap. Apparatus
 * rows (Book Notes, Referees, Announcements...) legitimately return no authorships and
 * are simply skipped — never written.
 *
 * GOLDEN RULE: gap-only. Only writes authors on rows where it is currently empty.
 * Never overwrites a populated authors array. Never touches any other column.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-authors-openalex.mjs --dry-run [--limit N]
 *   node --env-file=.env scripts/backfill-authors-openalex.mjs [--limit N]
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchOA(dois) {
  const filter = `doi:${dois.map(d => d.toLowerCase()).join('|')}`;
  const params = new URLSearchParams({ filter, 'per-page': '50', select: 'doi,authorships', mailto: MAILTO });
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

function authorsOf(oa) {
  const names = (oa?.authorships ?? [])
    .map(a => a?.author?.display_name)
    .filter(Boolean)
    .map(s => String(s).trim());
  return names.length ? names : null;
}

async function main() {
  console.log(`\n=== Author backfill (OpenAlex) ===`);
  console.log(`Dry run: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  // Load all empty-author papers with DOIs (gap-only set)
  const rows = [];
  let from = 0;
  while (rows.length < LIMIT) {
    const { data, error } = await sb.from('works')
      .select('id')
      .filter('authors', 'eq', '[]')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .like('id', '10.%')
      .order('id')
      .range(from, from + 999);
    if (error) { console.error('fetch error:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const targets = rows.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} papers with empty authors + DOI`);
  if (targets.length === 0) return;

  let updated = 0, noAuthors = 0, errors = 0;
  const start = Date.now();

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await fetchOA(batch.map(r => r.id));

    const byDoi = new Map();
    for (const r of results) {
      const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
      if (doi) byDoi.set(doi, r);
    }

    for (const row of batch) {
      const oa = byDoi.get(row.id.toLowerCase());
      const authors = authorsOf(oa);
      if (!authors) { noAuthors++; continue; }
      if (DRY_RUN) {
        if (updated < 25) console.log(`  [dry] ${row.id} -> ${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''}`);
        updated++;
        continue;
      }
      const { error } = await sb.from('works').update({ authors: JSON.stringify(authors) }).eq('id', row.id);
      if (error) { console.error(`update ${row.id}:`, error.message); errors++; continue; }
      updated++;
      if (updated % 200 === 0) {
        const rate = updated / ((Date.now() - start) / 1000);
        console.log(`  updated=${updated} noAuthors=${noAuthors} errors=${errors} (${rate.toFixed(1)}/s)`);
      }
    }
    await sleep(SLEEP_MS);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    targets: targets.length,
    updated, no_authors_in_oa: noAuthors, errors,
    elapsed_min: ((Date.now() - start) / 60000).toFixed(1),
  };
  console.log(`\n=== Done ===\n${JSON.stringify(summary, null, 2)}`);
  if (!DRY_RUN) {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/authors-openalex-2026-06-22.json', JSON.stringify(summary, null, 2));
  }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
