#!/usr/bin/env node
/**
 * Clear `raw_data.sms_stale` on rows that have genuinely been re-graded.
 *
 * WHY: `sms_stale=true` marks a paper whose SMS level was computed from abstract text
 * later found to be fabricated (2026-07-15 recalled-abstracts incident). Those rows are
 * still serving that stale grade. `classify-sms-qwen.mjs` fixes the grade — it upserts
 * sms_level/methodology_design/causal_strength/sms_method/sms_rationale — but it does
 * NOT touch raw_data, so the stale flag survives a successful re-grade. Without this
 * pass the flag never clears, and "how many bad grades are left" stays unanswerable.
 *
 * SAFETY: a row is only cleared when it carries POSITIVE evidence of a fresh re-grade:
 *   - sms_method = 'qwen_llm'  (the classifier wrote it), AND
 *   - updated_at >= --since    (written by THIS remediation run, not a stale prior one), AND
 *   - sms_rationale does not start with '[REVIEW]' (the classifier's own
 *     low-confidence / no-abstract marker — those still need a human, so the flag stays).
 * Anything failing those checks keeps sms_stale=true. The flag is deleted, not set false,
 * so a cleared row is indistinguishable from one that was never stale.
 *
 * Usage:
 *   node --env-file=.env scripts/clear-sms-stale-flag.mjs --since 2026-08-23T00:00:00Z --dry-run
 *   node --env-file=.env scripts/clear-sms-stale-flag.mjs --since 2026-08-23T00:00:00Z
 *   Flags: --since <ISO> (REQUIRED)  --ids-file <json>  --dry-run  --limit N  --concurrency N
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';

config();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY_RUN = args.includes('--dry-run');
const SINCE = flag('--since', null);
const IDS_FILE = flag('--ids-file', null);
const LIMIT = parseInt(flag('--limit', '0'), 10) || Infinity;
const CONCURRENCY = Math.max(1, Math.min(16, parseInt(flag('--concurrency', '8'), 10) || 8));
const PAGE = 1000;

if (!SINCE || Number.isNaN(Date.parse(SINCE))) {
  console.error('--since <ISO timestamp> is required (the start of the re-grade run).');
  console.error('Without it this could clear flags on rows graded long before the fix.');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Optional allowlist — restricts the pass to the exact ids that were re-graded. */
function loadIds(path) {
  if (!path) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
  return new Set(rows.map((r) => String(r?.id || '').trim()).filter(Boolean));
}

/** Still-flagged rows that now look re-graded. Self-draining: cleared rows stop matching. */
function pendingPage() {
  return sb.from('works')
    .select('id, raw_data, sms_level, sms_method, sms_rationale, updated_at')
    .eq('raw_data->>sms_stale', 'true')
    .eq('sms_method', 'qwen_llm')
    .gte('updated_at', SINCE)
    .limit(PAGE);
}

async function clearOne(row) {
  const raw = (row.raw_data == null || Array.isArray(row.raw_data) || typeof row.raw_data !== 'object')
    ? null
    : row.raw_data;
  if (!raw) return { status: 'skip', reason: 'no raw_data object' };
  // The classifier flags its own uncertain calls with a [REVIEW] prefix — a re-grade that
  // it doesn't trust is not a fix, so leave the stale marker in place for a human.
  if (String(row.sms_rationale || '').startsWith('[REVIEW]')) return { status: 'skip', reason: 'review-flagged' };
  if (DRY_RUN) return { status: 'would_clear' };

  const next = { ...raw };
  delete next.sms_stale;
  const { error } = await sb.from('works')
    .update({ raw_data: next })
    .eq('id', row.id)
    .eq('raw_data->>sms_stale', 'true')   // re-assert at the DB
    .eq('sms_method', 'qwen_llm')
    .gte('updated_at', SINCE);
  if (error) return { status: 'error', reason: error.message };
  return { status: 'cleared' };
}

async function main() {
  const allow = loadIds(IDS_FILE);
  console.log(`\n=== Clear sms_stale on re-graded rows ===`);
  console.log(`since: ${SINCE} | dry-run: ${DRY_RUN} | ids-file: ${IDS_FILE || 'none'}${allow ? ` (${allow.size} ids)` : ''} | concurrency: ${CONCURRENCY}\n`);

  let cleared = 0, skipped = 0, errors = 0, seen = 0;
  const stuck = new Set();
  const t0 = Date.now();

  while (cleared + skipped < LIMIT) {
    const { data, error } = await pendingPage();
    if (error) { console.error('\nquery failed:', error.message); break; }
    if (!data?.length) break;

    const batch = data.filter((r) => !stuck.has(r.id) && (!allow || allow.has(r.id)));
    if (!batch.length) {
      // Nothing actionable on this page. With an allowlist the remaining matches are
      // simply out of scope, so stop rather than spin on the same page forever.
      if (data.every((r) => stuck.has(r.id) || (allow && !allow.has(r.id)))) break;
      continue;
    }

    for (let i = 0; i < batch.length && cleared + skipped < LIMIT; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map(clearOne));
      results.forEach((res, j) => {
        seen++;
        if (res.status === 'cleared' || res.status === 'would_clear') {
          cleared++;
          if (DRY_RUN) stuck.add(slice[j].id);
        } else if (res.status === 'skip') {
          skipped++; stuck.add(slice[j].id);
        } else {
          errors++; stuck.add(slice[j].id);
          if (errors <= 5) console.error(`\n  ${slice[j].id}: ${res.reason}`);
        }
      });
      process.stdout.write(`\r  ${seen} seen | cleared ${cleared} | skipped ${skipped} | err ${errors}   `);
    }
  }

  console.log(`\n\n=== ${DRY_RUN ? 'Dry run' : 'Done'} ===`);
  console.log(`Cleared: ${cleared}${DRY_RUN ? ' (would be)' : ''}`);
  console.log(`Skipped: ${skipped}  (kept sms_stale — review-flagged or unparseable raw_data)`);
  console.log(`Errors:  ${errors}`);
  console.log(`Elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
