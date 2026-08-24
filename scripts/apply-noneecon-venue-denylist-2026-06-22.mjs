#!/usr/bin/env node
/**
 * apply-noneecon-venue-denylist-2026-06-22.mjs — DESTRUCTIVE on --apply (flags
 * is_noise, nulls the ACTIVE qwen-768 `embedding`, inserts corpus_denylist).
 * VENUE-LIST variant, modelled byte-for-byte on apply-noneecon-venue-denylist.mjs
 * (the 2026-06-18 pass). Reason tag: non_econ_venue_2026_06_22.
 *
 * Context: a venue backfill populated `venue` on ~787 previously-blank ss: rows,
 * surfacing non-econ papers that slipped past prior denylists. This pass flags
 * ONLY genuinely-monodisciplinary non-economics venues, matched by EXACT/near-
 * exact venue string (NFC + lowercase + collapse-ws), corpus-wide (both ss: and
 * DOI rows), canonical (canonical_work_id IS NULL) + non-noise (is_noise IS NOT
 * TRUE). NO title-keyword matching.
 *
 * SAFE venues live in data/_noneecon-venues-2026-06-22.json. A baked-in HOLD set
 * (below) can NEVER be flagged even if mistakenly added to the JSON — the apply
 * path subtracts it. The HOLD list records venues the dry-run audit found mixed,
 * ambiguous, or junk-bucketed (econ content mis-tagged into a non-econ venue
 * string) — see the dry-run report for the per-venue reasoning.
 *
 * GOLDEN RULE: the ONLY per-row mutations are is_noise=true, noise_reason,
 * embedding=null (active qwen-768 col; NOT embedding_nomic_old) + a
 * corpus_denylist upsert. Per-row re-check immediately before each write
 * (canonical / non-noise / venue still in the SAFE set, NOT in HOLD).
 *
 * Usage:
 *   node --env-file=.env scripts/apply-noneecon-venue-denylist-2026-06-22.mjs --dry-run
 *   node --env-file=.env scripts/apply-noneecon-venue-denylist-2026-06-22.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'non_econ_venue_2026_06_22';
const DATE = '2026-06-22';
const PAGE = 1000;

const norm = (v) => String(v ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

// ---- SAFE allowlist (audited monodisciplinary non-econ) ----
const { venues: TARGET_VENUES } = JSON.parse(fs.readFileSync('data/_noneecon-venues-2026-06-22.json', 'utf8'));

// ---- HARD HOLD list: venues that can NEVER be flagged by this script, even if
// added to the JSON. These are mixed / ambiguous / junk-bucket venues the
// 2026-06-22 audit refused. Subtracted from the target set unconditionally. ----
const HOLD_VENUES_NORM = new Set([
  // Junk venue buckets — econ/social-science content mis-tagged into a non-econ string.
  'medical entomology and zoology',
  'cern document server (european organization for nuclear research)',
  'enlighten (jurnal bimbingan dan konseling islam)',
  // Health journals that carry health-economics / health-policy content.
  'bulletin of the world health organization',
  'revista panamericana de salud pública',
  'revista panamericana de salud publica-pan american journal of public health',
  'world health statistics quarterly. rapport trimestriel de statistiques sanitaires mondiales',
  'health systems in transition',
  // Apparatus (book reviews / catalog) carrying real econ titles — belong in the
  // apparatus denylist, not a non-econ-venue pass.
  'choice reviews online',
  'oup catalogue',
  // ---- 2026-06-22 user-list audit: EXCLUDE-ECON (real economics journals) ----
  'brookings papers on economic activity',
  'journal of the european economic association',
  'mineral economics',
  'asia-pacific journal of risk and insurance', // insurance/longevity ECONOMICS
  // ---- 2026-06-22 audit: HELD (econ-adjacent / dev-econ / health-econ residual / ambiguous) ----
  'personnel psychology',
  'international journal of hospitality management',
  'current psychology',
  'journal of primary prevention',
  'aids (london)',
  'journal of the national cancer institute',
  'psychiatric services',
  'psychiatry research',
  'the international journal of tuberculosis and lung disease',
  'the lancet diabetes and endocrinology',
  'american journal of potato research',
  'geografares',
  'international journal for the semiotics of law',
].map(norm));

const targetSet = new Set(TARGET_VENUES.map(norm).filter(Boolean));
// Subtract HOLD defensively.
for (const h of HOLD_VENUES_NORM) {
  if (targetSet.has(h)) { console.error(`REFUSING held venue present in JSON: "${h}"`); targetSet.delete(h); }
}
const exactVenues = [...new Set(TARGET_VENUES.map((v) => v.normalize('NFC')))].filter((v) => !HOLD_VENUES_NORM.has(norm(v)));

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function fetchByVenues(venues) {
  const rows = [];
  for (const batch of chunk(venues, 50)) {
    let offset = 0;
    while (true) {
      const { data, error } = await sb.from('works')
        .select('id,title,venue,year,citation_count,authors,abstract,canonical_doi,is_noise,canonical_work_id')
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

const sampleOf = (rows, n = 12) => {
  const byCite = [...rows].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
  return byCite.slice(0, n).map((r) => ({
    year: r.year, title: (r.title || '').slice(0, 100),
    authors: Array.isArray(r.authors) ? r.authors.length : 0,
    citation_count: r.citation_count, canonical_doi: r.canonical_doi,
    has_abstract: !!(r.abstract && r.abstract.length > 40),
  }));
};

(async () => {
  console.log(`=== NON-ECON VENUE DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===`);
  console.log(`SAFE target venues: ${exactVenues.length} distinct strings / ${targetSet.size} normalized`);
  console.log(`HARD-HOLD venues (never flagged): ${HOLD_VENUES_NORM.size}\n`);

  const all = await fetchByVenues(exactVenues);
  // Defensive: re-confirm the normalized venue is in SAFE and NOT in HOLD.
  const flagged = all.filter((r) => targetSet.has(norm(r.venue)) && !HOLD_VENUES_NORM.has(norm(r.venue)));

  const byVenue = {};
  for (const r of flagged) (byVenue[r.venue] ||= []).push(r);

  console.log('=== PER-VENUE COUNT + 12-ROW SAMPLE (SAFE venues only) ===');
  for (const [v, rows] of Object.entries(byVenue).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  VENUE: "${v}"  —  ${rows.length} rows  [VERDICT: SAFE]`);
    console.log('    cite | year | auth | title');
    for (const s of sampleOf(rows, 12)) {
      console.log(`    ${String(s.citation_count ?? '—').padStart(5)} | ${String(s.year ?? '—').padStart(4)} | ${String(s.authors).padStart(3)} | ${s.title}`);
    }
  }

  const matchedNorm = new Set(flagged.map((r) => norm(r.venue)));
  const zeroMatch = [...targetSet].filter((v) => !matchedNorm.has(v));
  console.log(`\n=== SAFE VENUES WITH 0 MATCHES (already-noise / casing mismatch) === ${zeroMatch.length}`);
  zeroMatch.forEach((v) => console.log(`  - ${v}`));

  console.log(`\n=== TOTAL FLAGGABLE: ${flagged.length} ===`);

  const report = {
    generated_at: new Date().toISOString(), apply: APPLY, reason: REASON,
    safe_target_count: exactVenues.length, hold_venue_count: HOLD_VENUES_NORM.size,
    flaggable_count: flagged.length,
    by_venue: Object.fromEntries(Object.entries(byVenue).map(([v, rows]) => [v, { count: rows.length, verdict: 'SAFE', sample: sampleOf(rows, 12) }])),
    held_venues: [...HOLD_VENUES_NORM],
    zero_match_targets: zeroMatch,
  };

  if (!APPLY) {
    report.flagged = flagged.map((r) => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, canonical_doi: r.canonical_doi }));
    fs.writeFileSync(`reports/noneecon-venue-denylist-dryrun-${DATE}.json`, JSON.stringify(report, null, 2));
    console.log(`\nDRY-RUN report: reports/noneecon-venue-denylist-dryrun-${DATE}.json`);
    return;
  }

  console.log('\n=== APPLYING (batched, per-row re-check) ===');
  let denylisted = 0, flaggedW = 0, skipped = 0, errs = 0, done = 0;
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
      const n = norm(r.venue);
      if (!targetSet.has(n) || HOLD_VENUES_NORM.has(n)) { skipped++; continue; }
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
  fs.writeFileSync(`reports/noneecon-venue-denylist-apply-${DATE}.json`, JSON.stringify(report, null, 2));
  console.log(`\n\n=== APPLIED === denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skipped} errors=${errs}`);
  console.log(`Report: reports/noneecon-venue-denylist-apply-${DATE}.json`);
})();
