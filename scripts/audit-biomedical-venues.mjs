#!/usr/bin/env node
/**
 * audit-biomedical-venues.mjs
 * Identify biomedical/non-econ venues in the corpus not yet in corpus_denylist.
 *
 * Phase 1: Count papers by venue for known biomedical/clinical/natural-science venue names.
 * Phase 2: Sample papers per suspicious venue for manual verification.
 * Phase 3 (dry-run mode): Output full candidate list + counts.
 *
 * Usage:
 *   node --env-file=.env scripts/audit-biomedical-venues.mjs
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

// -------------------------------------------------------------------------
// Known biomedical / pure-clinical / natural-science venues to audit.
// Grouped for clarity. We'll query each for count + sample.
// -------------------------------------------------------------------------
const CANDIDATE_VENUES = [
  // Top-cited biomedical examples already found:
  'Cell',
  'Nature Medicine',
  'Nature Cell Biology',
  'Nature Structural & Molecular Biology',
  'Molecular Cell',
  'Developmental Cell',
  'Cell Metabolism',
  'Cell Host & Microbe',
  'Cell Chemical Biology',
  'Cell Reports',
  'Cell Systems',
  'Cell Stem Cell',

  // Major clinical / medical journals:
  'The New England Journal of Medicine',
  'New England Journal of Medicine',
  'The Lancet',
  'Lancet',
  'JAMA',
  'JAMA Internal Medicine',
  'JAMA Oncology',
  'JAMA Pediatrics',
  'JAMA Network Open',
  'JAMA Surgery',
  'JAMA Cardiology',
  'JAMA Dermatology',
  'JAMA Neurology',
  'JAMA Psychiatry',
  'BMJ',
  'British Medical Journal',
  'Annals of Internal Medicine',
  'Annals of Surgery',
  'PLOS Medicine',
  'PLOS ONE',
  'PLOS Biology',
  'PLOS Genetics',
  'PLOS Pathogens',
  'PLOS Neglected Tropical Diseases',
  'PLOS Computational Biology',
  'American Journal of Kidney Diseases',
  'Kidney International',
  'Nephrology Dialysis Transplantation',
  'Clinical Journal of the American Society of Nephrology',
  'American Journal of Respiratory and Critical Care Medicine',
  'American Journal of Physiology',
  'American Journal of Pathology',
  'American Journal of Human Genetics',
  'Journal of Clinical Investigation',
  'Journal of Clinical Oncology',
  'Journal of Allergy and Clinical Immunology',
  'Journal of Infectious Diseases',
  'Clinical Infectious Diseases',
  'Circulation',
  'Journal of the American College of Cardiology',
  'European Heart Journal',
  'Heart',
  'Stroke',
  'Neurology',
  'Annals of Neurology',
  'Brain',
  'Journal of Neuroscience',
  'Gut',
  'Gastroenterology',
  'Hepatology',
  'Journal of Hepatology',
  'Endocrinology',
  'Diabetes',
  'Diabetes Care',
  'Diabetologia',
  'Journal of Bone and Mineral Research',
  'Osteoporosis International',
  'Arthritis & Rheumatology',
  'Annals of the Rheumatic Diseases',
  'Blood',
  'Haematologica',
  'Journal of Clinical Endocrinology & Metabolism',
  'Cancer',
  'Cancer Cell',
  'Cancer Research',
  'Journal of the National Cancer Institute',
  'International Journal of Cancer',
  'Oncogene',
  'Oncology',
  'Leukemia',
  'British Journal of Cancer',
  'Lung Cancer',
  'Prostate',
  'Urology',

  // Biochemistry / molecular biology (not economics):
  'Nature Biotechnology',
  'Nature Methods',
  'Nature Protocols',
  'Nature Chemical Biology',
  'Nature Genetics',
  'Nature Immunology',
  'Nature Neuroscience',
  'Nucleic Acids Research',
  'Journal of Biological Chemistry',
  'Biochemistry',
  'Biochemical Journal',
  'Molecular Biology of the Cell',
  'Molecular and Cellular Biology',
  'EMBO Journal',
  'EMBO Reports',
  'eLife',

  // Clinical guidelines series:
  'Cochrane Database of Systematic Reviews',
  'American Journal of Clinical Nutrition',
  'Clinical Nutrition',

  // Crystallography / chemistry / physics (definitionally non-econ):
  'Acta Crystallographica Section A',
  'Acta Crystallographica Section B',
  'Acta Crystallographica Section C',
  'Acta Crystallographica Section D',
  'Acta Crystallographica Section E',
  'Journal of Applied Crystallography',
  'Crystal Growth & Design',
  'CrystEngComm',
  'Dalton Transactions',
  'Inorganic Chemistry',
  'Journal of the American Chemical Society',
  'Angewandte Chemie',
  'Chemistry - A European Journal',
  'Organic Letters',
  'Journal of Organic Chemistry',
  'Tetrahedron',
  'Physical Review Letters',
  'Physical Review B',
  'Physical Review E',
  'Journal of Physics',
  'Applied Physics Letters',
];

// Venues that could be dual-use (health economics in medical journals) —
// we sample these but flag as REVIEW-NEEDED, not auto-flag.
const DUAL_USE_VENUES = [
  'Health Affairs',
  'Health Policy',
  'Health Economics',
  'Medical Care',
  'Value in Health',
  'American Journal of Public Health',
  'Bulletin of the World Health Organization',
  'Tropical Medicine & International Health',
  'Malaria Journal',
  'Emerging Infectious Diseases',
  'Social Science & Medicine',
  'Journal of Health Economics',
];

const PAGE = 1000; // PostgREST max per request

async function countVenue(venue) {
  const { count, error } = await sb.from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .ilike('venue', venue);
  if (error) return { venue, count: null, error: error.message };
  return { venue, count: count || 0 };
}

async function sampleVenue(venue, n = 8) {
  const { data, error } = await sb.from('works')
    .select('id, title, venue, authors, citation_count, year, abstract')
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .ilike('venue', venue)
    .order('citation_count', { ascending: false })
    .limit(n);
  if (error) return [];
  return data || [];
}

async function checkDenylisted(venue) {
  // Check if a denylist entry mentioning this venue already exists (by reason field)
  const { count } = await sb.from('corpus_denylist')
    .select('*', { count: 'exact', head: true })
    .ilike('reason', `%${venue}%`);
  return count || 0;
}

console.log('\n=== BIOMEDICAL VENUE AUDIT ===');
console.log('Querying corpus for candidate venues...\n');

const results = [];

for (const venue of CANDIDATE_VENUES) {
  const { count } = await countVenue(venue);
  if (count > 0) {
    const sample = await sampleVenue(venue, 8);
    results.push({ venue, count, sample, category: 'candidate' });
    process.stdout.write(`  ${venue}: ${count} papers\n`);
  }
}

console.log('\n--- Dual-use venues (health economics context — REVIEW NEEDED) ---\n');
const dualResults = [];
for (const venue of DUAL_USE_VENUES) {
  const { count } = await countVenue(venue);
  if (count > 0) {
    const sample = await sampleVenue(venue, 5);
    dualResults.push({ venue, count, sample, category: 'dual_use' });
    process.stdout.write(`  ${venue}: ${count} papers\n`);
  }
}

// Also probe by DOI prefix patterns common in biomedical literature
console.log('\n--- DOI-prefix biomedical probes ---\n');
const doiProbes = [
  { prefix: '10.1056/%', label: 'NEJM' },
  { prefix: '10.1016/j.cell%', label: 'Cell (Elsevier)' },
  { prefix: '10.1016/s0140-6736%', label: 'Lancet (old)' },
  { prefix: '10.1001/%', label: 'JAMA family' },
  { prefix: '10.1136/%', label: 'BMJ family' },
  { prefix: '10.1016/j.cmet%', label: 'Cell Metabolism' },
  { prefix: '10.1016/j.chom%', label: 'Cell Host & Microbe' },
  { prefix: '10.1074/jbc%', label: 'JBC' },
  { prefix: '10.1038/nm%', label: 'Nature Medicine' },
  { prefix: '10.1038/ng%', label: 'Nature Genetics' },
  { prefix: '10.1038/ni%', label: 'Nature Immunology' },
  { prefix: '10.1038/nn%', label: 'Nature Neuroscience' },
  { prefix: '10.1093/nar%', label: 'Nucleic Acids Research' },
  { prefix: '10.7554/elife%', label: 'eLife' },
  { prefix: '10.1371/journal.pmed%', label: 'PLOS Medicine' },
  { prefix: '10.1371/journal.pbio%', label: 'PLOS Biology' },
  { prefix: '10.1093/infdis%', label: 'J Infectious Diseases' },
  { prefix: '10.1093/cid%', label: 'Clinical Infectious Diseases' },
  { prefix: '10.1182/blood%', label: 'Blood' },
  { prefix: '10.2337/diabetes%', label: 'Diabetes' },
  { prefix: '10.2337/dc%', label: 'Diabetes Care' },
  { prefix: '10.1007/s00125%', label: 'Diabetologia' },
  { prefix: '10.1161/circ%', label: 'Circulation' },
  { prefix: '10.1016/j.jacc%', label: 'JACC' },
  { prefix: '10.1093/eurheartj%', label: 'European Heart Journal' },
  { prefix: '10.1161/strokeaha%', label: 'Stroke' },
  { prefix: '10.1212/wnl%', label: 'Neurology' },
  { prefix: '10.1093/brain%', label: 'Brain' },
  { prefix: '10.1523/jneurosci%', label: 'J Neuroscience' },
  { prefix: '10.1053/j.gastro%', label: 'Gastroenterology' },
  { prefix: '10.1016/j.jhep%', label: 'J Hepatology' },
  { prefix: '10.1093/hmg%', label: 'Human Molecular Genetics' },
  { prefix: '10.1002/ijc%', label: 'Int J Cancer' },
  { prefix: '10.1200/jco%', label: 'J Clinical Oncology' },
  { prefix: '10.1158/0008-5472%', label: 'Cancer Research' },
  { prefix: '10.1093/jnci%', label: 'J National Cancer Institute' },
  { prefix: '10.1107/%', label: 'Acta Crystallographica / IUCr' },
  { prefix: '10.1021/ja%', label: 'JACS' },
  { prefix: '10.1002/ange%', label: 'Angewandte Chemie (German)' },
  { prefix: '10.1002/chem%', label: 'Chem Eur J' },
  { prefix: '10.1021/ol%', label: 'Organic Letters' },
  { prefix: '10.1021/jo%', label: 'J Organic Chemistry' },
  { prefix: '10.1016/j.tet%', label: 'Tetrahedron' },
];

const doiResults = [];
for (const { prefix, label } of doiProbes) {
  const { count, error } = await sb.from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true)
    .like('id', prefix);
  if (!error && count > 0) {
    const { data: sample } = await sb.from('works')
      .select('id, title, venue, authors, citation_count, year, abstract')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .like('id', prefix)
      .order('citation_count', { ascending: false })
      .limit(5);
    doiResults.push({ prefix, label, count, sample: sample || [], category: 'doi_prefix' });
    process.stdout.write(`  [${label}] ${prefix}: ${count} papers\n`);
  }
}

// Summary
console.log('\n=== SUMMARY ===');
console.log(`Candidate venues with papers: ${results.filter(r => r.count > 0).length}`);
console.log(`DOI prefix hits: ${doiResults.length}`);

const totalCandidate = results.reduce((s, r) => s + (r.count || 0), 0);
console.log(`Total candidate papers (venue match): ${totalCandidate}`);
const totalDoi = doiResults.reduce((s, r) => s + (r.count || 0), 0);
console.log(`Total candidate papers (DOI prefix match): ${totalDoi}`);

const report = {
  generated_at: new Date().toISOString(),
  phase: 'audit',
  candidate_venues: results,
  dual_use_venues: dualResults,
  doi_prefix_results: doiResults,
  summary: {
    candidate_venues_with_papers: results.filter(r => r.count > 0).length,
    doi_prefix_hits: doiResults.length,
    total_candidate_papers_venue: totalCandidate,
    total_candidate_papers_doi: totalDoi,
  }
};

fs.writeFileSync('reports/biomedical-audit-2026-06-10.json', JSON.stringify(report, null, 2));
console.log('\nFull report written to reports/biomedical-audit-2026-06-10.json');
