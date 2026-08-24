#!/usr/bin/env node
/**
 * Normalize World Bank venue names and obvious publication types.
 *
 * This intentionally does not collapse all World Bank records to one type:
 * World Bank journals are journal articles, policy research working papers are
 * working papers, and Open Knowledge Repository records stay mixed.
 *
 * Usage:
 *   node scripts/normalize-world-bank-venues.mjs --dry-run
 *   node scripts/normalize-world-bank-venues.mjs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const RULES = [
  {
    label: 'World Bank Economic Review',
    pattern: '%World Bank Economic Review%',
    update: {
      venue: 'The World Bank Economic Review',
      publication_type: 'journal_article',
      publication_type_method: 'world_bank_journal_venue',
      publication_type_confidence: 0.95,
    },
  },
  {
    label: 'World Bank Research Observer',
    pattern: '%World Bank Research Observer%',
    update: {
      venue: 'The World Bank Research Observer',
      publication_type: 'journal_article',
      publication_type_method: 'world_bank_journal_venue',
      publication_type_confidence: 0.95,
    },
  },
  {
    label: 'World Bank policy research working paper',
    pattern: '%World Bank policy research working paper%',
    update: {
      venue: 'World Bank Policy Research Working Paper',
      publication_type: 'working_paper',
      publication_type_method: 'world_bank_working_paper_venue',
      publication_type_confidence: 0.95,
    },
  },
];

async function countRule(rule) {
  const { count, error } = await supabase
    .from('works')
    .select('id', { count: 'exact', head: true })
    .ilike('venue', rule.pattern);
  if (error) throw error;
  return count || 0;
}

async function applyRule(rule) {
  if (DRY_RUN) return 0;
  const { error, count } = await supabase
    .from('works')
    .update(rule.update, { count: 'exact' })
    .ilike('venue', rule.pattern);
  if (error) throw error;
  return count || 0;
}

async function openKnowledgeDistribution() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('works')
      .select('id,publication_type,raw_data')
      .ilike('venue', '%Open Knowledge%')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const canonical = {};
  const raw = {};
  for (const row of rows) {
    const canonicalType = row.publication_type || 'NULL';
    const rawType = String(row.raw_data?.publication_type || row.raw_data?.type || 'NULL').replace(/-/g, '_');
    canonical[canonicalType] = (canonical[canonicalType] || 0) + 1;
    raw[rawType] = (raw[rawType] || 0) + 1;
  }
  return { total: rows.length, canonical, raw };
}

async function main() {
  console.log('='.repeat(72));
  console.log('Normalize World Bank venues');
  console.log('='.repeat(72));
  console.log(`Dry run: ${DRY_RUN}\n`);

  for (const rule of RULES) {
    const matched = await countRule(rule);
    const updated = await applyRule(rule);
    console.log(`${rule.label.padEnd(42)} matched ${String(matched).padStart(5)}${DRY_RUN ? '' : ` updated ${updated}`}`);
  }

  const ok = await openKnowledgeDistribution();
  console.log('\nOpen Knowledge Repository distribution (not blanket-normalized):');
  console.log(`  total: ${ok.total.toLocaleString()}`);
  console.log(`  canonical publication_type: ${JSON.stringify(ok.canonical)}`);
  console.log(`  raw publication_type:       ${JSON.stringify(ok.raw)}`);
}

main().catch((err) => {
  console.error('[normalize-world-bank-venues] failed:', err.message);
  process.exit(1);
});
