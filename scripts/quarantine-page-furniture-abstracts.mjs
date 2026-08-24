#!/usr/bin/env node
/**
 * One-off remediation (2026-07-17): 28 corpus rows have `abstract` = scraped ACS
 * Publications page chrome ("ADVERTISEMENT RETURN TO ISSUE...Cite this:...Publication
 * Date (Web)...Request reuse permissions"), not real abstract prose — traced to
 * OpenAlex's abstract_inverted_index being built from the wrong page content for these
 * DOIs (verified live against the OpenAlex API; see scripts/lib/abstract-quality.mjs
 * PAGE_FURNITURE_RE, added this same session). All 28 are also ACS Publications
 * chemistry/energy "Viewpoint"/"Editorial" pieces, not economics research — they never
 * should have carried an ABS rating in the first place.
 *
 * Same remediation shape as the 2026-07-15 Gemini-recall quarantine
 * (scripts/verify-recalled-abstracts.mjs): null the bad abstract (gap-only golden rule —
 * nothing real is lost, there was no real abstract here), tag
 * raw_data.abstract_source='page_furniture_quarantined', sms_stale=true,
 * embedding_stale=true so the existing SMS-reclassify and
 * backfill-reembed-with-abstract.mjs --stale sweeps pick them up. REPORT-ONLY on the
 * corpus-noise angle (non-econ ACS editorials) — does NOT set is_noise; that's a
 * denylist-curation call, not this script's.
 *
 * Usage:
 *   node --env-file=.env scripts/quarantine-page-furniture-abstracts.mjs --dry-run
 *   node --env-file=.env scripts/quarantine-page-furniture-abstracts.mjs
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { PAGE_FURNITURE_RE } from './lib/abstract-quality.mjs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY_RUN = process.argv.includes('--dry-run');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = `reports/page-furniture-quarantine-${TODAY}.json`;

async function findTargets() {
  const rows = [];
  let cursor = null;
  for (;;) {
    let q = sb.from('works').select('id,title,abstract,venue,abs_rating,raw_data')
      .not('abstract', 'is', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    for (const r of data) if (PAGE_FURNITURE_RE.test(r.abstract || '')) rows.push(r);
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return rows;
}

async function main() {
  console.log(`\n=== Page-furniture abstract quarantine (dry-run: ${DRY_RUN}) ===`);
  const targets = await findTargets();
  console.log(`Found ${targets.length} rows matching PAGE_FURNITURE_RE.\n`);
  for (const t of targets) console.log(`  ${t.id}  [${t.venue || '?'}, abs=${t.abs_rating || '?'}]  ${t.title}`);

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'These rows had abstract=publisher page chrome (no real content) — quarantined to abstract=NULL. Also flagged here (report-only, NOT is_noise) because all are non-economics ACS Publications editorials/viewpoints that likely should not carry an abs_rating at all — a denylist-curation candidate, not auto-flagged by this script.',
    count: targets.length,
    rows: targets.map(t => ({ id: t.id, title: t.title, venue: t.venue, abs_rating: t.abs_rating })),
  }, null, 2));
  console.log(`\nReport -> ${OUT}`);

  if (DRY_RUN) { console.log('Dry run — no writes.'); return; }

  let ok = 0, err = 0;
  for (const t of targets) {
    const raw = (t.raw_data == null || Array.isArray(t.raw_data) || typeof t.raw_data !== 'object') ? {} : { ...t.raw_data };
    raw.abstract_source = 'page_furniture_quarantined';
    raw.abstract_quarantined_at = new Date().toISOString();
    raw.sms_stale = true;
    raw.embedding_stale = true;
    const { error } = await sb.from('works').update({ abstract: null, raw_data: raw }).eq('id', t.id);
    if (error) { err++; console.error(`  FAILED ${t.id}: ${error.message}`); } else ok++;
  }
  console.log(`\nDone. quarantined=${ok} errors=${err}`);
  console.log('NOTE: run the SMS reclassify and backfill-reembed-with-abstract.mjs --stale passes to clear sms_stale/embedding_stale on these rows.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
