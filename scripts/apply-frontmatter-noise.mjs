#!/usr/bin/env node
/**
 * Flag confirmed journal APPARATUS (front matter, back matter, editorial board,
 * table of contents, issue information, masthead) as noise.
 *
 * Source list: reports/frontmatter-noise-2026-06-09.json (apparatus_ids + uncertain[]),
 * derived from empty-author + DOI + non-noise rows whose title contains an apparatus
 * phrase. Every candidate was verified to have NO topical residual (manual eyeball of
 * all 208 distinct "uncertain" titles: all are Econometrica front/back matter, Oxford
 * Economic Papers editorial board, or editorial announcements — zero research papers).
 *
 * Per-row APPLY-TIME safety net (defensive, in case the DB changed since the report):
 *   - re-fetch the row
 *   - require authors is still empty ([])
 *   - require title still matches the apparatus regex
 *   - require citation_count <= 3 (apparatus is uncited)
 * Any row failing a guard is SKIPPED and logged.
 *
 * For each surviving row (mirrors scripts/apply-clearcut-denylist.mjs):
 *   1. INSERT INTO corpus_denylist (work_id, reason) ON CONFLICT DO NOTHING
 *   2. UPDATE works SET is_noise=true, embedding=NULL   -> excludes from match_works/_v2 + vector search
 *
 * Usage:
 *   node --env-file=.env scripts/apply-frontmatter-noise.mjs --dry-run
 *   node --env-file=.env scripts/apply-frontmatter-noise.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const APPLY = process.argv.includes('--apply');
const REASON = 'is_noise: journal apparatus (front/back matter, editorial board, ToC)';
const APPARATUS_RE = /front\s*matter|frontmatter|back\s*matter|backmatter|editorial board|table of contents|issue information|masthead/i;

const report = JSON.parse(fs.readFileSync('reports/frontmatter-noise-2026-06-09.json', 'utf8'));
const ids = [...new Set([...(report.apparatus_ids || []), ...((report.uncertain || []).map(u => u.id))])];
console.log(`\n=== Flag journal apparatus as noise ===`);
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Candidate ids from report: ${ids.length}\n`);

// Re-fetch + guard, in id batches
const survivors = [];
const skipped = [];
const CHUNK = 50;
for (let i = 0; i < ids.length; i += CHUNK) {
  const batch = ids.slice(i, i + CHUNK);
  const inList = batch.map(id => `"${id.replace(/"/g, '')}"`).join(',');
  const { data, error } = await sb.from('works')
    .select('id, title, authors, citation_count, is_noise')
    .in('id', batch);
  if (error) { console.error('fetch batch error:', error.message); continue; }
  for (const r of (data || [])) {
    if (r.is_noise === true) { skipped.push([r.id, 'already noise']); continue; }
    const authorsEmpty = !r.authors || (Array.isArray(r.authors) && r.authors.length === 0) || r.authors === '[]';
    if (!authorsEmpty) { skipped.push([r.id, 'has authors: ' + JSON.stringify(r.authors).slice(0, 60)]); continue; }
    if (!APPARATUS_RE.test(r.title || '')) { skipped.push([r.id, 'title no longer apparatus: ' + r.title]); continue; }
    if ((r.citation_count || 0) > 3) { skipped.push([r.id, 'cites>3: ' + r.citation_count + ' ' + r.title]); continue; }
    survivors.push(r);
  }
}

console.log(`Survivors (will flag): ${survivors.length}`);
console.log(`Skipped by guard: ${skipped.length}`);
if (skipped.length) skipped.slice(0, 20).forEach(([id, why]) => console.log(`  SKIP ${id} — ${why}`));
console.log(`\nSample survivors:`);
survivors.slice(0, 15).forEach(r => console.log(`  ${r.id} | cites=${r.citation_count} | ${(r.title || '').slice(0, 70)}`));

const out = {
  generated_at: new Date().toISOString(), apply: APPLY,
  candidates: ids.length, survivors: survivors.length, skipped: skipped.length,
  skipped_detail: skipped, survivor_ids: survivors.map(r => r.id),
};

if (!APPLY) {
  fs.writeFileSync('reports/frontmatter-noise-apply-2026-06-09.json', JSON.stringify(out, null, 2));
  console.log(`\nDry run. Wrote reports/frontmatter-noise-apply-2026-06-09.json`);
  process.exit(0);
}

let denylisted = 0, flagged = 0, errs = 0;
for (const r of survivors) {
  const { error: e1 } = await sb.from('corpus_denylist')
    .upsert({ work_id: r.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
  if (e1) { console.error('denylist insert', r.id, e1.message); errs++; }
  else denylisted++;
  const { error: e2 } = await sb.from('works')
    .update({ is_noise: true, embedding: null }).eq('id', r.id);
  if (e2) { console.error('works update', r.id, e2.message); errs++; }
  else flagged++;
  if (flagged % 200 === 0) console.log(`  ...flagged ${flagged}/${survivors.length}`);
}
out.result = { denylisted, flagged, errors: errs };
fs.writeFileSync('reports/frontmatter-noise-apply-2026-06-09.json', JSON.stringify(out, null, 2));
console.log(`\nApplied: denylisted=${denylisted} works_flagged=${flagged} errors=${errs}`);
