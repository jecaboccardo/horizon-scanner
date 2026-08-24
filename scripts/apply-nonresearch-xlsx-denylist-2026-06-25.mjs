#!/usr/bin/env node
/**
 * Non-research apparatus denylist from papers_with_abstracts_new_session.xlsx.
 *
 * The xlsx `Venue2` column explicitly TYPES each row. Everything that is NOT a real
 * research item (Article / Working Paper) is journal apparatus we should flag as noise:
 *   Book Review · Journal Information · Note to Editor · Announcement ·
 *   Annual Data/Index · Award · Presidential Address · Editorial · Dissertation Listing
 *
 * These rows carry NO DOI in the file, so they are matched to the corpus by
 * EXACT normalized title + venue (JPAM/JPE). Generic recurring titles ("Notes from the
 * Editor", "APPAM Announcements") legitimately match many corpus rows across volumes —
 * all of them are apparatus, so all year-instances are flagged.
 *
 * GUARDS (verify-before-flag):
 *   - venue must contain the file row's journal (JPAM / Journal of Political Economy)
 *   - RESEARCH GUARD: skip any corpus row with a NON-NULL abstract (apparatus has none;
 *     a populated abstract ⇒ probable real article / mislabel → keep).
 *   - CITATION GUARD: skip (and report) any row with citation_count >= CITE_GUARD (30) —
 *     a real apparatus item is ~uncited; high cites ⇒ eyeball, don't auto-flag.
 *   - skip already-noise / shadow rows. Presidential Address kept out of auto-flag set
 *     when it has an abstract or cites (substantive addresses are real content).
 *
 * DESTRUCTIVE on --apply: is_noise=true, noise_reason, embedding=null (active qwen-768
 * column) + corpus_denylist upsert. Dry-run by default. Per-row re-check before write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-2026-06-25.mjs --dry-run
 *   node --env-file=.env scripts/apply-nonresearch-xlsx-denylist-2026-06-25.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import XLSX from 'xlsx';
import fs from 'node:fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const fileArg = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();
const XLSX_PATH = fileArg || 'D:/Downloads/papers_with_abstracts_new_session.xlsx';
const REASON = 'nonresearch_apparatus_xlsx_2026_06_25';
const CITE_GUARD = 30;

const APPARATUS = new Set(['Journal Information', 'Book Review', 'Note to Editor', 'Announcement', 'Annual Data/Index', 'Award', 'Presidential Address', 'Editorial', 'Dissertation Listing']);
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normVen = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const xrows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

// unique (title, venue, type) apparatus tuples from the file
const seen = new Set();
const appTuples = [];
for (const r of xrows) {
  const type = String(r.Venue2 ?? '').trim();
  if (!APPARATUS.has(type)) continue;
  const nt = normTitle(r.Title);
  if (nt.length < 6) continue; // too-generic / empty title — unsafe to match
  const nv = normVen(r.Venue);
  const key = `${nt}__${nv}`;
  if (seen.has(key)) continue;
  seen.add(key);
  appTuples.push({ title: String(r.Title).trim(), normTitle: nt, normVen: nv, venue: String(r.Venue).trim(), type });
}
console.log(`apparatus tuples (unique title+venue): ${appTuples.length} from ${xrows.length} file rows\n`);

// For each tuple, find exact-title corpus rows whose venue matches.
const candidates = [];     // rows to flag
const hotRows = [];        // >= CITE_GUARD — reported, NOT flagged
const skip = { abstract: 0, noise: 0, shadow: 0, venueMismatch: 0, noMatch: 0, hot: 0, placeholder: 0 };
const flaggedIds = new Set();

for (const t of appTuples) {
  // Exact ilike on a truncated probe MISSES long titles (book reviews); use a PREFIX
  // wildcard on the first chars, then filter to exact normalized-title equality.
  const probe = t.title.replace(/[%_]/g, ' ').slice(0, 55) + '%';
  const { data, error } = await sb.from('works')
    .select('id,title,venue,abstract,is_noise,canonical_work_id,citation_count,publication_type')
    .ilike('title', probe).limit(120);
  if (error) { console.error('select', error.message, '::', t.title.slice(0, 50)); continue; }
  const exact = (data || []).filter((w) => normTitle(w.title) === t.normTitle);
  if (!exact.length) { skip.noMatch++; continue; }
  let anyVenue = false;
  for (const w of exact) {
    const wv = normVen(w.venue);
    // venue must overlap (file venue contained in corpus venue or vice-versa)
    if (!(wv && (wv.includes(t.normVen) || t.normVen.includes(wv)))) { continue; }
    anyVenue = true;
    // PLACEHOLDER-TITLE GUARD: title === venue name = a real paper whose title wasn't
    // ingested (per corpus rule + uchicago pass) — NEVER noise; it needs a title backfill.
    if (normTitle(w.title) === wv) { skip.placeholder = (skip.placeholder || 0) + 1; continue; }
    if (w.is_noise === true) { skip.noise++; continue; }
    if (w.canonical_work_id != null) { skip.shadow++; continue; }
    if (w.abstract != null) { skip.abstract++; continue; }     // RESEARCH GUARD
    if ((w.citation_count || 0) >= CITE_GUARD) { skip.hot++; hotRows.push({ ...w, fileType: t.type }); continue; }
    if (flaggedIds.has(w.id)) continue;
    flaggedIds.add(w.id);
    candidates.push({ id: w.id, title: w.title, venue: w.venue, citation_count: w.citation_count, publication_type: w.publication_type, fileType: t.type });
  }
  if (!anyVenue) skip.venueMismatch++;
}

const byType = {}; for (const c of candidates) byType[c.fileType] = (byType[c.fileType] || 0) + 1;
console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} — reason=${REASON} ===`);
console.log(`TO FLAG: ${candidates.length}  ${JSON.stringify(byType)}`);
console.log(`skipped — abstract(guard):${skip.abstract} placeholderTitle:${skip.placeholder} alreadyNoise:${skip.noise} shadow:${skip.shadow} venueMismatch:${skip.venueMismatch} noTitleMatch:${skip.noMatch} hot>=${CITE_GUARD}cit:${skip.hot}\n`);

console.log('=== TITLE-VERIFY (sample of corpus rows to be flagged) ===');
for (const c of candidates.slice(0, 40)) console.log(`  [${c.fileType}] cit=${c.citation_count || 0} ${String(c.title).slice(0, 72)}`);
if (candidates.length > 40) console.log(`  … +${candidates.length - 40} more (see report json)`);

if (hotRows.length) {
  console.log(`\n⚠ HIGH-CITE rows matching an apparatus title — NOT flagged, eyeball these:`);
  hotRows.sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0)).slice(0, 15)
    .forEach((r) => console.log(`   • cit=${r.citation_count} [${r.fileType}] ${String(r.title).slice(0, 70)}`));
}

const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, file: XLSX_PATH, byType, toFlag: candidates.length, skipped: skip, hotRows: hotRows.map((r) => ({ id: r.id, cit: r.citation_count, type: r.fileType, title: r.title })), ids: candidates };
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(`reports/nonresearch-xlsx-denylist-${APPLY ? 'apply' : 'dryrun'}-2026-06-25.json`, JSON.stringify(report, null, 2));

if (!APPLY) { console.log(`\nDRY-RUN report -> reports/nonresearch-xlsx-denylist-dryrun-2026-06-25.json (no writes)`); process.exit(0); }

console.log(`\n=== APPLYING ${candidates.length} ===`);
let denylisted = 0, flagged = 0, reskip = 0, errs = 0;
for (const batch of chunk(candidates, 75)) {
  const ids = batch.map((c) => c.id);
  const { data: live, error } = await sb.from('works').select('id,abstract,is_noise,canonical_work_id,citation_count').in('id', ids);
  if (error) { console.error('refetch', error.message); errs += batch.length; continue; }
  const liveById = new Map((live || []).map((r) => [r.id, r]));
  for (const c of batch) {
    const r = liveById.get(c.id);
    if (!r || r.is_noise === true || r.canonical_work_id != null || r.abstract != null || (r.citation_count || 0) >= CITE_GUARD) { reskip++; continue; } // re-guard
    const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: c.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
    if (e1) { console.error('denylist', c.id, e1.message); errs++; continue; }
    denylisted++;
    const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', c.id);
    if (e2) { console.error('works', c.id, e2.message); errs++; continue; }
    flagged++;
  }
  console.log(`  ...flagged ${flagged}, reskipped ${reskip}, err ${errs}`);
}
report.result = { denylisted, flagged, reskipped: reskip, errors: errs };
fs.writeFileSync(`reports/nonresearch-xlsx-denylist-apply-2026-06-25.json`, JSON.stringify(report, null, 2));
console.log(`\n=== APPLIED === flagged=${flagged} reskipped=${reskip} errors=${errs} (reason=${REASON})`);
