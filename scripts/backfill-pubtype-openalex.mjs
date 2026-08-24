#!/usr/bin/env node
/**
 * GAP-ONLY publication_type backfill via OpenAlex `type` field.
 * Also opportunistically fills null abstract + monotonically-increases citation_count
 * in the same HTTP round-trip (free — OA returns all three).
 *
 * 🔒 GOLDEN RULE: only writes a field when the existing DB value is null/empty.
 *   - publication_type: written ONLY when row.publication_type IS NULL
 *   - abstract:         written ONLY when row.abstract IS NULL and OA has one
 *   - citation_count:   written ONLY when null OR strictly greater (never lowers)
 * Never overwrites a populated value with a null/placeholder.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-pubtype-openalex.mjs --dry-run --limit 200
 *   node --env-file=.env scripts/backfill-pubtype-openalex.mjs --limit 200
 *   # Full off-peak sweep (run as nohup on VPS, NOT from laptop):
 *   node --env-file=.env scripts/backfill-pubtype-openalex.mjs
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

// OpenAlex `type` (Crossref-aligned) → our publication_type vocabulary.
// Accepted DB values (CHECK-verified 2026-06-03): journal_article, book_review,
// conference_paper, discussion_paper, working_paper, book, book_chapter, report,
// preprint, dataset, other, dissertation. ('review'/'proceedings' are NOT accepted.)
function mapOaType(t) {
  if (!t) return null;
  const m = String(t).toLowerCase();
  if (m === 'article' || m === 'journal-article') return 'journal_article';
  if (m === 'book-chapter') return 'book_chapter';
  if (m === 'book' || m === 'monograph' || m === 'reference-book') return 'book';
  if (m === 'dissertation' || m === 'thesis') return 'dissertation';
  if (m === 'report') return 'report';
  if (m === 'posted-content' || m === 'preprint') return 'preprint';
  if (m === 'proceedings-article' || m === 'proceedings') return 'conference_paper';
  if (m === 'dataset') return 'dataset';
  if (m === 'review') return 'journal_article';
  if (m === 'editorial' || m === 'letter' || m === 'erratum' || m === 'paratext' || m === 'other') return 'other';
  return 'other';
}

function reconstructAbstract(idx) {
  if (!idx || typeof idx !== 'object') return null;
  const positions = Object.values(idx).flat();
  if (!positions.length) return null;
  const words = Array(Math.max(...positions) + 1).fill('');
  for (const [w, ps] of Object.entries(idx)) for (const p of ps) words[p] = w;
  return words.join(' ').trim() || null;
}

async function fetchOA(dois) {
  const filter = `doi:${dois.map(d => d.toLowerCase()).join('|')}`;
  const params = new URLSearchParams({ filter, 'per-page': '50',
    select: 'doi,type,abstract_inverted_index,cited_by_count', mailto: MAILTO });
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep(3000 * a); continue; }
      if (!res.ok) return [];
      return (await res.json()).results ?? [];
    } catch { await sleep(1500); }
  }
  return [];
}

async function main() {
  console.log(`\n=== publication_type backfill (OpenAlex type) — GAP-ONLY ===`);
  console.log(`Dry run: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  // Targets: canonical non-noise, null publication_type, with DOI.
  const rows = [];
  let from = 0;
  while (rows.length < LIMIT) {
    const { data, error } = await sb.from('works')
      .select('id, abstract, citation_count, publication_type')
      .is('publication_type', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .like('id', '10.%')
      .order('id')
      .range(from, from + 999);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const targets = rows.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} rows with null publication_type (with DOI)\n`);
  if (DRY_RUN || !targets.length) { console.log('Dry run / nothing to do.'); return; }

  let pt = 0, abs = 0, cite = 0, notFound = 0, errors = 0;
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
      if (!oa) { notFound++; continue; }
      const patch = {};
      // publication_type: GAP-ONLY (target already filtered to null, double-guard here)
      const mapped = mapOaType(oa.type);
      if (mapped && (row.publication_type === null || row.publication_type === undefined)) patch.publication_type = mapped;
      // abstract: GAP-ONLY
      if (row.abstract == null) {
        const a = reconstructAbstract(oa.abstract_inverted_index);
        if (a) patch.abstract = a;
      }
      // citation_count: null OR strictly greater (monotonic, never lowers)
      if (oa.cited_by_count != null && Number.isFinite(oa.cited_by_count)
          && (row.citation_count == null || oa.cited_by_count > row.citation_count)) {
        patch.citation_count = oa.cited_by_count;
      }
      if (!Object.keys(patch).length) continue;
      const { error } = await sb.from('works').update(patch).eq('id', row.id);
      if (error) { errors++; continue; }
      if (patch.publication_type !== undefined) pt++;
      if (patch.abstract !== undefined) abs++;
      if (patch.citation_count !== undefined) cite++;
    }

    const rate = ((i + batch.length) / Math.max(1, (Date.now() - start) / 1000)).toFixed(1);
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length} | pubtype ${pt} | abstracts ${abs} | cites ${cite} | not_in_OA ${notFound} | err ${errors} | ${rate}/s`);
    const rem = SLEEP_MS - (Date.now() - t0);
    if (rem > 0) await sleep(rem);
  }

  process.stdout.write('\n');
  const summary = { pubtype_filled: pt, abstracts_filled: abs, cites_updated: cite, not_in_oa: notFound, errors, targets: targets.length, elapsed_s: Math.round((Date.now() - start) / 1000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(`reports/backfill-pubtype-openalex-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ summary, dry_run: DRY_RUN }, null, 2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
