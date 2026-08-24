#!/usr/bin/env node
/**
 * Resolve the "See abstract at: <doi-link>" placeholder rows in papers_metadata3.xlsx
 * to real abstract text via free resolvers (OpenAlex inverted-index → Crossref JATS).
 * Gap-only (golden rule): only writes where the matched corpus row has a NULL abstract.
 * Writes reports/abstracts-from-xlsx-filled-ids-md3-links.json for the deferred re-embed.
 *
 * Usage: node --env-file=.env scripts/fill-abstracts-md3-links.mjs [--dry-run] [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY = process.argv.includes('--dry-run');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();
const MAILTO = 'horizon-scanner@iadb.org';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const norm = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
const PLACEHOLDER = /no abstract|book review|not available|see abstract at|^n\/?a$/i;
const clean = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ok = a => a && a.length >= 80 && !PLACEHOLDER.test(a);

const dois = JSON.parse(fs.readFileSync('reports/_md3-link-dois.json', 'utf8'));

// ---- gap-check: doi -> work id, abstract IS NULL, non-noise canonical ----
const gap = new Map();
const matchedById = new Set();
for (const b of chunk(dois, 200)) {
  const { data } = await sb.from('works').select('id, abstract, is_noise, canonical_work_id').in('id', b);
  for (const r of (data || [])) { matchedById.add(r.id.toLowerCase()); if (r.canonical_work_id || r.is_noise || r.abstract != null) continue; gap.set(r.id.toLowerCase(), r.id); }
}
const unmatched = dois.filter(d => !matchedById.has(d));
for (const b of chunk(unmatched, 200)) {
  const { data } = await sb.from('works').select('id, canonical_doi, abstract, is_noise, canonical_work_id').in('canonical_doi', b);
  for (const r of (data || [])) { if (r.canonical_work_id || r.is_noise || r.abstract != null) continue; gap.set(norm(r.canonical_doi), r.id); }
}
let gapDois = [...gap.keys()];
if (Number.isFinite(LIMIT)) gapDois = gapDois.slice(0, LIMIT);
console.log(`link DOIs ${dois.length} | NULL-abstract gaps to resolve: ${gapDois.length}\n`);

const resolved = new Map(); // doi -> abstract
// NOTE (2026-06-23): the Elsevier API key is metadata-only (no dc:description) and
// Crossref carries no Elsevier abstracts — both yield 0 on this set. OpenAlex
// (abstract_inverted_index) is the only free resolver that returns Elsevier abstract
// TEXT, but it is now metered: a 150-DOI run needs OA budget (resets midnight UTC).
function reconstruct(inv) { if (!inv) return null; const w = []; for (const [word, ps] of Object.entries(inv)) for (const p of ps) w[p] = word; return clean(w.join(' ')); }
async function oaBatch(batch, tries = 0) {
  const url = `https://api.openalex.org/works?filter=doi:${batch.join('|')}&per-page=50&mailto=${MAILTO}&select=doi,abstract_inverted_index`;
  const r = await fetch(url);
  if (r.status === 429) { if (tries > 5) return; await sleep(2000 * (tries + 1)); return oaBatch(batch, tries + 1); }
  if (!r.ok) return;
  const j = await r.json();
  if (j?.error || j?.message) { console.log('  OA:', j.error || j.message); return; }
  for (const w of (j.results || [])) { const d = norm(w.doi); const ab = reconstruct(w.abstract_inverted_index); if (d && ok(ab)) resolved.set(d, ab); }
}
async function crossref(doi) {
  try { const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`);
    if (!r.ok) return null; const j = await r.json(); return clean(j?.message?.abstract); } catch { return null; }
}
let n = 0;
for (const b of chunk(gapDois, 25)) { await oaBatch(b); n += b.length; await sleep(400); console.log(`  OA ...${n}/${gapDois.length} resolved ${resolved.size}`); }
for (const d of gapDois.filter(x => !resolved.has(x))) { const ab = await crossref(d); if (ok(ab)) resolved.set(d, ab); await sleep(120); }
console.log(`\nresolved: ${resolved.size}/${gapDois.length}`);

// ---- write (gap-only) ----
let filled = 0; const filledIds = [];
for (const [d, ab] of resolved) {
  const id = gap.get(d); if (!id) continue;
  if (DRY) { filled++; filledIds.push(id); continue; }
  const { error } = await sb.from('works').update({ abstract: ab }).eq('id', id).is('abstract', null);
  if (!error) { filled++; filledIds.push(id); }
}
if (!DRY) { fs.writeFileSync('reports/abstracts-from-xlsx-filled-ids-md3-links.json', JSON.stringify(filledIds, null, 2)); console.log(`\nFilled ${filled} -> reports/abstracts-from-xlsx-filled-ids-md3-links.json [re-embed deferred]`); }
else console.log(`\n[dry-run] would fill ${filled}.`);
