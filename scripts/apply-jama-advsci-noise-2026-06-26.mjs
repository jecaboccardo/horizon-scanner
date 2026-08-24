#!/usr/bin/env node
/**
 * Confirm-and-flag non-econ noise in two venues surfaced by the stringified-authors
 * audit (2026-06-26): JAMA family (10.1001/*) and Advanced Science (10.1002/advs*).
 *
 *  - Advanced Science (Wiley): a monodisciplinary materials/biomed/engineering venue
 *    with ZERO economics content → flag ALL live non-noise rows, sparing anything that
 *    trips an ECON protect-guard (expected ~0).
 *  - JAMA family: MOSTLY already noise (clinical denylist). The handful of live rows are
 *    a MIX — most are legitimate HEALTH/DEV economics (cost-effectiveness panels, US
 *    health-care spending, private-equity-in-healthcare, a Conditional-Cash-Transfer×LAC
 *    paper) and MUST be kept. A HEALTH-ECON protect-guard keeps those; only the clearly
 *    clinical remainder (stress-system disorders, an oncology drug trial) is flagged.
 *
 * DESTRUCTIVE on --apply: is_noise=true, noise_reason, embedding=null + corpus_denylist.
 * Dry-run by default; per-row re-check before write. Golden-rule-safe (only those 4 ops).
 *
 *   node --env-file=.env scripts/apply-jama-advsci-noise-2026-06-26.mjs --dry-run
 *   node --env-file=.env scripts/apply-jama-advsci-noise-2026-06-26.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

// ECON keywords — a hit SPARES an Advanced-Science row (don't noise a real econ paper).
// NOTE: leading \b only, NO trailing \b — a trailing boundary breaks stem matches
// ("econom" inside "economics", "cost-effective" inside "cost-effectiveness").
const ECON_RE = /\b(?:econom|gdp|inflation|\bwage|labou?r market|monetary policy|fiscal policy|\btrade\b|tariff|taxation|poverty|inequality|household income|unemployment|productivity growth|market structure|welfare econ|cost-?effective|health\s*(?:care\s*)?spend|health\s*(?:care\s*)?expenditure|cash transfer|private equity|insurance market)/i;
// HEALTH-ECON keywords — a hit KEEPS a JAMA row (it's health/dev economics, not clinical).
const HEALTHECON_RE = /\b(?:cost-?effective|health\s*(?:care\s*)?spend|health\s*(?:care\s*)?expenditure|spending by|panel on cost|methodological practices, and reporting|economics of|cash transfer|private equity)/i;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
async function loadLive(pattern) {
  let cursor = '', rows = [];
  for (;;) {
    let q = sb.from('works').select('id,title,citation_count,is_noise,canonical_work_id,venue').ilike('id', pattern)
      .is('canonical_work_id', null).not('is_noise', 'is', true).order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('load', pattern, error.message); break; }
    if (!data?.length) break;
    rows.push(...data); cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return rows;
}

const advsci = await loadLive('10.1002/advs%');
const jama = await loadLive('10.1001/%');

// Normalise unicode hyphens/dashes (U+2010..U+2015) to ASCII '-' so "Cost‐Effectiveness"
// (which uses U+2010, not '-') matches the guards. Without this, real cost-effectiveness
// health-econ papers get wrongly flagged.
const norm = (t) => String(t || '').replace(/[‐-―]/g, '-');
const advFlag = advsci.filter((r) => !ECON_RE.test(norm(r.title)));
const advSpare = advsci.filter((r) => ECON_RE.test(norm(r.title)));
const jamaFlag = jama.filter((r) => !HEALTHECON_RE.test(norm(r.title)));
const jamaKeep = jama.filter((r) => HEALTHECON_RE.test(norm(r.title)));

const plan = [
  { reason: 'non_econ_venue_advsci_2026_06_26', flag: advFlag, spare: advSpare, label: 'Advanced Science' },
  { reason: 'non_econ_clinical_2026_06_26', flag: jamaFlag, spare: jamaKeep, label: 'JAMA' },
];

console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
for (const p of plan) {
  console.log(`\n${p.label}: live=${p.flag.length + p.spare.length} | TO FLAG=${p.flag.length} | SPARED(econ guard)=${p.spare.length}  [reason=${p.reason}]`);
  console.log('  -- flag (sample) --');
  p.flag.slice(0, 6).forEach((r) => console.log(`     cit=${r.citation_count || 0} | ${String(r.title).slice(0, 68)}`));
  if (p.spare.length) { console.log('  -- SPARED (kept as econ) --'); p.spare.forEach((r) => console.log(`     cit=${r.citation_count || 0} | ${String(r.title).slice(0, 68)}`)); }
}

const report = { generated_at: new Date().toISOString(), apply: APPLY, plan: plan.map((p) => ({ reason: p.reason, label: p.label, flag: p.flag.map((r) => ({ id: r.id, cit: r.citation_count, title: r.title })), spared: p.spare.map((r) => ({ id: r.id, title: r.title })) })) };
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(`reports/jama-advsci-noise-${APPLY ? 'apply' : 'dryrun'}-2026-06-26.json`, JSON.stringify(report, null, 2));

if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply.'); process.exit(0); }

for (const p of plan) {
  let done = 0, err = 0;
  for (const batch of chunk(p.flag, 75)) {
    const ids = batch.map((r) => r.id);
    const { data: live } = await sb.from('works').select('id,is_noise,canonical_work_id').in('id', ids);
    const byId = new Map((live || []).map((r) => [r.id, r]));
    for (const r of batch) {
      const lr = byId.get(r.id);
      if (!lr || lr.is_noise === true || lr.canonical_work_id != null) continue; // re-guard
      const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: r.id, reason: p.reason }, { onConflict: 'work_id', ignoreDuplicates: true });
      const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: p.reason, embedding: null }).eq('id', r.id);
      if (e1 || e2) { err++; if (err <= 3) console.error('  err', r.id, (e1 || e2).message); } else done++;
    }
  }
  console.log(`${p.label}: flagged ${done} errors ${err} (reason=${p.reason})`);
}
console.log('\n=== APPLIED ===');
