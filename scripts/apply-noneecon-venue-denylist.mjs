#!/usr/bin/env node
/**
 * apply-noneecon-venue-denylist.mjs — DESTRUCTIVE (flags is_noise, nulls
 * embedding, inserts corpus_denylist). VENUE-LIST variant of
 * apply-clinical-denylist.mjs.
 *
 * Flags every canonical (canonical_work_id IS NULL) non-noise (is_noise IS NOT
 * TRUE) paper whose `venue` matches a user-curated list of non-economics venues
 * (biomedical / clinical / engineering / veterinary / etc.) read from
 * data/_noneecon-venues-2026-06-18.json. Match is normalized (lowercase + trim +
 * collapse whitespace) to catch case variants ("International journal of hydrogen
 * energy" vs "...Hydrogen Energy").
 *
 * Golden rule: the ONLY per-row mutations are is_noise=true, noise_reason,
 * embedding=null (active qwen-768 col; NOT embedding_nomic_old) + a
 * corpus_denylist upsert. Per-row re-check immediately before each write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-noneecon-venue-denylist.mjs --dry-run
 *   node --env-file=.env scripts/apply-noneecon-venue-denylist.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'non_econ_venue_2026_06_18';
const PAGE = 1000;

// NFC-normalize so accented venues ("Acta pediátrica española") match the DB's
// composed form regardless of how the source list encoded the accent.
const norm = (v) => String(v ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
const { venues: TARGET_VENUES } = JSON.parse(fs.readFileSync('data/_noneecon-venues-2026-06-18.json', 'utf8'));
const targetSet = new Set(TARGET_VENUES.map(norm).filter(Boolean));
// Distinct exact strings (NFC) for the .in() filter (DB venue values the user copied).
const exactVenues = [...new Set(TARGET_VENUES.map((v) => v.normalize('NFC')))];

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function fetchByVenues(venues) {
  const rows = [];
  for (const batch of chunk(venues, 50)) {
    let offset = 0;
    while (true) {
      const { data, error } = await sb.from('works')
        .select('id,title,venue,year,citation_count,canonical_doi,is_noise,canonical_work_id')
        .is('canonical_work_id', null).not('is_noise', 'is', true)
        .in('venue', batch)
        .range(offset, offset + PAGE - 1);
      if (error) { console.error('  ERR', error.message); break; }
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
      offset += PAGE;
    }
  }
  return rows;
}

(async () => {
  console.log(`=== NON-ECON VENUE DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===`);
  console.log(`Target venues: ${exactVenues.length} distinct strings / ${targetSet.size} normalized\n`);

  const all = await fetchByVenues(exactVenues);
  // Defensive: re-confirm the normalized venue is actually in the target set.
  const flagged = all.filter((r) => targetSet.has(norm(r.venue)));

  const byVenue = {};
  for (const r of flagged) byVenue[r.venue] = (byVenue[r.venue] || 0) + 1;

  console.log('=== MATCHED COUNT PER VENUE (DB casing) ===');
  for (const [v, n] of Object.entries(byVenue).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} | ${v}`);

  const matchedNorm = new Set(flagged.map((r) => norm(r.venue)));
  const zeroMatch = [...targetSet].filter((v) => !matchedNorm.has(v));
  console.log(`\n=== TARGET VENUES WITH 0 MATCHES (already-noise or casing mismatch) ===  ${zeroMatch.length}`);
  zeroMatch.forEach((v) => console.log(`  - ${v}`));

  console.log(`\n=== TOTAL FLAGGABLE: ${flagged.length} ===`);
  const byCite = [...flagged].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
  console.log('\n=== TOP 20 BY CITATION (sanity — should all be non-econ) ===');
  for (const r of byCite.slice(0, 20)) console.log(`  [${r.citation_count ?? '—'}] ${String(r.venue).slice(0, 32).padEnd(32)} | ${String(r.title || '').slice(0, 60)}`);

  const date = '2026-06-18';
  const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, target_venue_count: exactVenues.length, flaggable_count: flagged.length, by_venue: byVenue, zero_match_targets: zeroMatch };

  if (!APPLY) {
    report.flagged = flagged.map((r) => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, canonical_doi: r.canonical_doi }));
    fs.writeFileSync(`reports/noneecon-venue-denylist-dryrun-${date}.json`, JSON.stringify(report, null, 2));
    console.log(`\nDRY-RUN report: reports/noneecon-venue-denylist-dryrun-${date}.json`);
    return;
  }

  console.log('\n=== APPLYING (batched, per-row re-check) ===');
  let denylisted = 0, flaggedW = 0, skipped = 0, errs = 0;
  let done = 0;
  for (const batch of chunk(flagged, 75)) {
    const ids = batch.map((r) => r.id);
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,venue,is_noise,canonical_work_id').in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map((r) => [r.id, r]));
    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skipped++; continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skipped++; continue; }
      if (!targetSet.has(norm(r.venue))) { skipped++; continue; }
      const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: t.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
      if (e1) { console.error('denylist', t.id, e1.message); errs++; continue; }
      denylisted++;
      const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', t.id);
      if (e2) { console.error('works update', t.id, e2.message); errs++; continue; }
      flaggedW++;
    }
    done += batch.length;
    process.stdout.write(`\r  ...${done}/${flagged.length} (flagged ${flaggedW}, skipped ${skipped}, err ${errs})`);
  }
  report.result = { denylisted, works_flagged: flaggedW, skipped_recheck: skipped, errors: errs };
  fs.writeFileSync(`reports/noneecon-venue-denylist-apply-${date}.json`, JSON.stringify(report, null, 2));
  console.log(`\n\n=== APPLIED === denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skipped} errors=${errs}`);
  console.log(`Report: reports/noneecon-venue-denylist-apply-${date}.json`);
})();
