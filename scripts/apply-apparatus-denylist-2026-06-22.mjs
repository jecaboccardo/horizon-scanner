#!/usr/bin/env node
/**
 * apply-apparatus-denylist-2026-06-22.mjs — DESTRUCTIVE on --apply (flags is_noise,
 * nulls embedding [active qwen-768 column], inserts corpus_denylist). Extends the
 * 2026-06-17 corpus-wide apparatus pass with NEW apparatus clusters observed among the
 * ~11,158 canonical non-noise rows that have EMPTY authors (`authors = '[]'`).
 *
 * NEW clusters (NOT covered by apply-apparatus-denylist-corpuswide.mjs):
 *   - book_notes              "Book Notes" (distinct from book review)
 *   - referees                Recent/Acknowledgement of Referees, Reviewer Acknowledgement(s)
 *   - index                   Volume/Author/Subject/Annual Index, Contents of Volume, Vol Contents & Author Index
 *   - dissertation_listing    Doctoral Dissertation Listing / Ph.D. dissertation award/listing
 *   - manuscript_info         Submission of Manuscripts / Information|Instructions for Authors / Notes for Contributors
 *   - meeting_program         Program of the <year> ... Meeting / Congress
 *   - code_of_ethics          Code of Ethics
 *   - author_responds         O autor responde / Os autores respondem (PT journal apparatus)
 *   - expression_of_concern   Expression of Concern
 *   - masthead                Masthead / Front Matter / Back Matter / Table of Contents / pure "Editorial:" masthead
 *   - intro_research_articles HELD — "Introduction to research articles" (could clash with real intros)
 *
 * Method (verify-before-flag, audit-before-commit, CONSERVATIVE):
 *  - Candidate capture: broad ilike pulls from PostgREST (canonical non-noise + EMPTY authors),
 *    then PRECISE per-cluster regexes in JS decide membership.
 *  - HARD GUARD (required for EVERY cluster): authors = '[]' (empty). Apparatus has no
 *    authors in Crossref/OpenAlex; a real authored paper can never be flagged.
 *  - RESEARCH GUARD: a title that reads as a research paper/review is NEVER flagged.
 *  - Clusters marked { hold:true } are AMBIGUOUS — reported only, NEVER flagged (apply
 *    refuses them even if named in --clusters).
 *
 * GOLDEN RULE: only mutations per row are is_noise=true, noise_reason, embedding=null
 * (active qwen-768 col; NOT embedding_nomic_old), and a corpus_denylist upsert. Apply
 * re-checks each row (canonical / non-noise / EMPTY authors / still matches its cluster)
 * before write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-apparatus-denylist-2026-06-22.mjs --dry-run
 *   node --env-file=.env scripts/apply-apparatus-denylist-2026-06-22.mjs --apply --clusters=book_notes,...
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'journal_apparatus_2026_06_22';
const clusterArg = (process.argv.find(a => a.startsWith('--clusters=')) || '').split('=')[1];
const ONLY_CLUSTERS = clusterArg ? new Set(clusterArg.split(',').map(s => s.trim())) : null;

const PAGE = 1000;
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Strip light HTML/markup tags that appear in some Wiley/Crossref titles.
const cleanTitle = (t) => (t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// authors column normalisation — apparatus has empty authors. We require EMPTY.
const authorsEmpty = (a) => {
  if (a == null) return true;            // null counts as empty
  if (Array.isArray(a)) return a.length === 0;
  if (typeof a === 'string') { const t = a.trim(); return t === '' || t === '[]'; }
  return false;
};

// ---- RESEARCH GUARD: never flag a title that reads as a research review/paper ----
const RESEARCH_RE = /\b(systematic review|literature review|scoping review|narrative review|meta[- ]?analys|umbrella review|rapid review|integrative review|a review of the literature)\b/i;

// ===================== CLUSTER DEFINITIONS =====================
const CLUSTERS = [
  {
    id: 'book_notes',
    desc: '"Book Notes" — short publisher/book-notice apparatus (distinct from book review)',
    captures: ['%book notes%', 'book note%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Anchored apparatus forms. Avoid "notes on X book" style research prose.
      if (/^book notes\b/.test(s)) return true;
      if (/^book note\b/.test(s)) return true;
      if (/[:\-—]\s*book notes\s*$/.test(s)) return true;
      if (/^books? (received|noted)\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'referees',
    desc: 'Referee/reviewer acknowledgement apparatus',
    captures: ['%referee%', '%reviewer acknowledg%', '%acknowledgement of review%', '%acknowledgment of review%', '%our reviewers%', '%thanks to%review%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Exclude substantive research about refereeing/peer-review processes.
      if (/\b(effect|effects|bias|gender|process|quality|determinant|economics|analysis|evidence|impact|model|incentive|behaviou?r|reform|experiment|game|theory|market|signal)\b/.test(s)) return false;
      if (/^(recent |list of |our )?referees\b/.test(s)) return true;
      if (/^referee acknowledg/.test(s)) return true;
      if (/\backnowledg(e?ment|ements?) of referees\b/.test(s)) return true;
      if (/\backnowledg(e?ment|ements?) (to|of) (our )?reviewers\b/.test(s)) return true;
      if (/\breviewer acknowledg(e?ment|ements?)\b/.test(s)) return true;
      if (/^reviewers\b[:\s]/.test(s)) return true;
      if (/^(list of |our )?reviewers\s*$/.test(s)) return true;
      if (/\bthanks? to (our |the )?(referees|reviewers)\b/.test(s)) return true;
      if (/\backnowledg(e?ment|ements?) (to|of) (our |the )?referees\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'index',
    desc: 'Volume / Author / Subject / Annual indexes and Contents-of-Volume apparatus',
    captures: ['%author index%', '%subject index%', '%annual index%', '%volume index%', '%contents of volume%', '%volume contents%', '%index to volume%', '%index of volume%', '%cumulative index%', '%title index%', '%name index%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      if (/^(volume )?author index\b/.test(s)) return true;
      if (/\bvolume contents and author index\b/.test(s)) return true;
      if (/\bvolume contents\b/.test(s)) return true;
      if (/^subject index\b/.test(s) || /[:\-—]\s*subject index\s*$/.test(s)) return true;
      if (/^author index\b/.test(s) || /[:\-—]\s*author index\s*$/.test(s)) return true;
      if (/^title index\b/.test(s) || /^name index\b/.test(s)) return true;
      if (/^annual index\b/.test(s) || /[:\-—]\s*annual index\s*$/.test(s)) return true;
      if (/^cumulative index\b/.test(s)) return true;
      if (/^volume index\b/.test(s)) return true;
      if (/^(index|contents) (to|of|for) volume\b/.test(s)) return true;
      if (/^contents of volume\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'dissertation_listing',
    desc: 'Doctoral dissertation listings / Ph.D. dissertation award & listing apparatus',
    captures: ['%doctoral dissertation%', '%ph.d. dissertation%', '%phd dissertation%', '%dissertations in progress%', '%doctoral degrees%', '%dissertation listing%', '%dissertation abstracts%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Exclude real studies ABOUT dissertations (effects, time-to-degree, completion, gender...).
      if (/\b(effect|effects|determinant|time[- ]to|completion|gender|productivity|impact|analysis|evidence|labor market|labour market|outcome|career|funding)\b/.test(s)) return false;
      if (/\b(doctoral dissertation|ph\.?d\.? dissertation|phd dissertation) (listing|listings|award|awards|abstracts|titles|in (economics|progress))\b/.test(s)) return true;
      if (/^doctoral dissertations?\b/.test(s) && /\b(listing|award|abstracts|titles|completed|in progress|in economics|annual list)\b/.test(s)) return true;
      if (/^dissertation (listing|listings|abstracts|titles)\b/.test(s)) return true;
      if (/\bdissertations? in progress\b/.test(s)) return true;
      if (/^doctoral degrees conferred\b/.test(s)) return true;
      if (/^doctoral dissertations? completed\b/.test(s)) return true;
      if (/\bph\.?d\.? dissertation award\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'manuscript_info',
    desc: 'Submission of manuscripts / Information|Instructions for authors / Notes for contributors',
    captures: ['%submission of manuscript%', '%information for author%', '%instructions for author%', '%instructions to author%', '%notes for contributor%', '%guidelines for author%', '%guide for author%', '%manuscript submission%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      if (/^submission of manuscripts?\b/.test(s)) return true;
      if (/\bsubmission of manuscripts? to\b/.test(s)) return true;
      if (/^information for authors?\b/.test(s) || /[:\-—]\s*information for authors?\s*$/.test(s)) return true;
      if (/^instructions (for|to) authors?\b/.test(s)) return true;
      if (/^guidelines for authors?\b/.test(s)) return true;
      if (/^guide for authors?\b/.test(s)) return true;
      if (/^notes for contributors?\b/.test(s)) return true;
      if (/^manuscript submission\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'meeting_program',
    desc: 'Program of the <year> ... Meeting / Congress (society meeting programs)',
    captures: ['program of the %meeting%', 'program of the %congress%', 'programme of the %meeting%', 'programme of the %congress%', '%annual meeting program%', '%meeting program%', '%scientific program%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Exclude research about "program" (program evaluation, social programs, etc.).
      if (/\b(evaluation|effect|impact|transfer|cash|welfare|training|subsid|treatment|conditional)\b/.test(s)) return false;
      if (/^programm?e of the\b.*\b(meeting|congress|convention|conference|session)\b/.test(s)) return true;
      if (/^(preliminary |final )?programm?e\b.*\b(annual meeting|congress|convention)\b/.test(s)) return true;
      if (/\b(annual meeting|scientific) programm?e\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'code_of_ethics',
    desc: 'Code of Ethics (society/journal apparatus)',
    captures: ['%code of ethics%', '%code of conduct%', '%ethical guidelines%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Exclude research analysing codes of ethics/conduct (effect, adoption, corporate...).
      if (/\b(effect|effects|adoption|corporate|determinant|impact|analysis|evidence|compliance|enforcement|firm|disclosure|comparison|content analysis|cross[- ]country)\b/.test(s)) return false;
      if (/^code of ethics\b/.test(s) || /^code of conduct\b/.test(s)) return true;
      if (/^(the )?(aea|society'?s|association'?s|journal'?s) code of (ethics|conduct)\b/.test(s)) return true;
      // "<Society/Association/Organization name ...> Code of Ethics|Conduct" reprinted as
      // apparatus (e.g. "American Society for Public Administration Code of Ethics"). Require
      // the title to END at the code phrase (apparatus reprint), not use it mid-sentence.
      if (/\b(society|association|academy|institute|board|college|federation|organization|organisation|council)\b[a-z' ]*\bcode of (ethics|conduct)\s*$/.test(s)) return true;
      if (/^ethical guidelines\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'author_responds',
    desc: 'Portuguese journal apparatus: "O autor responde" / "Os autores respondem" (the author(s) respond)',
    captures: ['o autor responde%', 'os autores respondem%', 'a autora responde%', 'as autoras respondem%', '%autor responde%', '%autores respondem%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (/^(o autor|a autora) respond[ea]\b/.test(s)) return true;
      if (/^(os autores|as autoras) respondem\b/.test(s)) return true;
      // anchored only — avoid sentences that merely contain the phrase
      if (/^[^a-z]*\bos? autor(es)? respond[ea]m?\b\s*$/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'expression_of_concern',
    desc: 'Expression of Concern (post-publication apparatus notice)',
    captures: ['expression of concern%', '%: expression of concern', '%expression of concern%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      if (/^expression of concern\b/.test(s)) return true;
      if (/:\s*expression of concern\s*$/.test(s)) return true;
      if (/^editorial expression of concern\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'masthead',
    desc: 'Mastheads / Front Matter / Back Matter / Table of Contents / pure "Editorial:" mastheads',
    captures: ['masthead%', 'front matter%', 'back matter%', 'table of contents%', 'editorial board%', '%: front matter', '%: back matter', '%: table of contents'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // Exclude research that studies editorial boards (gender/composition/diversity etc.).
      if (/\b(gender|composition|diversity|representation|determinant|effect|network|analysis|evidence|women|concentration|influence)\b/.test(s)) return false;
      if (/^masthead\b/.test(s) || /[:\-—]\s*masthead\s*$/.test(s)) return true;
      if (/^front matter\b/.test(s) || /[:\-—]\s*front matter\s*$/.test(s)) return true;
      if (/^back matter\b/.test(s) || /[:\-—]\s*back matter\s*$/.test(s)) return true;
      if (/^table of contents\b/.test(s) || /[:\-—]\s*table of contents\s*$/.test(s)) return true;
      if (/^editorial board\b/.test(s) || /[:\-—]\s*editorial board\s*$/.test(s)) return true;
      return false;
    },
  },
  // ---------- HELD (ambiguous) cluster — reported, NEVER flagged ----------
  {
    id: 'intro_research_articles',
    hold: true,
    desc: '"Introduction to research articles" / "Introduction to the research articles" — AMBIGUOUS editorial filler that can collide with substantive section/special-issue introductions. HELD for human review.',
    captures: ['%introduction to research article%', '%introduction to the research article%', 'introduction to research%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      return /^introduction to (the )?research articles?\b/.test(s)
        || /[:\-—]\s*introduction to (the )?research articles?\s*$/.test(s);
    },
  },
];

async function captureCluster(c) {
  const seen = new Map();
  for (const pat of c.captures) {
    let offset = 0;
    while (true) {
      const { data, error } = await sb.from('works')
        .select('id,title,venue,citation_count,year,authors,abstract,canonical_doi,is_noise,canonical_work_id')
        .is('canonical_work_id', null).not('is_noise', 'is', true)
        .ilike('title', pat)
        .range(offset, offset + PAGE - 1);
      if (error) { console.error(`  ERR [${c.id}] ${pat}: ${error.message}`); break; }
      for (const r of (data || [])) seen.set(r.id, r);
      if (!data || data.length < PAGE) break;
      offset += PAGE;
    }
  }
  const matched = [];
  for (const r of seen.values()) {
    if (!authorsEmpty(r.authors)) continue;        // HARD GUARD: empty authors only
    const t = cleanTitle(r.title);
    if (!t) continue;
    if (c.match(t)) matched.push({ ...r, _clean: t });
  }
  return matched;
}

const sampleOf = (rows, n = 20) => {
  const byCite = [...rows].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
  const out = [];
  const seen = new Set();
  for (const r of byCite.slice(0, 6)) { out.push(r); seen.add(r.id); }
  const step = Math.max(1, Math.floor(rows.length / (n - out.length || 1)));
  for (let i = 0; i < rows.length && out.length < n; i += step) {
    if (!seen.has(rows[i].id)) { out.push(rows[i]); seen.add(rows[i].id); }
  }
  return out.slice(0, n);
};

(async () => {
  console.log(`=== APPARATUS DENYLIST 2026-06-22 (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===`);
  console.log(`  HARD GUARD: authors = '[]' (empty) required for every cluster.`);
  if (ONLY_CLUSTERS) console.log(`  restricted to clusters: ${[...ONLY_CLUSTERS].join(', ')}`);
  console.log('');

  const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, hard_guard: "authors='[]'", clusters: {} };
  const allMatched = {};

  for (const c of CLUSTERS) {
    const matched = await captureCluster(c);
    allMatched[c.id] = matched;
    const sample = sampleOf(matched, 20);
    const topCite = matched.reduce((m, r) => Math.max(m, r.citation_count || 0), 0);
    console.log(`\n########## CLUSTER: ${c.id} — ${matched.length} candidates ${c.hold ? '[HELD — reported only]' : ''}`);
    console.log(`  ${c.desc}`);
    console.log(`  top citation in cluster: ${topCite}`);
    console.log(`  --- 20-row sample (cite | year | venue | title) ---`);
    for (const r of sample) {
      console.log(`  [${String(r.citation_count ?? '—').padStart(4)}] ${String(r.year ?? '—').padStart(4)} | ${(r.venue || '(null)').slice(0, 24).padEnd(24)} | ${r._clean.slice(0, 78)}`);
    }
    report.clusters[c.id] = {
      desc: c.desc, hold: !!c.hold, count: matched.length, top_citation: topCite,
      sample: sample.map(r => ({ id: r.id, title: r._clean, venue: r.venue, year: r.year, citation_count: r.citation_count, canonical_doi: r.canonical_doi, authors: Array.isArray(r.authors) ? r.authors.length : 0, has_abstract: !!r.abstract })),
      all: matched.map(r => ({ id: r.id, title: r._clean, venue: r.venue, year: r.year, citation_count: r.citation_count, canonical_doi: r.canonical_doi })),
    };
  }

  console.log('\n\n=== CLUSTER COUNT SUMMARY ===');
  let flaggable = 0;
  for (const c of CLUSTERS) {
    console.log(`  ${String(allMatched[c.id].length).padStart(6)} | ${c.id}${c.hold ? '  (HELD)' : ''}`);
    if (!c.hold) flaggable += allMatched[c.id].length;
  }
  console.log(`  ------`);
  console.log(`  ${String(flaggable).padStart(6)} | TOTAL FLAGGABLE (non-HELD)`);

  if (!APPLY) {
    fs.writeFileSync('reports/apparatus-denylist-dryrun-2026-06-22.json', JSON.stringify(report, null, 2));
    console.log('\nDRY-RUN report: reports/apparatus-denylist-dryrun-2026-06-22.json');
    process.exit(0);
  }

  // ============ APPLY (only NON-HELD clusters explicitly allowed) ============
  if (!ONLY_CLUSTERS) {
    console.error('\n--apply requires --clusters=<comma list> (safety: name the audited-clean clusters explicitly).');
    process.exit(1);
  }
  const clusterById = new Map(CLUSTERS.map(c => [c.id, c]));
  for (const id of ONLY_CLUSTERS) {
    const c = clusterById.get(id);
    if (!c) { console.error(`unknown cluster: ${id}`); process.exit(1); }
    if (c.hold) { console.error(`cluster "${id}" is HELD (ambiguous) and cannot be applied. Aborting.`); process.exit(1); }
  }

  let denylisted = 0, flaggedW = 0, skip = 0, errs = 0;
  const skippedRows = [];
  const toApply = [];
  for (const c of CLUSTERS) {
    if (!ONLY_CLUSTERS.has(c.id) || c.hold) continue;
    for (const r of allMatched[c.id]) toApply.push({ ...r, _cluster: c.id });
  }
  const dedup = new Map();
  for (const r of toApply) if (!dedup.has(r.id)) dedup.set(r.id, r);
  const flagged = [...dedup.values()];
  console.log(`\n=== APPLYING ${flagged.length} rows from clusters [${[...ONLY_CLUSTERS].join(', ')}] (batched, per-row re-check) ===`);

  let done = 0;
  for (const batch of chunk(flagged, 75)) {
    const ids = batch.map(r => r.id);
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,title,authors,canonical_doi,is_noise,canonical_work_id')
      .in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));

    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skip++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skip++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
      if (!authorsEmpty(r.authors)) { skip++; skippedRows.push({ id: t.id, why: 'authors_not_empty' }); continue; }
      const ct = cleanTitle(r.title);
      const pred = clusterById.get(t._cluster).match;
      if (!pred(ct)) { skip++; skippedRows.push({ id: t.id, why: 'no_longer_matches', cluster: t._cluster, title: ct }); continue; }

      const { error: e1 } = await sb.from('corpus_denylist')
        .upsert({ work_id: t.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
      if (e1) { console.error('denylist', t.id, e1.message); errs++; continue; }
      denylisted++;
      const { error: e2 } = await sb.from('works')
        .update({ is_noise: true, noise_reason: REASON, embedding: null }).eq('id', t.id);
      if (e2) { console.error('works update', t.id, e2.message); errs++; continue; }
      flaggedW++;
    }
    done += batch.length;
    console.log(`  ...${done}/${flagged.length} (flagged ${flaggedW}, skipped ${skip}, err ${errs})`);
  }

  report.result = { applied_clusters: [...ONLY_CLUSTERS], denylisted, works_flagged: flaggedW, skipped_recheck: skip, errors: errs };
  report.skipped_sample = skippedRows.slice(0, 80);
  fs.writeFileSync('reports/apparatus-denylist-apply-2026-06-22.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skip} errors=${errs}`);
  console.log(`  Report: reports/apparatus-denylist-apply-2026-06-22.json`);
})();
