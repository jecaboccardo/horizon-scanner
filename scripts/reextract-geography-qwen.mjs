#!/usr/bin/env node
/**
 * RE-EXTRACT works.geography for rows whose stored tag is WRONG (the Keefer
 * class): a non-empty geography that carries no LAC signal on a paper whose own
 * title/abstract is clearly about Latin America / the Caribbean. `--mode
 * geography` can't fix these — it's gap-only (NULL/{}). Candidate ids come from
 * scripts/detect-geography-lac-mismatch.mjs.
 *
 * Unlike the gap-only backfill this OVERWRITES an existing (wrong) tag, so it is:
 *   - text-based only  : reads the paper's OWN title/abstract (never training-data
 *                        recall) and asks what the study COVERS — same prompt as
 *                        backfill-metadata-qwen.mjs `inferGeography`.
 *   - conservative     : writes only a non-empty fresh extraction. If Qwen returns
 *                        [] (global / incidental mention) the row is left as-is and
 *                        flagged 'review' — we never blow a wrong tag away to empty.
 *   - reversible       : stashes the old array in raw_data.geography_prev and stamps
 *                        geography_source='qwen_reextract' + geography_reextracted_at.
 *                        `--revert` restores geography_prev.
 *   - rate-limited     : shared single GPU — default concurrency 2, sleep 1500ms.
 *                        Run OFF-PEAK / attended (this process is NOT bounded by the
 *                        prod qwenGate).
 *
 * After a run, recompute the derived region:
 *   node --env-file=.env scripts/derive-ux-region.mjs --fix-global
 *
 * Usage:
 *   node --env-file=.env scripts/reextract-geography-qwen.mjs --dry-run
 *   node --env-file=.env scripts/reextract-geography-qwen.mjs --ids-file reports/geography-lac-mismatch-ids-t1t2.json --limit 15
 *   node --env-file=.env scripts/reextract-geography-qwen.mjs --ids-file reports/geography-lac-mismatch-ids-t1t2.json
 *   node --env-file=.env scripts/reextract-geography-qwen.mjs --revert
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fb) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const DRY_RUN = args.includes('--dry-run');
const REVERT = args.includes('--revert');
const IDS_FILE = flag('--ids-file', 'reports/geography-lac-mismatch-ids-t1t2.json');
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;
const CONCURRENCY = parseInt(flag('--concurrency', '2'));
const SLEEP_MS = parseInt(flag('--sleep-ms', '1500'));
const MODEL = 'qwen2.5:14b-synthesis';
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY;

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readIds() {
  const raw = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
  return raw.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
}

async function fetchRows(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('works')
      .select('id, title, year, venue, abstract, geography, raw_data')
      .in('id', ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    if (data) rows.push(...data);
  }
  return rows;
}

async function callQwen(prompt) {
  const res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 256 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Qwen ${res.status}`);
  const d = await res.json();
  const text = (d.choices?.[0]?.message?.content || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON');
  return JSON.parse(m[0]);
}

async function inferGeography(paper) {
  // Same contract as backfill-metadata-qwen.mjs inferGeography: what the study
  // COVERS (not author affiliation); [] for global/theoretical/no focus.
  const prompt = `Extract the geographic focus of this academic paper from its title and abstract.

Title: ${paper.title}
Year: ${paper.year || 'unknown'}
Venue: ${paper.venue || 'unknown'}
${paper.abstract ? 'Abstract: ' + paper.abstract.slice(0, 800) : ''}

Identify countries, regions, or cities that this paper STUDIES (not where the authors are from).
Examples: ["Brazil"], ["Mexico", "Colombia"], ["Latin America"], ["Sub-Saharan Africa"], ["United States"]
If the paper is global/cross-country/theoretical with no specific geographic focus, return [].

JSON only (no markdown):
{ "geography": ["Country1", "Region1"] or [] }`;
  const r = await callQwen(prompt);
  return Array.isArray(r.geography) ? r.geography : [];
}

async function revert() {
  console.log('=== REVERT geography re-extraction ===');
  // Page rows stamped by this script and restore the stashed prior array.
  let restored = 0, cursor = '';
  for (;;) {
    let q = sb.from('works')
      .select('id, raw_data, geography')
      .eq('raw_data->>geography_source', 'qwen_reextract')
      .order('id', { ascending: true })
      .limit(500);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    cursor = data[data.length - 1].id;
    for (const row of data) {
      const prev = row.raw_data?.geography_prev;
      if (prev === undefined) continue;
      const raw = { ...row.raw_data };
      delete raw.geography_source; delete raw.geography_prev; delete raw.geography_reextracted_at;
      if (!DRY_RUN) {
        const { error: e } = await sb.from('works').update({ geography: prev, raw_data: raw }).eq('id', row.id);
        if (e) { console.error('revert failed', row.id, e.message); continue; }
      }
      restored++;
    }
    process.stdout.write(`\r  restored ${restored}...`);
  }
  console.log(`\nReverted ${restored} rows${DRY_RUN ? ' (dry-run)' : ''}.`);
}

async function main() {
  if (!LLM_KEY && !REVERT) { console.error('LLM_API_KEY not set'); process.exit(1); }
  if (REVERT) return revert();

  const ids = readIds().slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const rows = await fetchRows(ids);
  console.log(`=== Geography re-extraction (Qwen inferGeography) ===`);
  console.log(`Model: ${MODEL} | ids: ${ids.length} | fetched: ${rows.length} | conc: ${CONCURRENCY} | sleep: ${SLEEP_MS}ms | dryRun: ${DRY_RUN}\n`);

  let written = 0, review = 0, unchanged = 0, errors = 0;
  const samples = [];

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (paper) => {
      try {
        const fresh = await inferGeography(paper);
        // Conservative: never overwrite a wrong tag with an empty one. An empty
        // result on a flagged row means "Qwen judged the LAC mention incidental /
        // global" — leave the row untouched and flag it for manual review.
        if (fresh.length === 0) { review++; if (samples.length < 25) samples.push({ id: paper.id, title: (paper.title||'').slice(0,80), old: paper.geography, new: '[] → REVIEW' }); return; }
        // No-op if identical to what's stored (shouldn't happen for flagged rows).
        const same = JSON.stringify([...(paper.geography||[])].sort()) === JSON.stringify([...fresh].sort());
        if (same) { unchanged++; return; }
        if (samples.length < 25) samples.push({ id: paper.id, title: (paper.title||'').slice(0,80), old: paper.geography, new: fresh });
        if (!DRY_RUN) {
          const raw = { ...(paper.raw_data || {}) };
          raw.geography_prev = paper.geography ?? null;
          raw.geography_source = 'qwen_reextract';
          raw.geography_reextracted_at = new Date().toISOString();
          const { error } = await sb.from('works').update({ geography: fresh, raw_data: raw }).eq('id', paper.id);
          if (error) { errors++; return; }
        }
        written++;
      } catch { errors++; }
    }));
    await sleep(SLEEP_MS);
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} | written ${written} | review ${review} | same ${unchanged} | err ${errors}`);
  }

  console.log(`\n\n${DRY_RUN ? '(dry-run) would write' : 'wrote'} ${written} | review(left as-is) ${review} | unchanged ${unchanged} | errors ${errors}`);
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/geography-reextract-samples.json', JSON.stringify({ generated_at: new Date().toISOString(), written, review, unchanged, errors, samples }, null, 2));
  console.log('Samples → reports/geography-reextract-samples.json');
  if (!DRY_RUN && written > 0) console.log('\nNext: node --env-file=.env scripts/derive-ux-region.mjs --fix-global');
}

main().catch((e) => { console.error(e); process.exit(1); });
