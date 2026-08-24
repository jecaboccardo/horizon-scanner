#!/usr/bin/env node
/**
 * Retroactive abstract PROVENANCE sweep — no network fetches, no new text.
 *
 * WHY: the abstract backfill scripts record where an abstract came from under
 * `raw_data.abstract_backfill.source`, but the JEL evidence-table export reads the
 * FLAT `raw_data.abstract_source` to decide its `unverified` provenance flag
 * (jelPaperPipeline.ts → UNVERIFIED_ABSTRACT_SOURCES). Different keys, so tens of
 * thousands of genuinely RETRIEVED abstracts shipped indistinguishable from untagged
 * legacy text — the gap Sebastian's 2026-07 review surfaced as "an untagged mix of
 * retrieved and generated text". This copies the provenance that is ALREADY on the
 * row into the key the reader looks at.
 *
 * GOLDEN RULE (CLAUDE.md): this NEVER invents provenance and never touches abstract
 * text. It only promotes an existing recorded source value. Rows are skipped when:
 *   - `abstract` IS NULL — stamping a source onto a missing/quarantined abstract
 *     would assert something untrue (4,349 such rows as of 2026-08-23).
 *   - `abstract_source` is ALREADY set — never clobbers, incl. the
 *     'recall_quarantined' markers from the 2026-07-15 fabricated-abstract incident.
 *     Both are enforced again as DB-level guards on the UPDATE itself.
 *
 * SELF-DRAINING QUEUE: a stamped row stops matching the filter, so this always
 * re-reads the FIRST page rather than paging by offset (which would drift as rows
 * drop out). Interrupt and re-run at will — it is idempotent and resumable with no
 * sidecar state.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstract-source-provenance.mjs --dry-run --limit 50
 *   node --env-file=.env scripts/backfill-abstract-source-provenance.mjs --limit 1000
 *   node --env-file=.env scripts/backfill-abstract-source-provenance.mjs            # full sweep
 *   node --env-file=.env scripts/backfill-abstract-source-provenance.mjs --bulk-ingest --dry-run
 *   Flags: --dry-run  --limit N  --concurrency N (default 8)  --bulk-ingest (tier 3)
 *
 * TIER 3 (--bulk-ingest) is a per-row UPDATE over ~385k rows via PostgREST, so it runs
 * for hours. The same result is one SQL statement if you have psql on the DB host:
 *   UPDATE works SET raw_data = jsonb_set(coalesce(raw_data,'{}'::jsonb),
 *     '{abstract_source}', to_jsonb('bulk_ingest:' || source))
 *   WHERE abstract IS NOT NULL AND raw_data->>'abstract_source' IS NULL
 *     AND raw_data->'abstract_backfill' IS NULL AND is_noise = false AND source IS NOT NULL;
 * This script is idempotent, so running the SQL first just leaves it nothing to do.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY_RUN = args.includes('--dry-run');
// TIER 3 (--bulk-ingest): rows with NO provenance record anywhere — the original bulk
// harvest. Their provenance is knowable but lives in the `works.source` column rather
// than raw_data, so it is stamped as `bulk_ingest:<source>`: deliberately distinct from
// a per-row attested fetch (plain 'openalex') so the two can never be conflated again.
// Only ever applied to rows with no abstract_backfill block, so tier 1 and tier 3 are
// disjoint and neither can overwrite the other.
const BULK = args.includes('--bulk-ingest');
const LIMIT = parseInt(flag('--limit', '0'), 10) || Infinity;
const CONCURRENCY = Math.max(1, Math.min(16, parseInt(flag('--concurrency', '8'), 10) || 8));
const PAGE = 1000; // PostgREST hard-caps result sets at 1000 rows

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Rows with an abstract, no flat abstract_source, and provenance available for this mode. */
function pendingPage() {
  const q = sb.from('works')
    .select('id, raw_data, source')
    .is('raw_data->>abstract_source', null)
    .not('abstract', 'is', null)
    .limit(PAGE);
  return BULK
    // Tier 3: no per-row backfill record; fall back to the ingest channel. Skip noise —
    // denylisted rows are not part of the evidence surface worth attesting.
    ? q.is('raw_data->abstract_backfill', null).eq('is_noise', false)
    : q.not('raw_data->abstract_backfill', 'is', null);
}

async function stampOne(row) {
  const raw = (row.raw_data == null || Array.isArray(row.raw_data) || typeof row.raw_data !== 'object')
    ? null
    : row.raw_data;
  const src = BULK
    ? (row.source ? `bulk_ingest:${row.source}` : null)
    : raw?.abstract_backfill?.source;
  // No recorded source to promote — nothing truthful to stamp, leave it alone.
  if (!src || typeof src !== 'string') return { status: 'no_source' };
  if (DRY_RUN) return { status: 'would_stamp', src };

  const { error } = await sb.from('works')
    .update({ raw_data: { ...raw, abstract_source: src } })
    .eq('id', row.id)
    // Re-assert both guards at the DB so a concurrent writer can't be clobbered.
    .is('raw_data->>abstract_source', null)
    .not('abstract', 'is', null);
  if (error) return { status: 'error', reason: error.message };
  return { status: 'stamped', src };
}

async function main() {
  const modeLabel = BULK
    ? 'TIER 3: works.source -> abstract_source (bulk_ingest:*)'
    : 'TIER 1: abstract_backfill.source -> abstract_source';
  console.log(`\n=== Abstract provenance sweep — ${modeLabel} ===`);
  console.log(`dry-run: ${DRY_RUN} | limit: ${LIMIT === Infinity ? 'none' : LIMIT} | concurrency: ${CONCURRENCY}\n`);

  const bySource = new Map();
  let stamped = 0, noSource = 0, errors = 0, seen = 0;
  const stuck = new Set(); // ids that matched but could not be stamped — prevents an infinite queue
  const t0 = Date.now();

  while (stamped + noSource < LIMIT) {
    const { data, error } = await pendingPage();
    if (error) { console.error('\nquery failed:', error.message); break; }
    if (!data?.length) break;

    const batch = data.filter((r) => !stuck.has(r.id));
    if (!batch.length) break; // every remaining match is unstampable — done

    for (let i = 0; i < batch.length && stamped + noSource < LIMIT; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map(stampOne));
      results.forEach((res, j) => {
        seen++;
        if (res.status === 'stamped' || res.status === 'would_stamp') {
          stamped++;
          bySource.set(res.src, (bySource.get(res.src) || 0) + 1);
          if (DRY_RUN) stuck.add(slice[j].id); // dry-run doesn't mutate; don't re-read forever
        } else if (res.status === 'no_source') {
          noSource++; stuck.add(slice[j].id);
        } else {
          errors++; stuck.add(slice[j].id);
          if (errors <= 5) console.error(`\n  ${slice[j].id}: ${res.reason}`);
        }
      });
      const rate = (seen / ((Date.now() - t0) / 1000)).toFixed(1);
      process.stdout.write(`\r  ${seen} seen | stamped ${stamped} | no-source ${noSource} | err ${errors} | ${rate}/s   `);
    }
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n\n=== ${DRY_RUN ? 'Dry run' : 'Done'} ===`);
  console.log(`Stamped:   ${stamped}${DRY_RUN ? ' (would be)' : ''}`);
  console.log(`No source: ${noSource}`);
  console.log(`Errors:    ${errors}`);
  console.log(`Elapsed:   ${secs}s`);
  if (bySource.size) {
    console.log('\nBy source:');
    [...bySource.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([s, n]) => console.log(`  ${String(s).padEnd(24)} ${n}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
