#!/usr/bin/env node
/**
 * Non-research denylist from a harvested-metadata xlsx (book reviews / letters /
 * editorials / acknowledgments). The xlsx Abstract column explicitly labels each
 * non-research item ("No abstract available (book review | letter/correspondence/
 * editorial | acknowledgment)"). We flag the rows matching those labels.
 *
 * DESTRUCTIVE on --apply: is_noise=true, noise_reason, embedding=null (active qwen-768
 * column), + corpus_denylist upsert. Dry-run by default (title-verify). Per-row re-check.
 *
 * GUARDS (verify-before-flag):
 *   - only kinds {book_review, letter_editorial, acknowledgment} (NOT no_abstract_other —
 *     those are likely Just-Accepted research articles that simply lack a posted abstract).
 *   - RESEARCH GUARD: skip any row whose corpus abstract is NON-NULL (a real article has an
 *     abstract; a book review/letter does not — a populated abstract ⇒ probable mislabel, keep).
 *   - skip already-noise / shadow rows.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-2026-06-23.mjs --file "D:/Downloads/papers_metadata (1).xlsx" --dry-run
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-2026-06-23.mjs --file "D:/Downloads/papers_metadata (1).xlsx" --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const doisArg = (() => { const i = process.argv.indexOf('--dois'); return i >= 0 ? process.argv[i + 1] : null; })();
// DOI list is pre-extracted from the xlsx via Python (node `xlsx` pkg was pruned from
// node_modules by a concurrent session). reports/nonresearch-xlsx-dois-2026-06-23.json.
const DOIS_PATH = doisArg || 'reports/nonresearch-xlsx-dois-2026-06-23.json';
const REASON = 'nonresearch_bookreview_letter_2026_06_23';

const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const want = new Map(); // doi -> {kind, venue, title}
for (const r of JSON.parse(fs.readFileSync(DOIS_PATH, 'utf8'))) { const d = normDoi(r.doi); if (d) want.set(d, { kind: r.kind, venue: r.venue, title: r.title }); }
console.log(`DOI list: ${want.size} non-research candidates (book_review/letter/ack)\n`);

// Match corpus by id then canonical_doi; gather active candidates passing the research guard.
const dois = [...want.keys()];
const candidates = []; const found = new Set();
let alreadyNoise = 0, shadow = 0, hasAbstractSkip = 0, notFound = 0;
async function gather(col) {
  for (const b of chunk(dois.filter((d) => !found.has(d)), 200)) {
    const { data, error } = await sb.from('works').select('id,canonical_doi,title,abstract,is_noise,canonical_work_id,venue').in(col, b);
    if (error) { console.error(`select ${col}:`, error.message); continue; }
    for (const row of (data || [])) {
      const key = want.has(normDoi(row.id)) ? normDoi(row.id) : normDoi(row.canonical_doi);
      if (!key || !want.has(key) || found.has(key)) continue;
      found.add(key);
      if (row.canonical_work_id != null) { shadow++; continue; }
      if (row.is_noise === true) { alreadyNoise++; continue; }
      if (row.abstract != null) { hasAbstractSkip++; continue; } // RESEARCH GUARD
      candidates.push({ id: row.id, title: row.title, venue: row.venue, kind: want.get(key).kind });
    }
  }
}
await gather('id');
await gather('canonical_doi');
notFound = want.size - found.size;

const byKind = {}; for (const c of candidates) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
console.log(`TO FLAG: ${candidates.length}  ${JSON.stringify(byKind)}`);
console.log(`skipped — alreadyNoise:${alreadyNoise} shadow:${shadow} hasAbstract(guard):${hasAbstractSkip} notFound:${notFound}\n`);
console.log('=== TITLE-VERIFY (corpus titles to be flagged) ===');
for (const c of candidates.slice(0, 40)) console.log(`  [${c.kind}] ${String(c.title).slice(0, 78)}`);
if (candidates.length > 40) console.log(`  … +${candidates.length - 40} more (see report json)`);

const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, file: DOIS_PATH, byKind, toFlag: candidates.length, skipped: { alreadyNoise, shadow, hasAbstractSkip, notFound }, ids: candidates.map((c) => ({ id: c.id, kind: c.kind, title: c.title })) };
fs.mkdirSync('reports', { recursive: true });
const tag = APPLY ? 'apply' : 'dryrun';
fs.writeFileSync(`reports/nonresearch-xlsx-denylist-${tag}-2026-06-23.json`, JSON.stringify(report, null, 2));

if (!APPLY) { console.log(`\nDRY-RUN report: reports/nonresearch-xlsx-denylist-dryrun-2026-06-23.json`); }
else {
  console.log(`\n=== APPLYING ${candidates.length} ===`);
  let denylisted = 0, flagged = 0, skip = 0, errs = 0;
  for (const batch of chunk(candidates, 75)) {
    const ids = batch.map((c) => c.id);
    const { data: live, error } = await sb.from('works').select('id,abstract,is_noise,canonical_work_id').in('id', ids);
    if (error) { console.error('refetch', error.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map((r) => [r.id, r]));
    for (const c of batch) {
      const r = liveById.get(c.id);
      if (!r || r.is_noise === true || r.canonical_work_id != null || r.abstract != null) { skip++; continue; } // re-guard
      const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: c.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
      if (e1) { console.error('denylist', c.id, e1.message); errs++; continue; }
      denylisted++;
      const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', c.id);
      if (e2) { console.error('works', c.id, e2.message); errs++; continue; }
      flagged++;
    }
    console.log(`  ...flagged ${flagged}, skipped ${skip}, err ${errs}`);
  }
  report.result = { denylisted, flagged, skipped: skip, errors: errs };
  fs.writeFileSync(`reports/nonresearch-xlsx-denylist-apply-2026-06-23.json`, JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED === flagged=${flagged} skipped=${skip} errors=${errs}`);
}
