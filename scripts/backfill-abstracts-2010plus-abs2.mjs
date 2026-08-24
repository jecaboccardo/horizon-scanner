#!/usr/bin/env node
/**
 * Targeted abstract backfill: year >= 2010, ABS/AJG rating 2 or higher, null abstract,
 * canonical non-noise. Same proven multi-source cascade as backfill-abstracts-multisource.mjs
 * (OpenAlex -> Crossref -> Semantic Scholar -> Europe PMC [-> landing page, opt-in]), just
 * scoped + prioritized to this slice. GOLDEN RULE: gap-only, never overwrites an existing
 * abstract or any other curated field; never synthesizes (no LLM recall — see
 * feedback_retrieval_never_clobbers_curated_data / the 2026-07-15 fabricated-abstract incident).
 *
 * ALSO flags likely corpus noise seen along the way (book reviews, editorials, errata, front
 * matter, etc.) using the SAME title/text heuristics as scripts/lib/abstract-quality.mjs
 * (APPARATUS_TITLE_RE / PLACEHOLDER_RE) — this is REPORT-ONLY. Per the denylist-curation
 * agent's verify-before-flag rule, this script NEVER sets is_noise itself; it writes
 * candidates to reports/ for a human (or the denylist-curation agent) to review and apply.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-2010plus-abs2.mjs --dry-run --limit 50
 *   node --env-file=.env scripts/backfill-abstracts-2010plus-abs2.mjs --limit 500
 *   node --env-file=.env scripts/backfill-abstracts-2010plus-abs2.mjs                # full sweep
 *   node --env-file=.env scripts/backfill-abstracts-2010plus-abs2.mjs --unrated-only --dry-run
 *   Flags: --year-min 2010 (default) --min-abs-rating 2|3|4|any (default 2) --landing (opt-in slow source)
 *          --unrated-only (abs_rating IS NULL only — working papers / IDB pubs / unrated
 *            journals, the slice the default rated band excludes; use after the rated
 *            sweep so already-attempted DOIs aren't re-fetched)
 *          --order-by citation_count|year|id (default citation_count desc = highest-value first)
 *          --skip-elsevier (excludes 10.1016/10.1006 DOIs — this script's OpenAlex/Crossref/S2/
 *            EuropePMC cascade rarely has Elsevier abstracts indexed; those need the dedicated
 *            scripts/run-sciencedirect-backfill.ps1 CDP scraper instead. Use this to avoid
 *            burning API calls on a slice this script can't resolve.)
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
import {
  openAlexBatch, crossrefOne, s2One, europePmcOne, landingPageMetaOne,
  openAlexTitleSearch, crossrefTitleSearch, arxivTitleSearch, normDoi, sleep,
} from './lib/abstract-sources.mjs';
import { passesGate } from './lib/matchGate.mjs';
import { isRealAbstract, isApparatusTitle, PLACEHOLDER_RE } from './lib/abstract-quality.mjs';

config();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY_RUN = args.includes('--dry-run');
const NO_LANDING = !args.includes('--landing'); // landing-page scrape measured ~0% recovery; off by default
const SKIP_ELSEVIER = args.includes('--skip-elsevier');
const LIMIT = parseInt(flag('--limit', '0'), 10) || Infinity;
const YEAR_MIN = parseInt(flag('--year-min', '2010'), 10);
// --min-abs-rating 2|3|4 filters to ABS/AJG-rated journals at or above that band.
// 'any' drops the rating filter entirely (working papers, IDB pubs and unrated
// journals have no abs_rating, so the default band silently excludes them);
// --unrated-only targets JUST the unrated slice, so a sweep that already ran the
// rated band doesn't re-burn API calls on DOIs it has attempted.
const MIN_ABS_RATING = flag('--min-abs-rating', '2');
const UNRATED_ONLY = args.includes('--unrated-only');
const ANY_RATING = MIN_ABS_RATING === 'any';
const ABS_RATINGS_ALLOWED = { '2': ['2', '3', '4', '4*'], '3': ['3', '4', '4*'], '4': ['4', '4*'] }[MIN_ABS_RATING] || ['2', '3', '4', '4*'];
// Slice label keeps each band's sidecar + noise report separate (the default
// '2' resolves to 'abs2', preserving the pre-existing filenames).
const SLICE = UNRATED_ONLY ? 'unrated' : ANY_RATING ? 'anyrating' : `abs${MIN_ABS_RATING}`;
const ORDER_BY = ['id', 'year', 'citation_count'].includes(flag('--order-by', 'citation_count')) ? flag('--order-by', 'citation_count') : 'citation_count';

const OA_BATCH = 50;             // OpenAlex pipe-OR batch size
const SLEEP_OA_MS = 120;         // polite ~8 rps to OpenAlex
const SLEEP_SECONDARY_MS = 200;  // per-paper secondary source pacing
const TODAY = new Date().toISOString().slice(0, 10);
const SIDECAR = `reports/abstract-2010plus-${SLICE}-progress-${TODAY}.json`;
const NOISE_REPORT = `reports/noise-candidates-2010plus-${SLICE}-${TODAY}.json`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ─── resumable sidecar ───────────────────────────────────────────────────────
function loadSidecar() {
  try {
    if (fs.existsSync(SIDECAR)) {
      const j = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
      return {
        processed: new Set(j.processed || []),
        filledIds: j.filledIds || [],
        unmatched: j.unmatched || [],
        sourceCounts: j.sourceCounts || {},
        noiseCandidates: j.noiseCandidates || [],
      };
    }
  } catch { /* fresh */ }
  return { processed: new Set(), filledIds: [], unmatched: [], sourceCounts: {}, noiseCandidates: [] };
}
function saveSidecar(s) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(SIDECAR, JSON.stringify({
    updatedAt: new Date().toISOString(),
    processedCount: s.processed.size,
    filledCount: s.filledIds.length,
    unmatchedCount: s.unmatched.length,
    sourceCounts: s.sourceCounts,
    noiseCandidateCount: s.noiseCandidates.length,
    processed: [...s.processed],
    filledIds: s.filledIds,
    unmatched: s.unmatched,
    noiseCandidates: s.noiseCandidates,
  }, null, 2));
}
function saveNoiseReport(s) {
  if (!s.noiseCandidates.length) return;
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(NOISE_REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'REPORT-ONLY — nothing here has been flagged is_noise. Verify each row, then apply via the denylist-curation procedure (scripts/apply-clearcut-denylist.mjs pattern).',
    count: s.noiseCandidates.length,
    candidates: s.noiseCandidates,
  }, null, 2));
}

