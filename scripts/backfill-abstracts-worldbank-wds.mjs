#!/usr/bin/env node
/**
 * Backfill abstracts for World Bank papers from the World Bank Documents & Reports
 * (WDS) API — the authoritative WB source (OpenAlex/Crossref carry NO abstracts for
 * WB DOIs/series, confirmed 2026-06-25). Matches by TITLE (WB docs/PRWP often have a
 * 10.1596 DOI or a wb: id with no resolvable DOI), verifies a strong title-token
 * overlap before writing, extracts the abstract from `abstracts.cdata!`.
 *
 * Gap-only (golden rule): writes only where the corpus abstract is NULL, canonical,
 * non-noise. Shared quality guard (isRealAbstract/isApparatusTitle). Writes a
 * filled-ids report for the re-embed step.
 *
 * Scope: WB-ish rows missing an abstract — source_family='World Bank' OR id like
 * 'wb:%' OR canonical_doi like '10.1596%'. (Publisher-DOI rows — 10.1093/wber Oxford,
 * 10.1016 Elsevier — are NOT in WDS; they're skipped by the title-match gate anyway.)
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-worldbank-wds.mjs --dry-run
 *   node --env-file=.env scripts/backfill-abstracts-worldbank-wds.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
import { isRealAbstract, isApparatusTitle } from './lib/abstract-quality.mjs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DRY = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'reports/abstracts-worldbank-wds-filled-ids.json';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'from', 'with', 'is', 'are', 'be']);
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
// Jaccard-ish: fraction of the CORPUS title's significant tokens present in the WDS title.
function titleMatch(corpusTitle, wdsTitle) {
  const a = toks(corpusTitle), b = toks(wdsTitle);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0; for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}
const cleanAbs = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^abstract[:\s]*/i, '').trim();

async function wdsLookup(title) {
  const url = `https://search.worldbank.org/api/v2/wds?format=json&rows=5&fl=display_title,abstracts,docdt&qterm=${encodeURIComponent(norm(title).slice(0, 200))}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'horizon-scanner-abstract-backfill' } });
  if (!res.ok) return null;
  const j = await res.json();
  const docs = j.documents || {};
  let best = null, bestScore = 0;
  for (const k of Object.keys(docs)) {
    if (k === 'facets') continue;
    const d = docs[k];
    const wdsTitle = d.display_title || '';
    const score = titleMatch(title, wdsTitle);
    const absRaw = d.abstracts && (d.abstracts['cdata!'] || d.abstracts.cdata);
    if (score > bestScore && absRaw) { best = { abstract: cleanAbs(absRaw), wdsTitle, score }; bestScore = score; }
  }
  return best;
}

const { data: targets, error } = await sb.from('works')
  .select('id, canonical_doi, title, venue, source_family, raw_data')
  .or('source_family.eq.World Bank,id.like.wb:%,canonical_doi.like.10.1596%,venue.ilike.World Bank%')
  .is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true)
  .limit(500);
if (error) { console.error('target fetch:', error.message); process.exit(1); }
console.log(`WB-ish missing-abstract targets: ${targets.length}${DRY ? ' (dry-run)' : ''}\n`);

const MATCH_THRESHOLD = 0.7; // ≥70% of the corpus title's significant tokens in the WDS title
let filled = 0, noMatch = 0, lowMatch = 0, badAbs = 0, errors = 0;
const filledIds = [];
for (const t of targets) {
  if (isApparatusTitle(t.title)) { badAbs++; continue; }
  try {
    const m = await wdsLookup(t.title);
    await sleep(400);
    if (!m) { noMatch++; continue; }
    if (m.score < MATCH_THRESHOLD) { lowMatch++; console.log(`  low-match (${m.score.toFixed(2)}) "${(t.title||'').slice(0,45)}" ~ "${m.wdsTitle.slice(0,45)}"`); continue; }
    if (!isRealAbstract(m.abstract)) { badAbs++; continue; }
    console.log(`  ✓ ${m.score.toFixed(2)} [${m.abstract.length}ch] ${(t.title || '').slice(0, 55)}`);
    if (!DRY) {
      const patch = {
        abstract: m.abstract,
        raw_data: {
          ...(t.raw_data && typeof t.raw_data === 'object' ? t.raw_data : {}),
          abstract_backfill: {
            source: 'worldbank_wds',
            matched_at: new Date().toISOString(),
            title_score: m.score,
            matched_title: m.wdsTitle,
          },
        },
      };
      const { error: e } = await sb.from('works').update(patch).eq('id', t.id);
      if (e) { errors++; continue; }
    }
    filled++; filledIds.push(t.id);
  } catch (e) { errors++; console.error('  err', t.id, e.message); }
}

console.log(`\nfilled: ${filled} | no WDS match: ${noMatch} | low title-match: ${lowMatch} | no/!real abstract: ${badAbs} | errors: ${errors}`);
if (!DRY && filledIds.length) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(filledIds, null, 2));
  console.log(`Filled ids -> ${OUT} (${filledIds.length})  [re-embed next]`);
}
