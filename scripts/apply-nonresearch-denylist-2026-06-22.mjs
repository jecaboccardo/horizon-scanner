#!/usr/bin/env node
/**
 * Non-research document denylist — Nobel lectures + independent-auditor reports.
 * DESTRUCTIVE on --apply (is_noise=true, noise_reason, embedding=null [active qwen-768
 * column], + corpus_denylist upsert). Dry-run by default. Per-row re-check at apply.
 *
 * Clusters (verify-before-flag, RESEARCH GUARD on each):
 *   nobel_lecture  — "Nobel Lecture: ..." ceremonial laureate lectures (not empirical research)
 *   auditor_report — "Report of Independent Auditor" / "Independent Auditor('s) Report"
 *                    financial-statement apparatus. GUARD: never flag a research title that
 *                    merely mentions auditors (e.g. "Independent auditors, bias, and political agency").
 *
 * Usage:
 *   node --env-file=.env scripts/apply-nonresearch-denylist-2026-06-22.mjs --dry-run
 *   node --env-file=.env scripts/apply-nonresearch-denylist-2026-06-22.mjs --apply --clusters=nobel_lecture,auditor_report
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'non_research_2026_06_22';
const clusterArg = (process.argv.find(a => a.startsWith('--clusters=')) || '').split('=')[1];
const ONLY = clusterArg ? new Set(clusterArg.split(',').map(s => s.trim())) : null;
const cleanTitle = (t) => (t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const CLUSTERS = [
  {
    id: 'nobel_lecture',
    desc: 'Nobel laureate lectures ("Nobel Lecture: ...")',
    captures: ['%nobel lecture%', '%nobel memorial lecture%', '%prize lecture%'],
    match: (t) => {
      const s = t.toLowerCase();
      return /\bnobel( memorial)? lecture\b/.test(s)
        || /\bnobel prize lecture\b/.test(s)
        || /\bsveriges riksbank prize.*lecture\b/.test(s);
    },
  },
  {
    id: 'auditor_report',
    desc: 'Independent-auditor financial-statement reports (apparatus)',
    captures: ['%independent auditor%report%', 'report of independent auditor%', '%auditor%report%audited%', '%audited financial statement%'],
    match: (t) => {
      const s = t.toLowerCase().replace(/[’]/g, "'").trim();
      // RESEARCH GUARD: a sentence-like title that discusses auditors is NOT the report apparatus
      if (/\b(bias|agency|evidence|effect|impact|role|quality|market|incentive|analysis|determinant|relationship|fraud|disclosure|earnings|governance|firm|conservatism|litigation)\b/.test(s)) return false;
      // anchored apparatus forms only
      return /^report of (the )?independent auditors?$/.test(s)
        || /^independent auditors?'? report$/.test(s)
        || /^report of independent auditors?\b/.test(s)
        || /^independent auditors?'? report\b/.test(s)
        || /^auditors?'? report\/audited financial statements?$/.test(s);
    },
  },
];

async function capture(c) {
  const seen = new Map();
  for (const pat of c.captures) {
    let offset = 0;
    while (true) {
      const { data, error } = await sb.from('works')
        .select('id,title,venue,citation_count,year,authors,canonical_doi,is_noise,canonical_work_id')
        .is('canonical_work_id', null).not('is_noise', 'is', true)
        .ilike('title', pat).range(offset, offset + 999);
      if (error) { console.error(`  ERR [${c.id}] ${pat}: ${error.message}`); break; }
      for (const r of (data || [])) seen.set(r.id, r);
      if (!data || data.length < 1000) break;
      offset += 1000;
    }
  }
  const matched = [];
  for (const r of seen.values()) { const t = cleanTitle(r.title); if (t && c.match(t)) matched.push({ ...r, _clean: t }); }
  return matched;
}

(async () => {
  console.log(`=== NON-RESEARCH DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===\n`);
  const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, clusters: {} };
  const all = {};
  for (const c of CLUSTERS) {
    const m = await capture(c);
    all[c.id] = m;
    console.log(`\n#### ${c.id} — ${m.length} candidates\n  ${c.desc}`);
    for (const r of m.slice(0, 20)) console.log(`  [c${String(r.citation_count ?? '-').padStart(4)}] ${String(r.year ?? '-').padStart(4)} | auth=${Array.isArray(r.authors) ? r.authors.length : 0} | ${r._clean.slice(0, 66)}`);
    report.clusters[c.id] = { desc: c.desc, count: m.length, all: m.map(r => ({ id: r.id, title: r._clean, year: r.year, citation_count: r.citation_count })) };
  }
  console.log('\n=== SUMMARY ==='); for (const c of CLUSTERS) console.log(`  ${String(all[c.id].length).padStart(5)} | ${c.id}`);

  if (!APPLY) { fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync('reports/nonresearch-denylist-dryrun-2026-06-22.json', JSON.stringify(report, null, 2)); console.log('\nDRY-RUN report: reports/nonresearch-denylist-dryrun-2026-06-22.json'); return; }
  if (!ONLY) { console.error('\n--apply requires --clusters=<comma list>'); process.exit(1); }

  const byId = new Map(CLUSTERS.map(c => [c.id, c]));
  const toApply = [];
  for (const c of CLUSTERS) if (ONLY.has(c.id)) for (const r of all[c.id]) toApply.push({ ...r, _cluster: c.id });
  const dedup = new Map(); for (const r of toApply) if (!dedup.has(r.id)) dedup.set(r.id, r);
  const flagged = [...dedup.values()];
  console.log(`\n=== APPLYING ${flagged.length} rows from [${[...ONLY].join(', ')}] ===`);
  let denylisted = 0, flaggedW = 0, skip = 0, errs = 0;
  for (const batch of chunk(flagged, 75)) {
    const ids = batch.map(r => r.id);
    const { data: live, error } = await sb.from('works').select('id,title,is_noise,canonical_work_id').in('id', ids);
    if (error) { console.error('refetch', error.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));
    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r || r.is_noise === true || r.canonical_work_id != null) { skip++; continue; }
      if (!byId.get(t._cluster).match(cleanTitle(r.title))) { skip++; continue; }
      const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: t.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
      if (e1) { console.error('denylist', t.id, e1.message); errs++; continue; }
      denylisted++;
      const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', t.id);
      if (e2) { console.error('works', t.id, e2.message); errs++; continue; }
      flaggedW++;
    }
    console.log(`  ...flagged ${flaggedW}, skipped ${skip}, err ${errs}`);
  }
  report.result = { applied_clusters: [...ONLY], denylisted, works_flagged: flaggedW, skipped: skip, errors: errs };
  fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync('reports/nonresearch-denylist-apply-2026-06-22.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED === flagged=${flaggedW} skipped=${skip} errors=${errs}`);
})();
