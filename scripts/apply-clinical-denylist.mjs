#!/usr/bin/env node
/**
 * apply-clinical-denylist.mjs — DESTRUCTIVE (flags is_noise, nulls embedding,
 * inserts corpus_denylist). DOI-PREFIX variant of apply-noneecon-denylist.mjs.
 *
 * Continues the non-econ denylist effort (non_econ_field_2026_06_12). Clinical
 * mega-venues (JAMA family / NEJM / AHA-Circulation) slipped past the venue/FOS
 * pass; this targets them by canonical_doi prefix.
 *
 * Scope (user-approved, do NOT widen):
 *   10.1001/%  -> JAMA family   (JAMA / JAMA Network Open / JAMA Pediatrics / etc.)
 *   10.1056/%  -> NEJM
 *   10.1161/%  -> AHA / Circulation
 *   ONLY canonical (canonical_work_id IS NULL) AND non-noise (is_noise IS NOT TRUE).
 *
 * 🚫 OUT OF SCOPE — never matched here: 10.1136 (BMJ), 10.1016/s0140-6736 (Lancet),
 *    10.1371 (PLOS).
 *
 * PROTECT-GUARD (decided 2026-06-13 from the dry-run audit):
 *   The DOI prefix ALREADY proves a monodisciplinary clinical venue (JAMA/NEJM/AHA),
 *   so a stored econ FOS tag is unreliable here — OpenAlex auto-tags clinical papers
 *   like "Depression Following Myocardial Infarction" with "Macroeconomics"/"Economics"
 *   (488 of the in-scope rows carry such a spurious tag; ALL are clinical). An FOS guard
 *   therefore HIDES genuine clinical noise, the opposite of its job in the mixed-venue
 *   pass. So we do NOT gate on FOS. Instead a precise TITLE guard protects the genuine
 *   health-ECONOMICS cluster found in the audit (national health spending/expenditure +
 *   cost-effectiveness methodology/analyses). Conservative: 7 such titles are protected
 *   & reported, never flagged.
 *
 * Hard rules:
 *  - GOLDEN RULE: only mutations per row are is_noise=true, noise_reason,
 *    embedding=null (the active qwen-768 col; NOT embedding_nomic_old), and a
 *    corpus_denylist insert. Nothing else touched.
 *  - Apply-time re-check: re-fetch each row, re-verify canonical/non-noise/DOI-prefix/guard
 *    immediately before the write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-clinical-denylist.mjs --dry-run
 *   node --env-file=.env scripts/apply-clinical-denylist.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PAGE = 1000;
const APPLY = process.argv.includes('--apply');
const REASON = 'non_econ_clinical_2026_06_13';

// DOI prefixes in scope. ilike patterns (case-insensitive).
const DOI_PREFIXES = [
  { pat: '10.1001/%', label: 'JAMA family (10.1001)' },
  { pat: '10.1056/%', label: 'NEJM (10.1056)' },
  { pat: '10.1161/%', label: 'AHA/Circulation (10.1161)' },
];

// PROTECT-GUARD — TITLE-LEVEL genuine health-ECONOMICS only. Derived from the
// dry-run audit (the only 7 in-scope titles reading as health economics):
//   - national health spending / expenditure trend analyses
//   - cost-effectiveness methodology panels + cost-effectiveness analyses
// We deliberately protect the whole cost-effectiveness cluster (incl. 3 single-
// treatment CEAs) — over-protecting 3 borderline clinical papers is harmless;
// wrongly denylisting a real health-econ paper is not.
const ECON_TITLE_RE = /\b(health care spending|health[- ]care spending|spending by payer|spending in the united states|cost-?effective)/i;

const isProtected = (r) => !!(r.title && ECON_TITLE_RE.test(r.title));

async function pageThrough(pat) {
  const rows = []; let offset = 0;
  while (true) {
    const { data, error } = await sb.from('works')
      .select('id,title,venue,citation_count,year,fields_of_study,authors,abstract,canonical_doi,is_noise,canonical_work_id')
      .is('canonical_work_id', null).not('is_noise', 'is', true)
      .ilike('canonical_doi', pat)
      .range(offset, offset + PAGE - 1);
    if (error) { console.error('  ERR', error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

// chunk helper
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

(async () => {
  console.log(`=== CLINICAL DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===\n`);

  const flagged = [];
  const protectedRows = [];
  const venueCount = {};
  const seen = new Set();

  for (const { pat, label } of DOI_PREFIXES) {
    const rows = await pageThrough(pat);
    let flag = 0, prot = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue; seen.add(r.id);
      if (isProtected(r)) { prot++; protectedRows.push({ ...r, prefix: label }); continue; }
      flag++;
      flagged.push({ ...r, prefix: label, reason: `clinical DOI prefix ${label}` });
      venueCount[r.venue || '(null)'] = (venueCount[r.venue || '(null)'] || 0) + 1;
    }
    console.log(`  ${String(rows.length).padStart(5)} rows | flag ${flag} | protect ${prot} | ${label}`);
  }

  console.log(`\n=== VENUE BREAKDOWN (flaggable) ===`);
  for (const [v, n] of Object.entries(venueCount).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)} | ${v}`);

  console.log(`\n=== TOTALS ===`);
  console.log(`  flaggable: ${flagged.length} | protected(reported, NOT flagged): ${protectedRows.length}`);

  if (protectedRows.length) {
    console.log(`\n=== PROTECTED (genuine health-econ — SKIPPED, never flagged) ===`);
    for (const r of protectedRows) {
      console.log(`  [${r.citation_count ?? '—'}] ${r.venue} | ${(r.title || '').slice(0, 80)}`);
      console.log(`        DOI: ${r.canonical_doi}`);
    }
  }

  // 20-row title sample (10 top-cited + 10 mid)
  const byCite = [...flagged].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
  const sample = [...byCite.slice(0, 10), ...flagged.slice(Math.floor(flagged.length / 2), Math.floor(flagged.length / 2) + 10)];
  console.log(`\n=== 20-ROW TITLE SAMPLE (10 top-cited + 10 mid) ===`);
  for (const r of sample) {
    console.log(`  [${r.citation_count ?? '—'}] ${r.venue} | ${(r.title || '').slice(0, 72)}`);
    console.log(`        DOI: ${r.canonical_doi} | FOS: ${(r.fields_of_study || []).slice(0, 6).join(', ')}`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    apply: APPLY,
    reason: REASON,
    doi_prefixes: DOI_PREFIXES,
    out_of_scope_never_matched: ['10.1136 BMJ', '10.1016/s0140-6736 Lancet', '10.1371 PLOS'],
    flaggable_count: flagged.length,
    protected_count: protectedRows.length,
    venue_breakdown: venueCount,
    protected: protectedRows.map(r => ({ id: r.id, title: r.title, venue: r.venue, citation_count: r.citation_count, canonical_doi: r.canonical_doi, prefix: r.prefix })),
  };

  if (!APPLY) {
    report.flagged = flagged.map(r => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, fields_of_study: r.fields_of_study, canonical_doi: r.canonical_doi, prefix: r.prefix }));
    fs.writeFileSync('reports/clinical-denylist-dryrun-2026-06-13.json', JSON.stringify(report, null, 2));
    console.log('\nDRY-RUN report: reports/clinical-denylist-dryrun-2026-06-13.json');
    process.exit(0);
  }

  // ============ APPLY (batched, per-row re-check) ============
  console.log('\n=== APPLYING (batched, per-row re-check) ===');
  let denylisted = 0, flaggedW = 0, skipped = 0, errs = 0;
  const skippedRows = [];
  const batches = chunk(flagged, 75);
  let done = 0;

  for (const batch of batches) {
    const ids = batch.map(r => r.id);
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,title,venue,canonical_doi,is_noise,canonical_work_id')
      .in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));

    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skipped++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skipped++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
      const doi = (r.canonical_doi || '').toLowerCase();
      const matchesPrefix = doi.startsWith('10.1001/') || doi.startsWith('10.1056/') || doi.startsWith('10.1161/');
      if (!matchesPrefix) { skipped++; skippedRows.push({ id: t.id, why: 'doi_no_longer_matches', doi: r.canonical_doi }); continue; }
      if (isProtected(r)) { skipped++; skippedRows.push({ id: t.id, why: 'now_protected_health_econ', title: r.title }); continue; }

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
    console.log(`  ...${done}/${flagged.length} (flagged ${flaggedW}, skipped ${skipped}, err ${errs})`);
  }

  report.result = { denylisted, works_flagged: flaggedW, skipped_recheck: skipped, errors: errs };
  report.skipped_sample = skippedRows.slice(0, 50);
  report.flagged_ids = flagged.map(r => r.id);
  fs.writeFileSync('reports/clinical-denylist-apply-2026-06-13.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skipped} errors=${errs}`);
  console.log(`  Report: reports/clinical-denylist-apply-2026-06-13.json`);
})();
