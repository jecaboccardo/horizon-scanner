#!/usr/bin/env node
/**
 * Flag non-article apparatus in UChicago econ venues (JPE/EDCC/JLE) as noise:
 *   - placeholder-title records (title === venue name / empty)  -> issue-TOC junk
 *   - book reviews  (EDCC: "<i>book</i>", price/pages, "reviewed by")
 *   - prize/society/editorial notices (JLE: "X Prize", "Society of Labor Economists", "Officers of")
 * Conservative: a research-protect guard spares anything that looks like a real paper.
 * DRY-RUN by default; --apply to commit (is_noise + noise_reason + embedding=null + corpus_denylist).
 * Golden-rule-safe: only those 3 mutations + a denylist upsert.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'uchicago_nonarticle_2026_06_25';
const VENUES = ['Journal of Political Economy', 'Economic Development and Cultural Change', 'Journal of Labor Economics'];
const clean = s => (s || '').replace(/\s+/g, ' ').trim();

// research-protect: a verb/quantifier/colon-subtitle that real papers have; spares false hits
const looksResearch = t => /\b(evidence|effect|impact|estimat|causal|model|analysis|theory|determinant|wage|growth|market|policy|reform|experiment|household|productivity|investment|elasticity|welfare|inequality|migration|trade|tax|labor|education|institution)\b/i.test(t);

function classify(title, venue) {
  const t = clean(title);
  // placeholder = title missing/equals venue name. NOT noise — many are real highly-cited
  // papers whose title wasn't ingested. They need a TITLE backfill, not denylisting.
  if (!t || t.toLowerCase() === venue.toLowerCase()) return 'placeholder';
  // spare substantive "review essays" (citable scholarly commentary, not a book-review notice)
  if (/review essay/i.test(t)) return 'keep';
  // book review — HARD citation markers only (no research title carries these):
  //   page count "Pp. 428", a price "$39.95 / £55 / DM 158", or a leading "REVIEW".
  if (/^REVIEW\b/.test(t) || /\bPp\.\s*[ivxlcdm\d]/i.test(t) || /(?:[$£€]\s?\d|\bDM\s*\d)/.test(t)) return 'book_review';
  // book review — structural: STARTS with an italic book title then ". Author Name", not a research title.
  if (/^<i>[^<]{12,}<\/i>\.?\s*[A-Z][a-zA-Z.\-‐’' ]+$/.test(t) && !looksResearch(t)) return 'book_review';
  // prize / society / editorial apparatus (anchored — not a paper ABOUT prizes)
  if (/\b(Prize|Award)$/.test(t) && t.length < 40 && !looksResearch(t)) return 'apparatus';
  if (/^Officers of\b|Society of Labor Economists|^In Memoriam|^Obituary|^Editorial\b|^Erratum|^Corrigendum|^Correction\b|^Front Matter|^Back Matter|Index to Volume|^Volume \d+ .*Index|^Report of the Editor|^Acknowledg|^Notes? for Contributors|^Editor.s Note/i.test(t) && !looksResearch(t)) return 'apparatus';
  return 'keep';
}

const rows = [];
for (const v of VENUES) {
  let cursor = null;
  while (true) {
    let q = sb.from('works').select('id,title,year,citation_count,is_noise,canonical_work_id')
      .is('canonical_work_id', null).not('is_noise', 'is', true).ilike('venue', v).ilike('id', '10.1086/%').order('id').limit(1000);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) { console.error('load', v, error.message); break; }
    if (!data?.length) break;
    for (const r of data) rows.push({ ...r, venue: v });
    cursor = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
}

const buckets = { placeholder: [], book_review: [], apparatus: [], keep: [] };
for (const r of rows) buckets[classify(r.title, r.venue)].push(r);
// placeholders are NOT noised (real papers w/ missing titles → title-backfill instead)
const flag = [...buckets.book_review, ...buckets.apparatus];

console.log(`=== UChicago non-article denylist (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===`);
console.log(`scanned ${rows.length} JPE/EDCC/JLE rows`);
for (const k of ['placeholder', 'book_review', 'apparatus']) {
  console.log(`\n${k}: ${buckets[k].length}`);
  buckets[k].slice(0, 6).forEach(r => console.log(`   • [${r.venue.slice(0, 4)} ${r.year}] ${clean(r.title).slice(0, 70) || '(empty)'}`));
}
// high-citation flagged rows = red flags worth eyeballing (a real paper shouldn't be flagged)
const hot = flag.filter(r => (r.citation_count || 0) >= 30).sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
console.log(`\n⚠ flagged rows with >=30 citations (verify NOT real research): ${hot.length}`);
hot.slice(0, 12).forEach(r => console.log(`   • cit=${r.citation_count} [${r.venue.slice(0, 4)}] ${clean(r.title).slice(0, 70)}`));
console.log(`\nTOTAL to flag: ${flag.length}  | keep: ${buckets.keep.length}`);

if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply to commit.'); process.exit(0); }

let done = 0, err = 0;
for (const r of flag) {
  const { error: e1 } = await sb.from('corpus_denylist').upsert({ work_id: r.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
  const { error: e2 } = await sb.from('works').update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', r.id);
  if (e1 || e2) { err++; if (err <= 3) console.error('  err', r.id, (e1 || e2).message); } else done++;
  if (done % 100 === 0) process.stdout.write(`\r  flagged ${done}/${flag.length}`);
}
console.log(`\nAPPLIED. flagged=${done} errors=${err} (reason=${REASON})`);
