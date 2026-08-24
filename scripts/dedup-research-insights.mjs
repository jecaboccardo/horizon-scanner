#!/usr/bin/env node
/**
 * Dedup Stage 1 — link IDB "Research Insights:" briefs to their parent study.
 *
 * These are IDB 2-page summaries of a fuller working paper / journal article
 * (the Keefer triple-count pattern from Sebastian's feedback). The brief should
 * be a SHADOW of the fuller work: brief.canonical_work_id -> parent, parent stays
 * canonical (retrieval drops canonical_work_id != null).
 *
 * Matching (high precision — never cluster different studies):
 *   candidates = works sharing >=1 exact author with the brief, within a year
 *   window, not themselves a brief, not already a shadow. Scored by embedding
 *   COSINE (a brief's text is semantically near its parent) and VERIFIED by
 *   normalized author-surname overlap. A pair is a match only when BOTH the
 *   cosine and the author overlap clear their thresholds.
 *
 * REPORT mode (default): writes reports/dedup-research-insights.jsonl +
 *   -summary.json. No DB writes. Review the distribution before --apply.
 * APPLY mode (--apply): for rows still unlinked, sets brief.canonical_work_id =
 *   parent.id. Golden rule: only sets the shadow pointer, never edits the parent.
 *
 * Usage:
 *   node --env-file=.env scripts/dedup-research-insights.mjs            # report
 *   node --env-file=.env scripts/dedup-research-insights.mjs --limit 20 # sample
 *   node --env-file=.env scripts/dedup-research-insights.mjs --apply    # apply matches
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APPLY = args.includes('--apply');
const LIMIT = parseInt(flag('--limit', '0')) || Infinity;

// Match thresholds (a pair must clear BOTH). Tuned conservatively; review the
// report distribution before trusting them.
const COSINE_MATCH = 0.82;
const COSINE_REVIEW = 0.72;      // 0.72–0.82 → surfaced for manual review, not auto-applied
const AUTHOR_OVERLAP_MIN = 0.6;  // >=60% of the brief's authors present on the parent
const YEAR_BACK = 6, YEAR_FWD = 1;

const JSONL = 'reports/dedup-research-insights.jsonl';
const SUMMARY = 'reports/dedup-research-insights-summary.json';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const REST = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function surname(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.includes(',')) return n.split(',')[0].trim().toLowerCase();
  const p = n.split(/\s+/);
  return (p[p.length - 1] || '').toLowerCase();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function toAuthors(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch {} return [v]; }
  return [];
}
// Fraction of the BRIEF's author surnames that appear on the candidate.
function authorOverlap(briefAuthors, candAuthors) {
  const b = [...new Set(briefAuthors.map(a => norm(surname(a))).filter(Boolean))];
  if (!b.length) return { frac: 0, shared: 0 };
  const c = new Set(candAuthors.map(a => norm(surname(a))).filter(Boolean));
  const shared = b.filter(s => c.has(s)).length;
  return { frac: shared / b.length, shared };
}
function parseVec(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function tokens(s) { return new Set(norm(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4)); }
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
// "Research Insights: How Do Economic Crises Affect ...?" -> topical stem
function briefStem(title) {
  return String(title || '').replace(/^research insights:\s*/i, '').replace(/\s*\(en\)\s*$/i, '').replace(/\?+$/, '');
}

async function get(path) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(REST + path, { headers: H }); if (r.ok) return await r.json(); if (r.status >= 500) { await sleep(1500 * (a + 1)); continue; } return []; }
    catch { await sleep(1500 * (a + 1)); }
  }
  return [];
}

async function loadBriefs() {
  const rows = [];
  let from = 0;
  for (;;) {
    const page = await get(`/works?title=ilike.Research Insights:*&is_noise=not.is.true&canonical_work_id=is.null&select=id,title,authors,year,abstract,embedding&order=id&limit=1000&offset=${from}`);
    if (!page.length) break;
    rows.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  return rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
}

async function candidatesFor(brief) {
  const authors = toAuthors(brief.authors);
  const yLo = (brief.year || 1900) - YEAR_BACK, yHi = (brief.year || 2100) + YEAR_FWD;
  const seen = new Map();
  // Query by each author (jsonb contains), cap authors probed at 4.
  for (const a of authors.slice(0, 4)) {
    const enc = encodeURIComponent(JSON.stringify([a]));
    const page = await get(`/works?authors=cs.${enc}&title=not.ilike.Research Insights:*&canonical_work_id=is.null&is_noise=not.is.true&year=gte.${yLo}&year=lte.${yHi}&select=id,title,authors,year,venue,publication_type&limit=60`);
    for (const w of page) if (w.id !== brief.id && !seen.has(w.id)) seen.set(w.id, w);
  }
  return [...seen.values()];
}

async function embedsFor(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).map(encodeURIComponent).join(',');
    const page = await get(`/works?id=in.(${chunk})&select=id,embedding,abstract`);
    for (const w of page) out.set(w.id, w);
  }
  return out;
}

