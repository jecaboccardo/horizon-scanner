#!/usr/bin/env node
/**
 * Apply the CLEAR-CUT denylist ONLY: IEEE (10.1109/*), ACM (10.1145/*),
 * CHOICE reviews (10.5860/choice.*) that are not yet is_noise=true.
 * These DOI prefixes are definitionally engineering/computing/library-review
 * noise (the bulk are already denylisted; this catches stragglers).
 *
 * Does NOT touch bioRxiv (10.1101/*), MDPI (10.3390/*), JAMA (10.1001/*),
 * PNAS biomedical, or title-keyword seeds — all mixed, left for review.
 *
 * For each matched row:
 *   1. INSERT INTO corpus_denylist (work_id, reason)
 *   2. UPDATE works SET is_noise=true, embedding=NULL
 *
 * Usage:
 *   node --env-file=.env scripts/apply-clearcut-denylist.mjs --dry-run
 *   node --env-file=.env scripts/apply-clearcut-denylist.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const APPLY = process.argv.includes('--apply');
const PREFIXES = [
  ['10.1109/%', 'is_noise: IEEE engineering (DOI prefix)'],
  ['10.1145/%', 'is_noise: ACM computing (DOI prefix)'],
  ['10.5860/choice.%', 'is_noise: CHOICE library review (DOI prefix)'],
];

const targets = [];
for (const [pfx, reason] of PREFIXES) {
  const { data, error } = await sb.from('works')
    .select('id, title, venue, citation_count')
    .is('canonical_work_id', null).not('is_noise', 'is', true).like('id', pfx);
  if (error) { console.error(pfx, error.message); continue; }
  for (const r of (data || [])) targets.push({ ...r, reason, prefix: pfx });
}

console.log(`\n=== Clear-cut denylist: IEEE / ACM / CHOICE stragglers ===`);
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Matched ${targets.length} rows:\n`);
for (const t of targets) console.log(`  ${t.id} | cites=${t.citation_count} | ${t.title?.slice(0, 70)}`);

const report = { generated_at: new Date().toISOString(), apply: APPLY, count: targets.length,
  rows: targets, sql_preview: targets.map(t =>
    `INSERT INTO corpus_denylist (work_id, reason) VALUES ('${t.id}', '${t.reason}') ON CONFLICT DO NOTHING; UPDATE works SET is_noise=true, embedding=NULL WHERE id='${t.id}';`) };

if (!APPLY) {
  fs.writeFileSync('reports/clearcut-denylist-2026-06-03.json', JSON.stringify(report, null, 2));
  console.log(`\nDry run. SQL preview written to reports/clearcut-denylist-2026-06-03.json`);
  process.exit(0);
}

let denylisted = 0, flagged = 0, errs = 0;
for (const t of targets) {
  const { error: e1 } = await sb.from('corpus_denylist')
    .upsert({ work_id: t.id, reason: t.reason }, { onConflict: 'work_id', ignoreDuplicates: true });
  if (e1) { console.error('denylist insert', t.id, e1.message); errs++; }
  else denylisted++;
  const { error: e2 } = await sb.from('works')
    .update({ is_noise: true, embedding: null }).eq('id', t.id);
  if (e2) { console.error('works update', t.id, e2.message); errs++; }
  else flagged++;
}
report.result = { denylisted, flagged, errors: errs };
fs.writeFileSync('reports/clearcut-denylist-2026-06-03.json', JSON.stringify(report, null, 2));
console.log(`\nApplied: denylisted=${denylisted} works_flagged=${flagged} errors=${errs}`);
