#!/usr/bin/env node
/**
 * sample-biomedical-venues.mjs
 * Deep-sample the high-count biomedical venues identified in audit-biomedical-venues.
 * For each venue, show top-cited + random papers with abstracts to verify they are
 * genuinely noise (not health-econ/development papers that belong in corpus).
 *
 * Usage: node --env-file=.env scripts/sample-biomedical-venues.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function sample(venuePattern, n = 10, byDoi = false) {
  let q = sb.from('works')
    .select('id, title, venue, authors, citation_count, year, abstract, fields_of_study')
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true);
  if (byDoi) {
    q = q.like('id', venuePattern);
  } else {
    q = q.ilike('venue', venuePattern);
  }
  const { data } = await q.order('citation_count', { ascending: false }).limit(n);
  return data || [];
}

async function countVenue(venuePattern, byDoi = false) {
  let q = sb.from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true);
  if (byDoi) {
    q = q.like('id', venuePattern);
  } else {
    q = q.ilike('venue', venuePattern);
  }
  const { count } = await q;
  return count || 0;
}

// Key venues to deep-sample (high count or representative)
const venues = [
  // Very high count — critical to verify
  { name: 'JAMA', pattern: 'JAMA', byDoi: false },
  { name: 'JAMA Network Open', pattern: 'JAMA Network Open', byDoi: false },
  { name: 'JAMA family (DOI)', pattern: '10.1001/%', byDoi: true },
  { name: 'PLOS ONE', pattern: 'PLOS ONE', byDoi: false },
  { name: 'The Lancet', pattern: '%Lancet%', byDoi: false },
  { name: 'Circulation', pattern: 'Circulation', byDoi: false },
  { name: 'JACC (DOI)', pattern: '10.1016/j.jacc%', byDoi: true },
  { name: 'BMJ', pattern: 'BMJ', byDoi: false },
  { name: 'BMJ family (DOI)', pattern: '10.1136/%', byDoi: true },
  { name: 'European Heart Journal', pattern: 'European Heart Journal', byDoi: false },
  { name: 'Nucleic Acids Research', pattern: 'Nucleic Acids Research', byDoi: false },
  { name: 'Brain', pattern: 'Brain', byDoi: false },
  { name: 'Nature Methods', pattern: 'Nature Methods', byDoi: false },
  { name: 'eLife', pattern: 'eLife', byDoi: false },
  { name: 'Stroke', pattern: 'Stroke', byDoi: false },
  { name: 'PLOS Neglected Tropical Diseases', pattern: 'PLOS Neglected Tropical Diseases', byDoi: false },
  { name: 'Arthritis & Rheumatology', pattern: 'Arthritis%Rheumatolog%', byDoi: false },
  { name: 'Cell', pattern: 'Cell', byDoi: false },
  { name: 'Cell (Elsevier DOI)', pattern: '10.1016/j.cell%', byDoi: true },
  { name: 'Cell Metabolism', pattern: 'Cell Metabolism', byDoi: false },
  { name: 'Cancer Cell', pattern: 'Cancer Cell', byDoi: false },
  { name: 'Cancer', pattern: 'Cancer', byDoi: false },
  { name: 'Int J Cancer (DOI)', pattern: '10.1002/ijc%', byDoi: true },
  { name: 'Nature Biotechnology', pattern: 'Nature Biotechnology', byDoi: false },
  { name: 'Nature Immunology', pattern: 'Nature Immunology', byDoi: false },
  { name: 'Cochrane Database', pattern: 'Cochrane%', byDoi: false },
  { name: 'NEJM (DOI)', pattern: '10.1056/%', byDoi: true },
  { name: 'Acta Crystallographica (DOI)', pattern: '10.1107/%', byDoi: true },
  { name: 'JACS (DOI)', pattern: '10.1021/ja%', byDoi: true },
  { name: 'J National Cancer Institute (DOI)', pattern: '10.1093/jnci%', byDoi: true },
  { name: 'J Infectious Diseases (DOI)', pattern: '10.1093/infdis%', byDoi: true },
  { name: 'Blood (DOI)', pattern: '10.1182/blood%', byDoi: true },
  { name: 'Nephrology Dialysis Transplantation', pattern: 'Nephrology Dialysis%', byDoi: false },
  { name: 'American Journal of Kidney Diseases', pattern: 'American Journal of Kidney%', byDoi: false },
  { name: 'PLOS Medicine', pattern: 'PLOS Medicine', byDoi: false },
  { name: 'Journal of Applied Crystallography', pattern: 'Journal of Applied Crystallography', byDoi: false },
  { name: 'Oncogene', pattern: 'Oncogene', byDoi: false },
  { name: 'British Journal of Cancer', pattern: 'British Journal of Cancer', byDoi: false },
  { name: 'Emerging Infectious Diseases', pattern: 'Emerging Infectious Diseases', byDoi: false },
];

const results = {};
for (const v of venues) {
  const rows = await sample(v.pattern, 10, v.byDoi);
  const count = await countVenue(v.pattern, v.byDoi);
  results[v.name] = { count, sample: rows };
  console.log(`\n=== ${v.name} (count=${count}) ===`);
  for (const r of rows) {
    console.log(`  [${r.year}] ${r.title?.slice(0, 100)}`);
    console.log(`    venue=${r.venue} | cites=${r.citation_count}`);
    if (r.abstract) {
      console.log(`    abstract: ${r.abstract.slice(0, 200)}...`);
    }
    console.log(`    fields: ${JSON.stringify(r.fields_of_study)}`);
  }
}

fs.writeFileSync('reports/biomedical-sample-2026-06-10.json', JSON.stringify(results, null, 2));
console.log('\n\nFull samples written to reports/biomedical-sample-2026-06-10.json');
