#!/usr/bin/env node
/**
 * Populate works.publication_type using the same classification logic as
 * migration 20260507000002. The migration's UPDATE didn't actually run in
 * prod (column exists but 0 rows populated), so we apply the classifier
 * client-side via per-row UPDATE.
 *
 * Output values: journal_article | working_paper | discussion_paper |
 *                report | book | book_chapter | conference_paper |
 *                preprint | dataset | dissertation | other
 *
 * Idempotent. Only writes rows where publication_type IS NULL.
 *
 * Usage:
 *   node scripts/populate-publication-type.mjs --dry-run --limit 5000
 *   node scripts/populate-publication-type.mjs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();

const PAGE = 1000;
const CONCURRENCY = 10;

const normalizeVenue = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

function canonicalWorldBankJournal(venue) {
  const normalized = normalizeVenue(venue);
  if (normalized === 'world bank economic review' || normalized === 'the world bank economic review') {
    return 'The World Bank Economic Review';
  }
  if (normalized === 'world bank research observer' || normalized === 'the world bank research observer') {
    return 'The World Bank Research Observer';
  }
  return null;
}

// First-match-wins classification (same order as the migration SQL).
function classify(work) {
  const raw = work.raw_data || {};
  const rawType = String(raw.publication_type || raw.type || '').toLowerCase().replace(/-/g, '_');
  const canonicalJournal = canonicalWorldBankJournal(work.venue);
  const haystack = [
    work.title || '',
    work.venue || '',
    work.source || '',
    work.corpus_source || '',
    raw['container-title'] || '',
    raw.source || '',
    raw.type || '',
  ].join(' ').toLowerCase();

  if (canonicalJournal) {
    return { type: 'journal_article', method: 'world_bank_journal_venue', confidence: 0.95 };
  }

  // Venue/title hints (most specific first)
  if (/\b(discussion paper|discussion papers|discussion series|iza discussion)\b/.test(haystack)) {
    return { type: 'discussion_paper', method: 'venue_hint', confidence: 0.85 };
  }
  if (/\b(working paper|working papers|policy research working paper|nber|ssrn|working papers series)\b/.test(haystack)) {
    return { type: 'working_paper', method: 'venue_hint', confidence: 0.85 };
  }
  if (/\b(preprint|pre-print|preprints)\b/.test(haystack)) {
    return { type: 'preprint', method: 'venue_hint', confidence: 0.85 };
  }
  if (/\b(conference paper|conference proceedings|proceedings paper)\b/.test(haystack)) {
    return { type: 'conference_paper', method: 'venue_hint', confidence: 0.85 };
  }
  if (/\b(technical note|technical notes|report|reports|monograph|iadb publication|idb publication)\b/.test(haystack)) {
    return { type: 'report', method: 'venue_hint', confidence: 0.85 };
  }

  // Raw importer metadata
  const rawMap = {
    journal_article: 'journal_article', 'journal-article': 'journal_article', article: 'journal_article',
    working_paper: 'working_paper', 'working-paper': 'working_paper',
    discussion_paper: 'discussion_paper', 'discussion-paper': 'discussion_paper',
    report: 'report',
    book_chapter: 'book_chapter', 'book-chapter': 'book_chapter',
    book: 'book',
    proceedings_article: 'conference_paper', 'proceedings-article': 'conference_paper',
    conference_paper: 'conference_paper', 'conference-paper': 'conference_paper',
    posted_content: 'preprint', 'posted-content': 'preprint', preprint: 'preprint',
    dataset: 'dataset',
    dissertation: 'dissertation',
  };
  if (rawMap[rawType]) {
    return { type: rawMap[rawType], method: 'raw_data', confidence: 0.95 };
  }

  // Structured journal signals
  if (work.journal_issn || work.abs_rating || /\b(journal|review|quarterly|annals)\b/.test(haystack)) {
    return { type: 'journal_article', method: 'journal_metadata', confidence: 0.80 };
  }
  if (['journal_whitelist', 'journal_gaps', 'lac_health_policy'].includes(work.corpus_source)) {
    return { type: 'journal_article', method: 'corpus_source', confidence: 0.70 };
  }

  // Corpus source fallback for institutional sources
  if (['idb_bulk', 'jpal_index'].includes(work.corpus_source)) {
    return { type: 'report', method: 'corpus_source', confidence: 0.70 };
  }

  return { type: 'other', method: 'fallback', confidence: 0.35 };
}

async function* iterateTargets() {
  let lastId = '';
  let processed = 0;
  while (processed < LIMIT) {
    const pageSize = Math.min(PAGE, LIMIT - processed);
    const { data, error } = await supabase
      .from('works')
      .select('id, title, venue, source, corpus_source, journal_issn, abs_rating, raw_data')
      .is('publication_type', null)
      .order('id', { ascending: true })
      .gt('id', lastId)
      .limit(pageSize);
    if (error) {
      if (error.message?.includes('terminated')) {
        console.error(`  [retry] page after ${lastId || '<start>'} terminated, waiting 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`targets fetch failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    yield data;
    lastId = data[data.length - 1].id;
    processed += data.length;
    if (data.length < PAGE) break;
  }
}

async function applyUpdates(updates) {
  if (updates.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (u) => {
        const { id, ...fields } = u;
        try {
          const { error } = await supabase.from('works').update(fields).eq('id', id);
          if (error) {
            console.error(`  [warn] update ${id}: ${error.message}`);
            return false;
          }
          return true;
        } catch (err) {
          console.error(`  [warn] update ${id} threw: ${err.message}`);
          return false;
        }
      }),
    );
    ok += results.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Populate publication_type');
  console.log('='.repeat(70));
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit:   ${LIMIT === Infinity ? '(unlimited)' : LIMIT.toLocaleString()}\n`);

  let processed = 0;
  const typeCounts = {};
  let writtenTotal = 0;

  for await (const page of iterateTargets()) {
    const updates = [];
    for (const w of page) {
      processed += 1;
      const { type, method, confidence } = classify(w);
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      updates.push({
        id: w.id,
        ...(canonicalWorldBankJournal(w.venue) ? { venue: canonicalWorldBankJournal(w.venue) } : {}),
        publication_type: type,
        publication_type_method: method,
        publication_type_confidence: confidence,
      });
    }
    if (!DRY_RUN) {
      const ok = await applyUpdates(updates);
      writtenTotal += ok;
    }
    console.log(`  ${processed.toLocaleString()} processed · ${writtenTotal.toLocaleString()} written`);
  }

  console.log('\nDistribution:');
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(20)} ${c.toLocaleString()}`);
  }
  console.log(`\nWritten: ${writtenTotal.toLocaleString()}`);
}

main().catch((err) => {
  console.error('[populate-publication-type] failed:', err.message);
  process.exit(1);
});
