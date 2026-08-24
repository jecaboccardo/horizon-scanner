#!/usr/bin/env node
/**
 * Non-research apparatus denylist from a typed-Venue2 xlsx, matched by DOI.
 *
 * Companion to apply-nonresearch-xlsx-denylist-2026-06-25.mjs (which matches by
 * title+venue for files with no DOIs). This variant matches by DOI (works.id,
 * fallback canonical_doi) — use it when the file HAS DOIs (more reliable).
 *
 * Any row with a NON-BLANK `Venue2` is journal apparatus (Book Review, Discussion,
 * announcements, lists, reports, addresses, thesis-abstract listings, …) → flag
 * is_noise unless a guard spares it.
 *
 * GUARDS (verify-before-flag): skip a corpus row that has a non-null abstract
 * (RESEARCH GUARD — apparatus has none), citation_count >= CITE_GUARD (report, don't
 * auto-flag), is already noise, or is a shadow (canonical_work_id set).
 *
 * DESTRUCTIVE on --apply: is_noise=true, noise_reason, embedding=null + corpus_denylist
 * upsert. Dry-run by default; per-row re-guard before each write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-doi.mjs --file F.xlsx --dry-run
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-doi.mjs --file F.xlsx --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const fileArg = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();
if (!fileArg) { console.error('--file <xlsx> required'); process.exit(1); }
const REASON = 'nonresearch_apparatus_xlsx_2026_06_26';
const CITE_GUARD = 30;
const nd = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const wb = XLSX.read(fs.readFileSync(fileArg), { type: 'buffer' });
const xrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
const typeByDoi = new Map();
for (const r of xrows) { const d = nd(r.DOI); const t = String(r.Venue2 || '').trim(); if (d && t) typeByDoi.set(d, t); }
console.log(`apparatus rows (non-blank Venue2 w/ DOI): ${typeByDoi.size} of ${xrows.length}\n`);

const dois = [...typeByDoi.keys()];
const byId = new Map();
for (const b of chunk(dois, 200)) {
  const { data } = await sb.from('works').select('id,canonical_doi,title,venue,abstract,is_noise,canonical_work_id,citation_count').in('id', b);
  for (const w of (data || [])) byId.set(w.id.toLowerCase(), w);
}
const unmatched = dois.filter((d) => !byId.has(d));
for (const b of chunk(unmatched, 200)) {
  const { data } = await sb.from('works').select('id,canonical_doi,title,venue,abstract,is_noise,canonical_work_id,citation_count').in('canonical_doi', b);
  for (const w of (data || [])) byId.set(nd(w.canonical_doi), w);
}

const candidates = []; const hot = []; const skip = { abstract: 0, noise: 0, shadow: 0, notInCorpus: 0, hot: 0 };
for (const d of dois) {
  const w = byId.get(d);
  if (!w) { skip.notInCorpus++; continue; }
  if (w.is_noise === true) { skip.noise++; continue; }
  if (w.canonical_work_id != null) { skip.shadow++; continue; }
  if (w.abstract != null) { skip.abstract++; continue; }
  if ((w.citation_count || 0) >= CITE_GUARD) { skip.hot++; hot.push({ ...w, fileType: typeByDoi.get(d) }); continue; }
  candidates.push({ id: w.id, title: w.title, venue: w.venue, citation_count: w.citation_count, fileType: typeByDoi.get(d) });
}
const byType = {}; for (const c of candidates) byType[c.fileType] = (byType[c.fileType] || 0) + 1;
console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} — reason=${REASON} ===`);
console.log(`TO FLAG: ${candidates.length}  ${JSON.stringify(byType)}`);
console.log(`skipped — abstract(guard):${skip.abstract} alreadyNoise:${skip.noise} shadow:${skip.shadow} notInCorpus:${skip.notInCorpus} hot>=${CITE_GUARD}cit:${skip.hot}\n`);
if (hot.length) { console.log(`⚠ HIGH-CITE (NOT flagged — eyeball):`); hot.sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0)).slice(0, 15).forEach((r) => console.log(`   cit=${r.citation_count} [${r.fileType}] ${String(r.title).slice(0, 70)}`)); }
fs.writeFileSync(`reports/nonresearch-doi-denylist-${APPLY ? 'apply' : 'dryrun'}.json`, JSON.stringify({ byType, toFlag: candidates.length, skip, hot: hot.map((r) => ({ id: r.id, cit: r.citation_count, type: r.fileType, title: r.title })), ids: candidates }, null, 2));

if (!APPLY) { console.log(`\nDRY-RUN report -> reports/nonresearch-doi-denylist-dryrun.json (no writes)`); process.exit(0); }

let flagged = 0, errs = 0;
for (const batch of chunk(candidates, 75)) {
  const ids = batch.map((c) => c.id);
  const { data: live } = await sb.from('works').select('id,abstract,is_noise,canonical_work_id,citation_count').in('id', ids);
  const liveById = new Map((live || []).map((r) => [r.id, r]));
  for (const c of batch) {
    const r = liveById.get(c.id);
    if (!r || r.is_noise === true || r.canonical_work_id != null || r.abstract != null || (r.citation_count || 0) >= CITE_GUARD) continue;
    const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: c.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
    if (e1) { errs++; continue; }
    const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', c.id);
    if (e2) { errs++; continue; }
    flagged++;
  }
}
console.log(`APPLIED: flagged ${flagged}, errors ${errs}`);
