#!/usr/bin/env node
/**
 * SMS Phase 1 (non-GPU) — apply the Phase-0 rules RETROACTIVELY to existing rows.
 *
 * Phase-0 hardened the classifiers so NEW papers get these caps; this brings the
 * already-classified corpus into line without any GPU/Qwen work:
 *
 *   Rule A — keyword-path high tier: sms_method in (keyword,keyword_scan,
 *     keyword_weak) AND sms_level >= 4  →  cap to SMS 3 (SMS 2 if no abstract).
 *     A single keyword match can't assert quasi-experimental rigor.
 *   Rule B — title-only rigor: sms_level >= 3 AND abstract is null (any method,
 *     incl. the quarantined fabricated-abstract rows) → cap to SMS 2. No rigor
 *     claim from a title alone.
 *
 * Only ever LOWERS a level (min of applicable rules); keeps the design label;
 * stores raw_data.sms_precap_level + sms_capped for a clean --revert. Idempotent.
 * Scope: canonical (canonical_work_id null), non-noise.
 *
 *   node --env-file=.env scripts/sms-apply-phase0-caps.mjs --dry-run
 *   node --env-file=.env scripts/sms-apply-phase0-caps.mjs
 *   node --env-file=.env scripts/sms-apply-phase0-caps.mjs --revert
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REVERT = args.includes('--revert');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const REST = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEYWORD_METHODS = '(keyword,keyword_scan,keyword_weak)';

async function get(path) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(REST + path, { headers: H }); if (r.ok) return await r.json(); if (r.status >= 500) { await sleep(1500 * (a + 1)); continue; } console.error(path, r.status, await r.text()); return []; }
    catch { await sleep(1500 * (a + 1)); }
  }
  return [];
}
async function scan(filter, select) {
  const rows = []; let from = 0;
  for (;;) {
    const page = await get(`/works?${filter}&select=${select}&order=id&limit=1000&offset=${from}`);
    if (!page.length) break;
    rows.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  return rows;
}
const cs = (lvl) => lvl >= 4 ? 'high' : lvl >= 3 ? 'moderate' : lvl === 0 ? 'signal' : 'limited';

async function apply() {
  console.log(`=== SMS Phase 1 caps (${DRY ? 'DRY-RUN' : 'APPLY'}) ===`);
  const base = 'canonical_work_id=is.null&is_noise=not.is.true';
  const sel = 'id,sms_level,sms_method,methodology_design,sms_rationale,raw_data';

  // Target = union of the two rule pools. Compute the capped level per row.
  const targets = new Map(); // id -> { row, newLevel, reason }
  const consider = (row, newLevel, reason) => {
    if (row.sms_level == null || newLevel >= row.sms_level) return; // only lower
    const cur = targets.get(row.id);
    if (!cur || newLevel < cur.newLevel) targets.set(row.id, { row, newLevel, reason });
  };

  console.log('Scanning Rule A (keyword high-tier, abstract present → 3)...');
  for (const r of await scan(`${base}&sms_method=in.${KEYWORD_METHODS}&sms_level=gte.4&abstract=not.is.null`, sel)) consider(r, 3, 'keyword-high-tier');
  console.log('Scanning Rule A (keyword high-tier, no abstract → 2)...');
  for (const r of await scan(`${base}&sms_method=in.${KEYWORD_METHODS}&sms_level=gte.4&abstract=is.null`, sel)) consider(r, 2, 'keyword-high-tier-no-abstract');
  console.log('Scanning Rule B (SMS>=3, no abstract → 2)...');
  for (const r of await scan(`${base}&sms_level=gte.3&abstract=is.null`, sel)) consider(r, 2, 'no-abstract');

  console.log(`Rows to cap: ${targets.size}`);
  const byReason = {};
  for (const { reason } of targets.values()) byReason[reason] = (byReason[reason] || 0) + 1;
  console.log('By reason:', JSON.stringify(byReason));
  if (DRY) { console.log('Dry run — no writes.'); return; }

  let done = 0, err = 0;
  for (const { row, newLevel, reason } of targets.values()) {
    const raw = { ...(row.raw_data || {}) };
    if (raw.sms_precap_level == null) raw.sms_precap_level = row.sms_level; // preserve ONCE (idempotent)
    raw.sms_capped = true;
    const rationale = `[capped ${row.sms_level}->${newLevel}: ${reason}] ${String(row.sms_rationale || '').replace(/^\[capped[^\]]*\]\s*/, '')}`.slice(0, 240);
    const { error } = await sb.from('works').update({
      sms_level: newLevel, causal_strength: cs(newLevel), sms_rationale: rationale, raw_data: raw,
    }).eq('id', row.id);
    if (error) err++; else done++;
    if ((done + err) % 500 === 0) process.stdout.write(`\r  ${done + err}/${targets.size} (err ${err})`);
  }
  console.log(`\nDone: capped ${done}, errors ${err}`);
}

async function revert() {
  console.log('=== SMS Phase 1 caps REVERT ===');
  const rows = await scan('raw_data->>sms_capped=eq.true', 'id,sms_level,sms_rationale,raw_data');
  console.log(`Capped rows to revert: ${rows.length}`);
  let done = 0, err = 0;
  for (const row of rows) {
    const raw = { ...(row.raw_data || {}) };
    const orig = raw.sms_precap_level;
    delete raw.sms_capped; delete raw.sms_precap_level;
    const rationale = String(row.sms_rationale || '').replace(/^\[capped[^\]]*\]\s*/, '');
    const { error } = await sb.from('works').update({
      sms_level: orig ?? row.sms_level, causal_strength: cs(orig ?? row.sms_level), sms_rationale: rationale, raw_data: raw,
    }).eq('id', row.id);
    if (error) err++; else done++;
    if ((done + err) % 500 === 0) process.stdout.write(`\r  ${done + err}/${rows.length}`);
  }
  console.log(`\nReverted ${done}, errors ${err}`);
}

(REVERT ? revert() : apply()).catch(e => { console.error('Fatal:', e); process.exit(1); });
