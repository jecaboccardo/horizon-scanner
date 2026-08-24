#!/usr/bin/env node
/**
 * apply-health-econ-apparatus-denylist.mjs — DESTRUCTIVE (flags is_noise, nulls
 * embedding, inserts corpus_denylist). DOI-LIST variant of apply-clinical-denylist.mjs.
 *
 * PART A of the 2026-06-17 journal-apparatus noise task. The user reviewed a
 * spreadsheet of Wiley *Health Economics* (10.1002/hec.* + legacy SICI
 * 10.1002/...1099-1050... DOIs) and marked 134 rows Noise="y" — all journal
 * APPARATUS: distinguished-author awards, in-remembrance / in-memoriam, retractions,
 * co-editor appointments, announcements, workshop/symposium notices, editors'/guest
 * introductions, replies/responses, and book reviews. NONE are research.
 *
 * Match is by EXACT canonical_doi against the reviewed list (D:/tmp/health-econ-noise-dois.json).
 *
 * Hard rules (mirror apply-clinical-denylist.mjs):
 *  - GOLDEN RULE: only mutations per row are is_noise=true, noise_reason,
 *    embedding=null (the active qwen-768 col; NOT embedding_nomic_old), and a
 *    corpus_denylist upsert {work_id, reason}. Nothing else touched.
 *  - Only canonical (canonical_work_id IS NULL) AND non-noise (is_noise IS NOT TRUE).
 *  - Apply-time re-check: re-fetch each row, re-verify canonical / non-noise /
 *    DOI-still-in-list immediately before the write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-health-econ-apparatus-denylist.mjs --dry-run
 *   node --env-file=.env scripts/apply-health-econ-apparatus-denylist.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'journal_apparatus_2026_06_17';
const LIST_PATH = 'D:/tmp/health-econ-noise-dois.json';

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

(async () => {
  console.log(`=== HEALTH-ECON APPARATUS DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===\n`);

  const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
  // exact-match set, lowercased for case-insensitive compare
  const wantSet = new Set(list.map(x => (x.doi || '').toLowerCase()).filter(Boolean));
  console.log(`Reviewed list: ${list.length} entries, ${wantSet.size} distinct DOIs\n`);

  // Fetch candidate rows by exact canonical_doi (batched .in() over the list).
  const dois = list.map(x => x.doi).filter(Boolean);
  const found = [];
  const foundDois = new Set();
  for (const batch of chunk(dois, 150)) {
    const { data, error } = await sb.from('works')
      .select('id,title,venue,citation_count,year,authors,abstract,canonical_doi,is_noise,canonical_work_id')
      .in('canonical_doi', batch);
    if (error) { console.error('  ERR', error.message); process.exit(1); }
    for (const r of (data || [])) found.push(r);
  }

  const flagged = [];
  const skipped = { not_canonical: [], already_noise: [] };
  for (const r of found) {
    foundDois.add((r.canonical_doi || '').toLowerCase());
    if (r.canonical_work_id != null) { skipped.not_canonical.push(r); continue; }
    if (r.is_noise === true) { skipped.already_noise.push(r); continue; }
    flagged.push(r);
  }

  const notFound = dois.filter(d => !foundDois.has(d.toLowerCase()));

  console.log(`=== MATCH SUMMARY ===`);
  console.log(`  list DOIs:            ${dois.length}`);
  console.log(`  rows found in works:  ${found.length}`);
  console.log(`  flaggable:            ${flagged.length}`);
  console.log(`  skipped not-canonical:${skipped.not_canonical.length}`);
  console.log(`  skipped already-noise:${skipped.already_noise.length}`);
  console.log(`  DOIs not found:       ${notFound.length}`);
  if (notFound.length) console.log(`    ${notFound.join('\n    ')}`);

  // 20-row title sample
  console.log(`\n=== 20-ROW TITLE SAMPLE (flaggable) ===`);
  for (const r of flagged.slice(0, 20)) {
    console.log(`  [cit ${r.citation_count ?? '—'}] [${r.year ?? '—'}] ${(r.venue || '').slice(0, 22).padEnd(22)} | ${(r.title || '').slice(0, 70)}`);
    console.log(`        DOI: ${r.canonical_doi} | authors: ${Array.isArray(r.authors) ? r.authors.length : 0} | abstract: ${r.abstract ? r.abstract.length + 'ch' : 'none'}`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    apply: APPLY,
    reason: REASON,
    list_path: LIST_PATH,
    list_count: list.length,
    rows_found: found.length,
    flaggable_count: flagged.length,
    skipped_not_canonical: skipped.not_canonical.map(r => ({ id: r.id, doi: r.canonical_doi, title: r.title })),
    skipped_already_noise: skipped.already_noise.map(r => ({ id: r.id, doi: r.canonical_doi, title: r.title })),
    dois_not_found: notFound,
    flagged: flagged.map(r => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, canonical_doi: r.canonical_doi })),
  };

  if (!APPLY) {
    fs.writeFileSync('reports/health-econ-apparatus-denylist-dryrun-2026-06-17.json', JSON.stringify(report, null, 2));
    console.log('\nDRY-RUN report: reports/health-econ-apparatus-denylist-dryrun-2026-06-17.json');
    process.exit(0);
  }

  // ============ APPLY (batched, per-row re-check) ============
  console.log('\n=== APPLYING (batched, per-row re-check) ===');
  let denylisted = 0, flaggedW = 0, skip = 0, errs = 0;
  const skippedRows = [];
  const batches = chunk(flagged, 75);
  let done = 0;

  for (const batch of batches) {
    const ids = batch.map(r => r.id);
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,title,canonical_doi,is_noise,canonical_work_id')
      .in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));

    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skip++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skip++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
      if (!wantSet.has((r.canonical_doi || '').toLowerCase())) { skip++; skippedRows.push({ id: t.id, why: 'doi_no_longer_in_list', doi: r.canonical_doi }); continue; }

      const { error: e1 } = await sb.from('corpus_denylist')
        .upsert({ work_id: t.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
      if (e1) { console.error('denylist', t.id, e1.message); errs++; continue; }
      denylisted++;
      const { error: e2 } = await sb.from('works')
        .update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', t.id);
      if (e2) { console.error('works update', t.id, e2.message); errs++; continue; }
      flaggedW++;
    }
    done += batch.length;
    console.log(`  ...${done}/${flagged.length} (flagged ${flaggedW}, skipped ${skip}, err ${errs})`);
  }

  report.result = { denylisted, works_flagged: flaggedW, skipped_recheck: skip, errors: errs };
  report.skipped_sample = skippedRows.slice(0, 50);
  fs.writeFileSync('reports/health-econ-apparatus-denylist-apply-2026-06-17.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skip} errors=${errs}`);
  console.log(`  Report: reports/health-econ-apparatus-denylist-apply-2026-06-17.json`);
})();
