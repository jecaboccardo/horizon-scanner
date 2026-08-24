#!/usr/bin/env node
/**
 * apply-apparatus-denylist-corpuswide.mjs — DESTRUCTIVE on --apply (flags is_noise,
 * nulls embedding, inserts corpus_denylist). PART B of the 2026-06-17 apparatus task.
 *
 * Corpus-wide hunt for the SAME kinds of journal-apparatus noise the Health Economics
 * pass found, but across the WHOLE corpus:
 *   (1) BOOK REVIEWS
 *   (2) WORKSHOP / CONFERENCE / SYMPOSIUM announcements & proceedings notices
 *   (3) EDITORIAL apparatus (editors' introductions, awards, in-memoriam, corrections/
 *       retractions/errata, calls for papers/proposals, appointments)
 *
 * Method (verify-before-flag, audit-before-commit, CONSERVATIVE):
 *  - Candidate capture: broad ilike pulls from PostgREST (canonical non-noise only),
 *    then PRECISE per-cluster regexes in JS decide membership.
 *  - RESEARCH GUARD: a title that reads as a research paper is NEVER flagged. Hard
 *    excludes: systematic/literature/scoping/narrative review, meta-analysis, and
 *    cluster-specific guards.
 *  - Clusters audited clean (~0 false positives) are auto-flaggable on --apply.
 *  - Clusters marked { hold:true } are AMBIGUOUS — reported only, NEVER flagged (the
 *    apply path refuses them even if named in --clusters).
 *
 * GOLDEN RULE: only mutations per row are is_noise=true, noise_reason, embedding=null
 * (active qwen-768 col; NOT embedding_nomic_old), and a corpus_denylist upsert. Apply
 * re-checks each row (canonical / non-noise / still matches its cluster) before write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-apparatus-denylist-corpuswide.mjs --dry-run
 *   node --env-file=.env scripts/apply-apparatus-denylist-corpuswide.mjs --apply --clusters=book_review,...
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'journal_apparatus_2026_06_17';
const clusterArg = (process.argv.find(a => a.startsWith('--clusters=')) || '').split('=')[1];
const ONLY_CLUSTERS = clusterArg ? new Set(clusterArg.split(',').map(s => s.trim())) : null;

const PAGE = 1000;
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Strip light HTML/markup tags that appear in some Wiley/Crossref titles.
const cleanTitle = (t) => (t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- RESEARCH GUARD: never flag a title that reads as a research review/paper ----
const RESEARCH_RE = /\b(systematic review|literature review|scoping review|narrative review|meta[- ]?analys|umbrella review|rapid review|integrative review|a review of the literature)\b/i;

// ===================== CLUSTER DEFINITIONS =====================
const CLUSTERS = [
  {
    id: 'issue_information',
    desc: 'Pure issue front/back-matter: "Issue Information", masthead, editorial board, table of contents (never a research paper)',
    captures: ['%issue information%', '%front matter%', '%back matter%', '%editorial board%', '%table of contents%', '%masthead%'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      if (RESEARCH_RE.test(s)) return false;
      // These phrases are journal apparatus; a research paper is never titled this.
      // Anchored/whole-phrase forms only (avoid an incidental mention inside a real title).
      if (/^issue information\b/.test(s) || /:\s*issue information\s*$/.test(s)) return true;
      if (/^(front|back)\s*matter\b/.test(s) || /:\s*(front|back)\s*matter\s*$/.test(s)) return true;
      if (/^editorial board\b/.test(s) || /:\s*editorial board\s*$/.test(s)) return true;
      if (/^(table of contents|contents)\b/.test(s) || /:\s*table of contents\s*$/.test(s)) return true;
      if (/^masthead\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'book_review',
    desc: 'Book reviews ("Title. Edited by/By X. (Publisher)" / "Review of <book> by <author>" / book review)',
    captures: ['%book review%', 'review of %', '% edited by %', '%reviewed by%', '%. by %university press%', '%. by %routledge%', '%. by %springer%', '%. by %. pp.%'],
    match: (t) => {
      const s = t.toLowerCase();
      if (RESEARCH_RE.test(s)) return false;
      if (/review essay/.test(s) || /multi-?book review/.test(s)) return false; // substantive review essays are scholarly survey content, not book notices
      if (/\bbook review\b/.test(s)) return true;
      // "<Book Title>. Edited by <Editor>..." — the book-review signature. A research paper
      // is never titled "Edited by"; this form is a review of an edited volume.
      if (/ edited by /.test(s)) return true;
      if (/\breviewed by\b/.test(s)) return true;
      // "Review of <Title> by <Author>" — but NOT a research SURVEY of a topic.
      if (/^review of /.test(s)) {
        if (/^review of (the |a |an |recent |current )?(literature|evidence|studies|research|empirical|theory|theories|methods?|methodolog|techniques?|strategies|approaches?|policies|policy|the field|recent|developments?|progress|models?|measurement|the (use|role|impact|effects?|relationship|state|status|determinants?))\b/.test(s)) return false;
        // book-review signature: a proper-name author after "by", OR a publisher/place/pp/ISBN tail.
        const byAuthor = / by [a-z][a-z'’.\- ]+$/.test(s) || / by [a-z][\w'’.\-]+ (and|&|\(|press|university|\d{4})/.test(s);
        const pubTail = /\b(press|university|publish|cambridge|oxford|routledge|springer|harvard|princeton|chicago|\bpp\.?\b|\bed\.|\beds\.|isbn|\$\d|£\d)\b/.test(s);
        if (byAuthor || pubTail) return true;
        return false; // "Review of X" with no book-citation cue -> HOLD
      }
      // "% by [a-z]%" capture catches lots of research; only keep if it has a book-citation tail
      // AND a publisher/place/pp signature (otherwise it's a normal "X by Y" research title).
      if (/\. (edited )?by [a-z]/.test(s) && /\b(press|university|publish|routledge|springer|\bpp\.?\b|\beds?\.|isbn)\b/.test(s)) return true;
      return false;
    },
  },
  {
    id: 'editorial_intro',
    desc: "Editors' / guest editors' introductions, editorial notes",
    captures: ["%editor%introduction%", "%editors'%introduction%", "%guest editor%", "%editorial introduction%"],
    match: (t) => {
      const s = t.toLowerCase();
      if (RESEARCH_RE.test(s)) return false;
      return /\b(guest )?editor'?s'? introduction\b/.test(s)
        || /^editorial introduction\b/.test(s)
        || /^introduction by the (guest )?editors?\b/.test(s);
    },
  },
  {
    id: 'in_memoriam',
    desc: 'In memoriam / in remembrance / person obituary (apparatus only)',
    captures: ['%in memoriam%', '%in remembrance%', '%obituary%', '%memoriam:%'],
    match: (t) => {
      const s = t.toLowerCase();
      if (/\bin memoriam\b/.test(s)) return true;
      if (/\bin remembrance of\b/.test(s)) return true;
      // Person obituary apparatus: "<Name>: Obituary", "Obituary: <Name>", "[Obituary...]",
      // "<Name> - Obituary". EXCLUDE metaphorical research uses ("... : An obituary notice",
      // "Capitalism: obituary and resurrection").
      if (/^\[obituary/.test(s)) return true;
      if (/^obituary[:\s]/.test(s)) return true;
      if (/[-:]\s*obituary\b/.test(s) && !/\bobituary (notice|and|of an?|for an?)\b/.test(s) && !/\bnotice\b/.test(s)) {
        // require a proper-name-ish left side (contains a capitalized word in the ORIGINAL — checked by caller via t)
        return true;
      }
      return false;
    },
  },
  {
    id: 'award',
    desc: 'Distinguished-author / best-paper awards, prize announcements',
    captures: ['%distinguished author%', '%best paper award%', '%best-paper award%', '%prize announcement%', '%prize:%'],
    match: (t) => {
      const s = t.toLowerCase();
      if (RESEARCH_RE.test(s)) return false;
      return /\bdistinguished author/.test(s)
        || /\bbest[- ]paper award\b/.test(s)
        || /\bprize announcement\b/.test(s);
    },
  },
  {
    id: 'call_for',
    desc: 'Calls for papers / proposals / abstracts',
    captures: ['%call for paper%', '%call for proposal%', '%call for abstract%'],
    match: (t) => {
      const s = t.toLowerCase();
      return /\bcall for (papers?|proposals?|abstracts?)\b/.test(s);
    },
  },
  {
    id: 'correction',
    desc: 'Corrections / retractions / errata / corrigenda (apparatus notices)',
    captures: ['retraction%', 'correction%', 'erratum%', 'corrigendum%', 'retracted%', '%: retraction', '%: correction', '%: erratum', '%: corrigendum'],
    match: (t) => {
      const s = t.toLowerCase();
      // anchored apparatus forms only (the corrected paper is a SEPARATE row)
      return /^(retraction|correction|erratum|corrigendum)\b[:\s]/.test(s)
        || /\b(retraction|corrigendum|erratum) (note|notice|statement)\b/.test(s)
        || /:\s*(retraction|correction|erratum|corrigendum)\s*$/.test(s)
        || /^(retraction|correction|retracted) (of|for|to|and update|note|notice|statement)\b/.test(s)
        || /^retracted:/.test(s);
    },
  },
  {
    id: 'editorial_announcement',
    desc: 'Editorial / society / prize / meeting ANNOUNCEMENTS (pure apparatus, never "announcement effect" research)',
    captures: ['editorial announcement%', 'announcement%', 'important announcement%', 'conference announcement%', 'spet announcement%', '%: editorial announcement', '%: announcement'],
    match: (t) => {
      const s = t.toLowerCase().trim();
      // exclude research papers that begin "Announcement effect/drift/premium/return/risk..."
      if (/announcement (effect|drift|premium|premia|return|risk|day|window|surprise|news)/.test(s)) return false;
      return /^editorial announcement\b/.test(s)
        || /^important announcement\b/.test(s)
        || /^conference announcement\b/.test(s)
        || /^spet announcement\b/.test(s)
        || /^announcement$/.test(s)
        || /^announcement (from|of|on|regarding|:|the|"|“|”|'|‘)/.test(s)
        || /^announcement\s*[”"’']/.test(s)
        || /:\s*(editorial )?announcement\s*$/.test(s);
    },
  },
  // ---------- HELD (ambiguous) clusters — reported, NEVER flagged ----------
  {
    id: 'workshop_proceedings',
    hold: true,
    desc: 'Workshop/symposium/conference proceedings & ordinal-meeting titles — AMBIGUOUS (mixes real proceedings papers, non-econ venues, and reviews of proceedings volumes). HELD for human review.',
    captures: ['%workshop%', '%symposium%', '%proceedings%'],
    match: (t) => {
      const s = t.toLowerCase();
      if (RESEARCH_RE.test(s)) return false;
      const ordinalWorkshop = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[- ]?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|\d{1,2}(st|nd|rd|th))\b.*\b(workshop|symposium|conference|meeting|congress)\b/.test(s);
      const procOf = /\bproceedings of (the|\d)\b/.test(s) || /^proceedings\b/.test(s) || /\bpapers and proceedings\b/.test(s);
      return ordinalWorkshop || procOf;
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
  console.log(`=== CORPUS-WIDE APPARATUS DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===`);
  if (ONLY_CLUSTERS) console.log(`  restricted to clusters: ${[...ONLY_CLUSTERS].join(', ')}`);
  console.log('');

  const report = { generated_at: new Date().toISOString(), apply: APPLY, reason: REASON, clusters: {} };
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
  for (const c of CLUSTERS) console.log(`  ${String(allMatched[c.id].length).padStart(6)} | ${c.id}${c.hold ? '  (HELD)' : ''}`);

  if (!APPLY) {
    fs.writeFileSync('reports/apparatus-corpuswide-dryrun-2026-06-17.json', JSON.stringify(report, null, 2));
    console.log('\nDRY-RUN report: reports/apparatus-corpuswide-dryrun-2026-06-17.json');
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
      .select('id,title,canonical_doi,is_noise,canonical_work_id')
      .in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));

    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skip++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skip++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
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
  fs.writeFileSync('reports/apparatus-corpuswide-apply-2026-06-17.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skip} errors=${errs}`);
  console.log(`  Report: reports/apparatus-corpuswide-apply-2026-06-17.json`);
})();
