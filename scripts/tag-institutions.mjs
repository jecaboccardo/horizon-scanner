#!/usr/bin/env node
/**
 * Stamp raw_data.institution on works belonging to known institutions, using
 * DOI prefixes (most reliable) plus URL/venue heuristics as fallbacks.
 *
 * Doesn't touch the `venue` field — that's used by lookupJournalRankings and
 * shouldn't be rewritten. Adds raw_data.institution so retrieval/filters can
 * group by funder regardless of which feed (RePEc, OpenAlex, grey-lit) brought
 * the paper in.
 *
 * Usage:
 *   node scripts/tag-institutions.mjs            # apply
 *   node scripts/tag-institutions.mjs --dry-run  # count only
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const DRY_RUN = process.argv.includes('--dry-run');

// Match rules — first match wins. DOI prefix is most reliable.
const RULES = [
  { name: 'World Bank',  doiPrefix: '10.1596/' },
  { name: 'IDB',         doiPrefix: '10.18235/' },
  { name: 'OECD',        doiPrefix: '10.1787/' },
  { name: 'PAHO',        doiPrefix: '10.37774/' },
  { name: 'IMF',         doiPrefix: '10.5089/' },
  { name: 'World Bank',  urlMatch: '%worldbank.org%' },
  { name: 'World Bank',  urlMatch: '%openknowledge.worldbank%' },
  { name: 'World Bank',  venueMatch: '%World Bank%' },
  { name: 'IDB',         urlMatch: '%publications.iadb.org%' },
  { name: 'IDB',         urlMatch: '%iadb.org%' },
  { name: 'OECD',        urlMatch: '%oecd.org%' },
  { name: 'OECD',        urlMatch: '%oecd-ilibrary%' },
  { name: 'PAHO',        urlMatch: '%paho.org%' },
  { name: 'PAHO',        urlMatch: '%iris.paho.org%' },
  { name: 'WHO',         urlMatch: '%who.int%' },
  { name: 'WHO',         urlMatch: '%iris.who.int%' },
  { name: 'IMF',         venueMatch: '%International Monetary Fund%' },
  { name: 'IHME',        venueMatch: '%Institute for Health Metrics%' },
  { name: 'ECLAC',       urlMatch: '%cepal.org%' },
  { name: 'ECLAC',       venueMatch: '%CEPAL%' },
  { name: 'NBER',        venueMatch: '%National Bureau of Economic Research%' },
  { name: 'IZA',         venueMatch: '%IZA%' },
  { name: 'IZA',         venueMatch: '%Institute of Labor Economics%' },
  { name: 'WHO',         venueMatch: '%World Health Organization%' },
];

async function tagRule(rule) {
  let q = supabase.from('works').select('id,raw_data', { count: 'exact' });
  if (rule.doiPrefix) q = q.like('canonical_doi', `${rule.doiPrefix}%`);
  if (rule.urlMatch)  q = q.ilike('url', rule.urlMatch);
  if (rule.venueMatch) q = q.ilike('venue', rule.venueMatch);
  // Only rows that aren't already tagged
  q = q.or('raw_data->>institution.is.null,raw_data->>institution.eq.');

  const PAGE = 1000;
  let from = 0;
  let totalUpdated = 0;
  while (true) {
    const { data, error, count } = await q.range(from, from + PAGE - 1);
    if (error) { console.error(`  err ${rule.name}: ${error.message}`); break; }
    if (!data?.length) break;

    if (DRY_RUN) {
      totalUpdated += data.length;
    } else {
      // Per-row update (raw_data merge — can't be done in one batch update)
      for (const r of data) {
        const newRaw = { ...(r.raw_data || {}), institution: rule.name };
        const { error: upErr } = await supabase
          .from('works')
          .update({ raw_data: newRaw })
          .eq('id', r.id);
        if (upErr) { console.error(`  update err ${rule.name} (${r.id}): ${upErr.message}`); continue; }
        totalUpdated += 1;
      }
    }

    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  ${rule.name.padEnd(12)} ${totalUpdated}`);
  }
  console.log(`\r  ${rule.name.padEnd(12)} ${rule.doiPrefix || rule.urlMatch || rule.venueMatch}  →  ${totalUpdated}${DRY_RUN ? ' (dry)' : ''}`);
  return totalUpdated;
}

async function main() {
  console.log(`\n=== Institution tagging ===`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  // Pre-count how many already tagged
  const { count: alreadyTagged } = await supabase.from('works')
    .select('*', { count: 'exact', head: true })
    .not('raw_data->>institution', 'is', null);
  console.log(`Already tagged: ${alreadyTagged || 0}\n`);

  let total = 0;
  for (const rule of RULES) {
    total += await tagRule(rule);
  }
  console.log(`\n=== Summary ===`);
  console.log(`Total ${DRY_RUN ? 'matched' : 'tagged'}: ${total}`);

  if (!DRY_RUN) {
    // Final per-institution count
    console.log(`\nPer-institution coverage:`);
    const insts = ['World Bank','IDB','OECD','PAHO','WHO','IMF','IHME','ECLAC','NBER','IZA'];
    for (const i of insts) {
      const { count } = await supabase.from('works')
        .select('*', { count: 'exact', head: true })
        .eq('raw_data->>institution', i);
      console.log(`  ${i.padEnd(15)} ${count || 0}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
