#!/usr/bin/env node
/**
 * Dedup Stage 2 (high-precision first) — link working papers to their published
 * journal-article twin.
 *
 * The published article is the version-of-record (canonical); the WP becomes the
 * shadow: wp.canonical_work_id -> article. Retrieval drops canonical_work_id != null.
 *
 * HIGH-PRECISION-FIRST matcher (catches the clean identical-title majority,
 * defers hard retitled/cross-format cases; NEVER clusters different papers):
 *   1. Blocking: normalized-title SIGNATURE (sorted significant tokens, HTML/
 *      punctuation stripped). WP and article must share the exact signature.
 *   2. Verify (BOTH required): embedding cosine >= 0.90 AND author-surname
 *      overlap >= 0.5 (lenient on overlap because WP/article author formats
 *      differ; cosine is the real guard). Article year >= WP year - 1.
 *   3. Generic/short titles (< 4 significant tokens) are skipped — too collision-prone.
 *
 * On apply, if the article has no open_access_pdf_url but the WP does, the WP's
 * free-fulltext URL is copied to the article (gap-fill; golden rule — never
 * overwrite an existing value).
 *
 * REPORT (default): reports/dedup-wp-twins.jsonl + -summary.json. No writes.
 * APPLY (--apply): sets wp.canonical_work_id + optional PDF gap-fill.
 *
 *   node --env-file=.env scripts/dedup-wp-article-twins.mjs [--limit N]
 *   node --env-file=.env scripts/dedup-wp-article-twins.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APPLY = args.includes('--apply');
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;

const COSINE_MATCH = 0.90;
const AUTHOR_OVERLAP_MIN = 0.5;
const MIN_SIG_TOKENS = 4;

const JSONL = 'reports/dedup-wp-twins.jsonl';
const SUMMARY = 'reports/dedup-wp-twins-summary.json';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const REST = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'evidence', 'that', 'this', 'into', 'over', 'under', 'their', 'does', 'what', 'how', 'why', 'when', 'which', 'case', 'study', 'paper', 'using', 'role', 'effect', 'effects', 'impact', 'analysis']);
function normTitle(t) {
  return String(t || '')
    .replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, ' ')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function sigTokens(t) {
  return [...new Set(normTitle(t).split(' ').filter(w => w.length >= 4 && !STOP.has(w)))].sort();
}
function signature(t) {
  const toks = sigTokens(t);
  return toks.length >= MIN_SIG_TOKENS ? toks.join(' ') : null;
}
function surname(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.includes(',')) return n.split(',')[0].trim().toLowerCase();
  const p = n.split(/\s+/); return (p[p.length - 1] || '').toLowerCase();
}
const dnorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function toAuthors(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch {} return [v]; }
  return [];
}
function authorOverlap(a, b) {
  const A = [...new Set(a.map(x => dnorm(surname(x))).filter(Boolean))];
  if (!A.length) return 0;
  const B = new Set(b.map(x => dnorm(surname(x))).filter(Boolean));
  return A.filter(s => B.has(s)).length / A.length;
}
function parseVec(v) { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return null; }
function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }

async function get(path) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(REST + path, { headers: H }); if (r.ok) return await r.json(); if (r.status >= 500) { await sleep(1500 * (a + 1)); continue; } return []; }
    catch { await sleep(1500 * (a + 1)); }
  }
  return [];
}
async function scan(filter, cb) {
  let from = 0;
  for (;;) {
    const page = await get(`/works?${filter}&order=id&limit=1000&offset=${from}`);
    if (!page.length) break;
    for (const w of page) cb(w);
    if (page.length < 1000) break;
    from += 1000;
    if (from % 20000 === 0) process.stdout.write(`\r  scanned ${from}...`);
  }
}
async function embedsFor(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).map(encodeURIComponent).join(',');
    for (const w of await get(`/works?id=in.(${chunk})&select=id,embedding`)) out.set(w.id, parseVec(w.embedding));
  }
  return out;
}

async function report() {
  console.log('=== Dedup Stage 2: WP -> article twins (REPORT, high-precision) ===');
  // 1. Build article signature index.
  const artBySig = new Map();
  console.log('Indexing journal articles by title signature...');
  await scan('publication_type=eq.journal_article&canonical_work_id=is.null&is_noise=not.is.true&select=id,title,authors,year,open_access_pdf_url',
    (w) => { const s = signature(w.title); if (!s) return; if (!artBySig.has(s)) artBySig.set(s, []); const arr = artBySig.get(s); if (arr.length < 8) arr.push(w); });
  console.log(`\nArticle signatures: ${artBySig.size}`);

  // 2. Scan WPs, find same-signature articles.
  const wps = [];
  await scan('publication_type=eq.working_paper&canonical_work_id=is.null&is_noise=not.is.true&select=id,title,authors,year,open_access_pdf_url',
    (w) => { if (wps.length < LIMIT) wps.push(w); });
  console.log(`\nWorking papers: ${wps.length}`);

  // 3. Candidate pairs by signature + author + year gate (pre-embedding).
  const pairs = [];
  for (const wp of wps) {
    const s = signature(wp.title);
    if (!s || !artBySig.has(s)) continue;
    const wpAuthors = toAuthors(wp.authors);
    for (const art of artBySig.get(s)) {
      if (art.id === wp.id) continue;
      if ((art.year ?? 9999) < (wp.year ?? 0) - 1) continue;   // article should not predate WP by >1yr
      const ov = authorOverlap(wpAuthors, toAuthors(art.authors));
      if (ov < AUTHOR_OVERLAP_MIN) continue;
      pairs.push({ wp, art, ov });
    }
  }
  console.log(`Signature+author candidate pairs: ${pairs.length}`);

  // 4. Embedding verification.
  const ids = [...new Set(pairs.flatMap(p => [p.wp.id, p.art.id]))];
  console.log(`Fetching ${ids.length} embeddings...`);
  const emb = await embedsFor(ids);

  fs.mkdirSync('reports', { recursive: true });
  const out = fs.createWriteStream(JSONL);
  const counts = { match: 0, review: 0, low_cosine: 0 };
  const best = new Map(); // wp.id -> best pair (a WP maps to at most ONE article)
  for (const p of pairs) {
    const cos = cosine(emb.get(p.wp.id), emb.get(p.art.id));
    const cur = best.get(p.wp.id);
    if (!cur || cos > cur.cos) best.set(p.wp.id, { ...p, cos });
  }
  for (const p of best.values()) {
    const outcome = (p.cos >= COSINE_MATCH) ? 'match' : (p.cos >= 0.85) ? 'review' : 'low_cosine';
    counts[outcome]++;
    out.write(JSON.stringify({
      wp_id: p.wp.id, article_id: p.art.id, outcome,
      cosine: +p.cos.toFixed(3), author_overlap: +p.ov.toFixed(2),
      wp_title: String(p.wp.title).replace(/<[^>]+>/g, '').slice(0, 90), wp_year: p.wp.year,
      article_title: String(p.art.title).slice(0, 90), article_year: p.art.year,
      wp_has_pdf: !!p.wp.open_access_pdf_url, article_has_pdf: !!p.art.open_access_pdf_url,
    }) + '\n');
  }
  out.end();
  const summary = { generated_at: new Date().toISOString(), working_papers: wps.length, candidate_pairs: pairs.length, thresholds: { COSINE_MATCH, AUTHOR_OVERLAP_MIN, MIN_SIG_TOKENS }, counts };
  fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  console.log(`\nDetail: ${JSONL} — review 'match' rows, then --apply.`);
}

async function apply() {
  console.log('=== Dedup Stage 2 (APPLY) ===');
  if (!fs.existsSync(JSONL)) { console.error('No report — run report mode first.'); process.exit(1); }
  const rows = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.outcome === 'match');
  console.log(`Matches to apply: ${rows.length}`);
  let linked = 0, pdfFilled = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    const [wp] = await get(`/works?id=eq.${encodeURIComponent(r.wp_id)}&select=id,canonical_work_id,open_access_pdf_url`);
    const [art] = await get(`/works?id=eq.${encodeURIComponent(r.article_id)}&select=id,canonical_work_id,open_access_pdf_url`);
    if (!wp || !art) { errors++; continue; }
    if (wp.canonical_work_id || art.canonical_work_id) { skipped++; continue; }
    // Preserve free fulltext: copy WP's PDF to the article if it lacks one (gap-fill).
    if (!art.open_access_pdf_url && wp.open_access_pdf_url) {
      const { error: e2 } = await sb.from('works').update({ open_access_pdf_url: wp.open_access_pdf_url }).eq('id', art.id);
      if (!e2) pdfFilled++;
    }
    const { error } = await sb.from('works').update({ canonical_work_id: r.article_id }).eq('id', r.wp_id);
    if (error) errors++; else linked++;
  }
  const summary = { applied_at: new Date().toISOString(), linked, pdfFilled, skipped, errors };
  console.log('Done:', JSON.stringify(summary, null, 2));
  fs.writeFileSync('reports/dedup-wp-twins-apply.json', JSON.stringify(summary, null, 2));
}

(APPLY ? apply() : report()).catch(e => { console.error('Fatal:', e); process.exit(1); });