// ─── noise detection (report-only; mirrors scripts/lib/abstract-quality.mjs) ────────────────
// Title-based: book review / editorial / erratum / front-matter / etc. (APPARATUS_TITLE_RE).
// Text-based: a fetched "abstract" that is itself apparatus text (PLACEHOLDER_RE), even
// though it came back from a real source — this catches e.g. Crossref returning a book-review
// blurb for a review-of-a-book row that slipped past the title check.
function noiseSignal(paper, fetchedText) {
  const reasons = [];
  if (isApparatusTitle(paper.title)) reasons.push('apparatus_title');
  if (fetchedText && PLACEHOLDER_RE.test(String(fetchedText))) reasons.push('apparatus_abstract_text');
  return reasons;
}

// ─── target selection ────────────────────────────────────────────────────────
async function fetchTargets() {
  const rows = [];
  const base = () => {
    let q = sb.from('works')
      .select('id, title, canonical_doi, year, authors, raw_data, abs_rating, citation_count')
      .is('abstract', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .gte('year', YEAR_MIN);
    // Rating scope: unrated-only > any > the rated band (default).
    if (UNRATED_ONLY) q = q.is('abs_rating', null);
    else if (!ANY_RATING) q = q.in('abs_rating', ABS_RATINGS_ALLOWED);
    if (SKIP_ELSEVIER) {
      // 10.1016 / 10.1006 = Elsevier/ScienceDirect DOI prefixes. This script's API cascade
      // (OpenAlex/Crossref/S2/EuropePMC) rarely has these abstracts indexed — route them to
      // the dedicated CDP scraper instead of burning calls on an unresolvable slice.
      q = q.not('canonical_doi', 'ilike', '10.1016/%').not('canonical_doi', 'ilike', '10.1006/%');
    }
    return q;
  };

  if (ORDER_BY === 'citation_count') {
    // citation_count isn't indexed for cursor paging; page via .range() and re-sort client-side
    // is unnecessary here since Postgres sorts server-side — just paginate by offset.
    let offset = 0;
    while (rows.length < LIMIT) {
      const { data, error } = await base()
        .order('citation_count', { ascending: false, nullsFirst: false })
        .range(offset, offset + 999);
      if (error) { console.error('target query:', error.message); break; }
      if (!data?.length) break;
      rows.push(...data);
      offset += 1000;
      if (data.length < 1000) break;
      process.stdout.write(`\r  loading targets… ${rows.length}`);
    }
  } else {
    let cursor = null;
    while (rows.length < LIMIT) {
      let q = base().order('id').range(0, 999);
      if (cursor) q = q.gt('id', cursor);
      const { data, error } = await q;
      if (error) { console.error('target query:', error.message); break; }
      if (!data?.length) break;
      rows.push(...data);
      cursor = data[data.length - 1].id;
      if (data.length < 1000) break;
      process.stdout.write(`\r  loading targets… ${rows.length}`);
    }
  }
  process.stdout.write('\n');
  return rows.slice(0, LIMIT);
}

// ─── cascade per paper (identical order to backfill-abstracts-multisource.mjs) ──────────────
async function resolveAbstract(paper, oaMap) {
  const doi = paper.canonical_doi ? normDoi(paper.canonical_doi) : null;

  if (doi) {
    const oa = oaMap.get(doi);
    if (oa) return { abstract: oa, source: 'openalex', matchedBy: 'doi' };
    const cr = await crossrefOne(doi); await sleep(SLEEP_SECONDARY_MS);
    if (cr) return { abstract: cr, source: 'crossref', matchedBy: 'doi' };
    const s2 = await s2One(doi); await sleep(SLEEP_SECONDARY_MS);
    if (s2) return { abstract: s2, source: 'semantic_scholar', matchedBy: 'doi' };
    const ep = await europePmcOne(doi); await sleep(SLEEP_SECONDARY_MS);
    if (ep) return { abstract: ep, source: 'europepmc', matchedBy: 'doi' };
    if (!NO_LANDING) {
      const lp = await landingPageMetaOne(doi); await sleep(SLEEP_SECONDARY_MS);
      if (lp) return { abstract: lp, source: 'landing_page', matchedBy: 'doi' };
    }
    return null;
  }

  const title = paper.title;
  if (!title || title.length < 10) return null;
  for (const [fn, srcName] of [
    [openAlexTitleSearch, 'openalex_title'],
    [crossrefTitleSearch, 'crossref_title'],
    [arxivTitleSearch, 'arxiv_title'],
  ]) {
    let cands = [];
    try { cands = await fn(title, paper.year); } catch { cands = []; }
    await sleep(SLEEP_SECONDARY_MS);
    for (const c of cands) {
      const g = passesGate(paper, c);
      if (g.ok) return { abstract: c.abstract, source: srcName, matchedBy: 'title', sim: g.sim };
    }
  }
  return null;
}

// ─── gap-only write (provenance merged into raw_data) ────────────────────────
async function writeAbstract(paper, result) {
  const { data: cur, error: rerr } = await sb.from('works')
    .select('abstract, raw_data').eq('id', paper.id).single();
  if (rerr) return { ok: false, reason: 'reread error' };
  if (cur.abstract != null) return { ok: false, reason: 'already has abstract (skipped)' };

  let raw = cur.raw_data;
  raw = (raw == null || Array.isArray(raw) || typeof raw !== 'object') ? {} : { ...raw };
  raw.abstract_backfill = {
    source: result.source,
    matchedBy: result.matchedBy,
    ...(result.sim != null ? { titleSim: Number(result.sim.toFixed(3)) } : {}),
    fetchedAt: new Date().toISOString(),
  };
  // The flat `abstract_source` key is what the JEL evidence-table export reads to
  // decide the `unverified` flag (jelPaperPipeline.ts) — the detailed
  // abstract_backfill block above is invisible to it. Stamp both, or a genuinely
  // retrieved abstract ships indistinguishable from untagged legacy text.
  raw.abstract_source = result.source;

  const { error } = await sb.from('works')
    .update({ abstract: result.abstract, raw_data: raw })
    .eq('id', paper.id)
    .is('abstract', null); // DB-level gap-only guard
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const ratingScope = UNRATED_ONLY ? 'ABS rating: UNRATED only' : ANY_RATING ? 'ABS rating: any (no filter)' : 'ABS rating >= ' + MIN_ABS_RATING;
  console.log('\n=== Abstract backfill: year >= ' + YEAR_MIN + ', ' + ratingScope + ' ===');
  console.log(`dry-run: ${DRY_RUN} | limit: ${LIMIT === Infinity ? 'none' : LIMIT} | order: ${ORDER_BY}`);
  console.log(`Landing-page source: ${NO_LANDING ? 'OFF' : 'ON'} | skip-elsevier: ${SKIP_ELSEVIER} | sidecar: ${SIDECAR}\n`);

  const state = loadSidecar();
  if (state.processed.size) console.log(`Resuming: ${state.processed.size} already processed.\n`);

  let targets = await fetchTargets();
  console.log(`Target pool (before resume-skip): ${targets.length}`);
  targets = targets.filter(t => !state.processed.has(t.id));
  console.log(`Targets this run: ${targets.length}\n`);
  if (!targets.length) { console.log('Nothing to do.'); return; }

  // Title-only noise pass over the FULL target pool up front — cheap, no network calls,
  // so it still runs even under --dry-run and even if the sweep is interrupted early.
  for (const t of targets) {
    if (isApparatusTitle(t.title)) {
      state.noiseCandidates.push({ id: t.id, title: t.title, year: t.year, reasons: ['apparatus_title'], stage: 'pre-fetch (title only)' });
    }
  }
  if (state.noiseCandidates.length) {
    console.log(`Noise candidates flagged by TITLE alone (report-only, nothing changed in DB): ${state.noiseCandidates.length}`);
  }

  if (DRY_RUN) {
    saveNoiseReport(state);
    console.log('Dry run — no fetches/writes.');
    if (state.noiseCandidates.length) console.log(`Noise report -> ${NOISE_REPORT}`);
    return;
  }

  let filled = 0, unmatchedRun = 0, errors = 0, processed = 0;
  const start = Date.now();

  for (let i = 0; i < targets.length; i += OA_BATCH) {
    const slice = targets.slice(i, i + OA_BATCH);
    const doiSlice = slice.filter(t => t.canonical_doi).map(t => t.canonical_doi);

    let oaMap = new Map();
    if (doiSlice.length) {
      try { oaMap = await openAlexBatch(doiSlice); } catch { oaMap = new Map(); }
      await sleep(SLEEP_OA_MS);
    }

    for (const paper of slice) {
      let result = null;
      try {
        result = await resolveAbstract(paper, oaMap);
      } catch (e) {
        errors++;
      }
      state.processed.add(paper.id);
      processed++;

      if (result) {
        // Fetched-text noise check: even a real source can return apparatus text
        // (e.g. a review-of-a-book blurb) for a title the pre-fetch pass missed.
        const reasons = noiseSignal(paper, result.abstract);
        if (reasons.includes('apparatus_abstract_text')) {
          state.noiseCandidates.push({ id: paper.id, title: paper.title, year: paper.year, reasons, stage: 'post-fetch', fetchedSource: result.source, fetchedTextSample: String(result.abstract).slice(0, 200) });
        }
        if (!isRealAbstract(result.abstract)) {
          // Not a usable abstract (stub/placeholder/highlights/html) — treat as unmatched,
          // never write it. This is the SAME guard every backfill script uses.
          unmatchedRun++;
          state.unmatched.push(paper.id);
        } else {
          const w = await writeAbstract(paper, result);
          if (w.ok) {
            filled++;
            state.filledIds.push(paper.id);
            state.sourceCounts[result.source] = (state.sourceCounts[result.source] || 0) + 1;
          } else if (!/already has/.test(w.reason)) {
            errors++;
          }
        }
      } else {
        unmatchedRun++;
        state.unmatched.push(paper.id);
      }

      if (processed % 25 === 0) {
        const rate = (processed / Math.max(1, (Date.now() - start) / 1000)).toFixed(2);
        process.stdout.write(`\r  ${processed}/${targets.length} | filled ${filled} | unmatched ${unmatchedRun} | err ${errors} | noise ${state.noiseCandidates.length} | ${rate}/s`);
        saveSidecar(state);
        saveNoiseReport(state);
      }
    }
    saveSidecar(state);
    saveNoiseReport(state);
  }

  saveSidecar(state);
  saveNoiseReport(state);
  const elapsed = Math.round((Date.now() - start) / 1000);
  const recoveryPct = processed ? (filled / processed * 100).toFixed(1) : '0';

  console.log(`\n\n=== Done ===`);
  console.log(`Processed:        ${processed}`);
  console.log(`Filled:           ${filled} (${recoveryPct}%)`);
  console.log(`Unmatched:        ${unmatchedRun}`);
  console.log(`Errors:           ${errors}`);
  console.log(`Noise candidates: ${state.noiseCandidates.length} (report-only, nothing flagged in DB)`);
  console.log(`Elapsed:          ${elapsed}s`);
  console.log(`\nBy source:`);
  for (const [s, c] of Object.entries(state.sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(18)} ${c}`);
  }
  console.log(`\nSidecar: ${SIDECAR}`);
  if (state.noiseCandidates.length) console.log(`Noise report (REVIEW BEFORE ACTING): ${NOISE_REPORT}`);
  console.log(`Filled IDs are in sidecar.filledIds -> feed to backfill-reembed-with-abstract.mjs`);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