async function report() {
  console.log('=== Dedup Stage 1: Research Insights briefs (REPORT) ===');
  const briefs = await loadBriefs();
  console.log(`Briefs to match: ${briefs.length}`);
  fs.mkdirSync('reports', { recursive: true });
  const out = fs.createWriteStream(JSONL);
  const counts = { match: 0, review: 0, no_match: 0, no_candidates: 0, no_embedding: 0 };

  let n = 0;
  for (const brief of briefs) {
    n++;
    const briefVec = parseVec(brief.embedding);
    const briefAuthors = toAuthors(brief.authors);
    const cands = await candidatesFor(brief);
    if (!cands.length) { counts.no_candidates++; out.write(JSON.stringify({ brief_id: brief.id, outcome: 'no_candidates', title: briefStem(brief.title).slice(0, 90) }) + '\n'); continue; }

    // Lite pre-rank by author overlap + title-stem similarity; keep top 12 for embed fetch.
    const stem = briefStem(brief.title);
    const lite = cands.map(c => {
      const ov = authorOverlap(briefAuthors, toAuthors(c.authors));
      return { c, ov, titleSim: jaccard(stem, c.title) };
    }).filter(x => x.ov.frac >= AUTHOR_OVERLAP_MIN)  // author gate up front
      .sort((a, b) => (b.ov.frac + b.titleSim) - (a.ov.frac + a.titleSim))
      .slice(0, 12);
    if (!lite.length) { counts.no_match++; out.write(JSON.stringify({ brief_id: brief.id, outcome: 'no_match', reason: 'no candidate cleared author overlap', title: stem.slice(0, 90) }) + '\n'); continue; }

    if (!briefVec) { counts.no_embedding++; out.write(JSON.stringify({ brief_id: brief.id, outcome: 'no_embedding', title: stem.slice(0, 90) }) + '\n'); continue; }
    const emb = await embedsFor(lite.map(x => x.c.id));
    let best = null;
    for (const x of lite) {
      const e = emb.get(x.c.id);
      const cos = cosine(briefVec, parseVec(e?.embedding));
      const abJac = jaccard(brief.abstract, e?.abstract);
      const cand = { ...x, cos, abJac };
      if (!best || cos > best.cos) best = cand;
    }

    const outcome = (best.cos >= COSINE_MATCH && best.ov.frac >= AUTHOR_OVERLAP_MIN) ? 'match'
      : (best.cos >= COSINE_REVIEW) ? 'review' : 'no_match';
    counts[outcome]++;
    out.write(JSON.stringify({
      brief_id: brief.id, parent_id: best.c.id, outcome,
      cosine: +best.cos.toFixed(3), author_overlap: +best.ov.frac.toFixed(2), shared_authors: best.ov.shared,
      abstract_jaccard: +best.abJac.toFixed(3),
      brief_title: stem.slice(0, 90), brief_year: brief.year,
      parent_title: String(best.c.title).slice(0, 90), parent_year: best.c.year,
      parent_type: best.c.publication_type, parent_venue: best.c.venue,
    }) + '\n');
    if (n % 20 === 0) process.stdout.write(`\r  ${n}/${briefs.length} | match ${counts.match} review ${counts.review} no ${counts.no_match}`);
    await sleep(60);
  }
  out.end();
  const summary = { generated_at: new Date().toISOString(), briefs: briefs.length, thresholds: { COSINE_MATCH, COSINE_REVIEW, AUTHOR_OVERLAP_MIN }, counts };
  fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  console.log('\n\nSummary:', JSON.stringify(summary, null, 2));
  console.log(`\nDetail: ${JSONL} — review 'match' + 'review' rows, then --apply.`);
}

async function apply() {
  console.log('=== Dedup Stage 1 (APPLY) ===');
  if (!fs.existsSync(JSONL)) { console.error('No report — run report mode first.'); process.exit(1); }
  const rows = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.outcome === 'match');
  console.log(`Matches to apply: ${rows.length}`);
  let linked = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    // Re-read: only link if the brief is still an unlinked non-shadow and the parent is canonical.
    const [brief] = await get(`/works?id=eq.${encodeURIComponent(r.brief_id)}&select=id,canonical_work_id`);
    const [parent] = await get(`/works?id=eq.${encodeURIComponent(r.parent_id)}&select=id,canonical_work_id`);
    if (!brief || !parent) { errors++; continue; }
    if (brief.canonical_work_id || parent.canonical_work_id) { skipped++; continue; }  // already linked / parent is itself a shadow
    const { error } = await sb.from('works').update({ canonical_work_id: r.parent_id }).eq('id', r.brief_id);
    if (error) errors++; else linked++;
  }
  const summary = { applied_at: new Date().toISOString(), linked, skipped, errors };
  console.log('Done:', JSON.stringify(summary, null, 2));
  fs.writeFileSync('reports/dedup-research-insights-apply.json', JSON.stringify(summary, null, 2));
}

(APPLY ? apply() : report()).catch(e => { console.error('Fatal:', e); process.exit(1); });
