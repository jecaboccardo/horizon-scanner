#!/usr/bin/env node
/**
 * Export full corpus to two CSVs: pre-2010 and 2010-plus.
 * Canonical non-noise papers only. Includes evidence card presence.
 *
 * Columns: id, title, year, venue, authors, geography, sms_level,
 *   methodology_design, causal_strength, citation_count, has_abstract,
 *   abstract_length, abstract_source, has_evidence_card, source,
 *   corpus_source, publication_type, year_group
 *
 * Usage:
 *   node --env-file=.env scripts/export-full-corpus.mjs
 *   node --env-file=.env scripts/export-full-corpus.mjs --out-dir reports/
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const OUT_DIR = (() => { const i = args.indexOf('--out-dir'); return i >= 0 ? args[i+1] : 'reports'; })();
const TODAY = new Date().toISOString().slice(0, 10);

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function arr(v) {
  if (!v) return '';
  const a = Array.isArray(v) ? v : (typeof v === 'string' ? JSON.parse(v) : []);
  return esc(a.join('; '));
}

const HEADER = [
  'id', 'title', 'year', 'year_group', 'venue', 'source', 'corpus_source',
  'publication_type', 'authors', 'geography', 'citation_count',
  'sms_level', 'methodology_design', 'causal_strength',
  'has_abstract', 'abstract_length', 'abstract_source',
  'has_evidence_card',
].join(',');

// Load evidence card work IDs into a Set for O(1) lookup
console.log('Loading evidence card index...');
const evidenceCardIds = new Set();
let ecFrom = 0;
while (true) {
  const { data, error } = await sb.from('evidence_cards').select('work_id').range(ecFrom, ecFrom + 999);
  if (error || !data?.length) break;
  for (const r of data) evidenceCardIds.add(r.work_id);
  if (data.length < 1000) break;
  ecFrom += 1000;
}
console.log(`Evidence cards indexed: ${evidenceCardIds.size}`);

// Open two output files
fs.mkdirSync(OUT_DIR, { recursive: true });
const PRE2010_FILE = `${OUT_DIR}/corpus-pre2010-${TODAY}.csv`;
const POST2010_FILE = `${OUT_DIR}/corpus-2010plus-${TODAY}.csv`;

const pre2010 = fs.createWriteStream(PRE2010_FILE, { encoding: 'utf8' });
const post2010 = fs.createWriteStream(POST2010_FILE, { encoding: 'utf8' });

pre2010.write(HEADER + '\n');
post2010.write(HEADER + '\n');

// Page through all canonical non-noise papers
let from = 0;
let pre2010Count = 0, post2010Count = 0;
const PAGE = 1000;

console.log('Exporting papers...');
while (true) {
  const { data, error } = await sb.from('works')
    .select('id, title, year, venue, source, corpus_source, publication_type, authors, geography, citation_count, sms_level, methodology_design, causal_strength, abstract, raw_data')
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .order('year', { ascending: true, nullsFirst: false })
    .order('id')
    .range(from, from + PAGE - 1);

  if (error) { console.error('Error:', error.message); break; }
  if (!data?.length) break;

  for (const r of data) {
    const yearGroup = !r.year ? 'unknown' : r.year < 2010 ? 'pre-2010' : '2010-plus';
    const hasAbstract = r.abstract ? 'Y' : 'N';
    const absLen = r.abstract ? r.abstract.length : 0;
    const absSource = r.raw_data?.abstract_source || (r.abstract ? 'original' : '');
    const hasCard = evidenceCardIds.has(r.id) ? 'Y' : 'N';

    const row = [
      esc(r.id),
      esc(r.title),
      esc(r.year),
      esc(yearGroup),
      esc(r.venue),
      esc(r.source),
      esc(r.corpus_source),
      esc(r.publication_type),
      arr(r.authors),
      arr(r.geography),
      esc(r.citation_count),
      esc(r.sms_level),
      esc(r.methodology_design),
      esc(r.causal_strength),
      esc(hasAbstract),
      esc(absLen),
      esc(absSource),
      esc(hasCard),
    ].join(',') + '\n';

    if (!r.year || r.year < 2010) {
      pre2010.write(row);
      pre2010Count++;
    } else {
      post2010.write(row);
      post2010Count++;
    }
  }

  const total = pre2010Count + post2010Count;
  process.stdout.write(`\r  exported ${total.toLocaleString()} papers (pre-2010: ${pre2010Count.toLocaleString()}, 2010+: ${post2010Count.toLocaleString()})`);

  if (data.length < PAGE) break;
  from += PAGE;
}

pre2010.end();
post2010.end();
process.stdout.write('\n');

const pre2010Size = Math.round(fs.statSync(PRE2010_FILE).size / 1024);
const post2010Size = Math.round(fs.statSync(POST2010_FILE).size / 1024);

console.log(`\nDone!`);
console.log(`Pre-2010:  ${PRE2010_FILE} (${pre2010Count.toLocaleString()} rows, ${pre2010Size.toLocaleString()}KB)`);
console.log(`2010-plus: ${POST2010_FILE} (${post2010Count.toLocaleString()} rows, ${post2010Size.toLocaleString()}KB)`);
