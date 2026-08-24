#!/usr/bin/env node
/**
 * apply-biomedical-noise.mjs
 * Flag biomedical / molecular-biology / crystallography / chemistry papers
 * that are definitively non-economics noise in the corpus.
 *
 * PRE-FLIGHT CHECKLIST (completed 2026-06-10):
 * - Sampled 8-10 papers per venue; confirmed all are clinical/molecular biology
 * - Checked for econ/development-relevant content via title+abstract search
 * - Venues with ANY meaningful dev-economics content are EXCLUDED from this list
 * - Dual-use venues (JAMA, BMJ, Lancet, PLOS ONE, Cochrane etc.) NOT flagged here
 * - The Lancet Regional Health - Americas (659 papers) explicitly excluded — LAC relevant
 *
 * EXCLUDED from flagging (verified dual-use or dev-relevant):
 *   - JAMA / JAMA Network Open (cash transfers, mental health policy, COVID policy)
 *   - BMJ / BMJ Open / BMJ Global Health (PRISMA tools, CCT papers, dev papers)
 *   - The Lancet (GBD studies, maternal nutrition, COVID, development-adjacent)
 *   - The Lancet Regional Health - Americas (659 papers, explicitly LAC)
 *   - Lancet Global Health / Public Health (global health economics)
 *   - PLOS ONE (significant social science / development content)
 *   - PLOS Neglected Tropical Diseases (Chagas, dengue, LAC-relevant)
 *   - Cochrane Database of Systematic Reviews (CCT papers, dev-relevant)
 *   - Int J Cancer / Cancer (GLOBOCAN — cited in development burden studies)
 *   - New England Journal of Medicine / NEJM Evidence (policy-relevant burden papers)
 *   - Emerging Infectious Diseases (epidemiology, development-adjacent)
 *   - Journal of Infectious Diseases (COVID research, kept)
 *   - Health Affairs / Health Economics / Journal of Health Economics (explicitly econ)
 *   - Social Science & Medicine, American Journal of Public Health (development-relevant)
 *   - Bulletin of WHO / Malaria Journal / Tropical Medicine (LAC-relevant)
 *
 * FLAGGING STRATEGY:
 * - For most venues: match by exact venue name (works.venue = 'X')
 * - For IUCr/crystallography: match by DOI prefix 10.1107/%
 * - For Blood/Blood Advances: match by DOI prefix 10.1182/blood%
 *
 * Usage:
 *   node --env-file=.env scripts/apply-biomedical-noise.mjs --dry-run
 *   node --env-file=.env scripts/apply-biomedical-noise.mjs --apply
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

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

// -----------------------------------------------------------------------
// Venue targets — exact venue name matches only.
// These are pure molecular biology, clinical cardiology/neurology,
// crystallography, or biochemistry journals with zero economics content.
// -----------------------------------------------------------------------
const VENUE_TARGETS = [
  // Cell Press / molecular biology
  { venue: 'Cell',                         reason: 'is_noise: Cell — molecular biology / ferroptosis / genomics' },
  { venue: 'Cell Metabolism',              reason: 'is_noise: Cell Metabolism — molecular biology / cell biology' },
  { venue: 'Cancer Cell',                  reason: 'is_noise: Cancer Cell — molecular oncology / tumor biology' },
  { venue: 'Developmental Cell',           reason: 'is_noise: Developmental Cell — cell biology / developmental biology' },
  { venue: 'Cell Reports',                 reason: 'is_noise: Cell Reports — molecular / cell biology' },
  { venue: 'Cell Stem Cell',               reason: 'is_noise: Cell Stem Cell — stem cell biology' },
  { venue: 'Cell Systems',                 reason: 'is_noise: Cell Systems — systems biology' },
  { venue: 'Cell Host & Microbe',          reason: 'is_noise: Cell Host & Microbe — microbiology / virology' },
  { venue: 'Cell Chemical Biology',        reason: 'is_noise: Cell Chemical Biology — chemical biology' },

  // Nature family — molecular/genomics subspecialties
  { venue: 'Nature Methods',              reason: 'is_noise: Nature Methods — bioinformatics tools / computational biology' },
  { venue: 'Nature Biotechnology',        reason: 'is_noise: Nature Biotechnology — genomics / synthetic biology' },
  { venue: 'Nature Immunology',           reason: 'is_noise: Nature Immunology — molecular immunology' },
  { venue: 'Nature Medicine',             reason: 'is_noise: Nature Medicine — molecular/clinical medicine (non-econ)' },
  { venue: 'Nature Genetics',             reason: 'is_noise: Nature Genetics — genomics / genetics' },
  { venue: 'Nature Neuroscience',         reason: 'is_noise: Nature Neuroscience — molecular neuroscience' },
  { venue: 'Nature Cell Biology',         reason: 'is_noise: Nature Cell Biology — cell biology' },
  { venue: 'Nature Chemical Biology',     reason: 'is_noise: Nature Chemical Biology — chemical biology' },
  { venue: 'Nature Structural & Molecular Biology', reason: 'is_noise: NSMB — structural/molecular biology' },
  { venue: 'Nature Protocols',            reason: 'is_noise: Nature Protocols — lab methods / bioinformatics' },

  // Bioinformatics / molecular biology
  { venue: 'Nucleic Acids Research',      reason: 'is_noise: Nucleic Acids Research — bioinformatics databases / genomics tools' },
  { venue: 'Journal of Biological Chemistry', reason: 'is_noise: JBC — biochemistry / molecular biology' },
  { venue: 'Biochemistry',               reason: 'is_noise: Biochemistry — biochemistry (journal)' },
  { venue: 'Biochemical Journal',        reason: 'is_noise: Biochemical Journal — biochemistry' },
  { venue: 'Molecular Biology of the Cell', reason: 'is_noise: Mol Biol Cell — cell biology' },
  { venue: 'Molecular and Cellular Biology', reason: 'is_noise: Mol Cell Biol — molecular/cell biology' },
  { venue: 'Molecular Cell',             reason: 'is_noise: Molecular Cell — molecular biology' },
  { venue: 'EMBO Journal',               reason: 'is_noise: EMBO Journal — molecular biology' },
  { venue: 'EMBO Reports',               reason: 'is_noise: EMBO Reports — molecular biology' },
  { venue: 'eLife',                      reason: 'is_noise: eLife — life sciences / genomics / virology (non-econ)' },

  // Cardiology — pure clinical guidelines and clinical research
  { venue: 'Circulation',                reason: 'is_noise: Circulation — cardiology (clinical guidelines, AHA statistics)' },
  { venue: 'European Heart Journal',     reason: 'is_noise: European Heart Journal — cardiology (ESC guidelines)' },
  { venue: 'Stroke',                     reason: 'is_noise: Stroke — clinical neurology / cerebrovascular medicine' },
  { venue: 'Haematologica',              reason: 'is_noise: Haematologica — hematology' },

  // Neuroscience / neurology
  { venue: 'Brain',                      reason: 'is_noise: Brain — clinical neuroscience / neurology' },
  { venue: 'Journal of Neuroscience',    reason: 'is_noise: Journal of Neuroscience — neuroscience' },
  { venue: 'Annals of Neurology',        reason: 'is_noise: Annals of Neurology — clinical neurology' },
  { venue: 'Neurology',                  reason: 'is_noise: Neurology — clinical neurology / AAN guidelines' },

  // Rheumatology
  { venue: 'Arthritis & Rheumatology',   reason: 'is_noise: Arthritis & Rheumatology — rheumatology guidelines' },
  { venue: 'Annals of the Rheumatic Diseases', reason: 'is_noise: ARD — rheumatology' },

  // Nephrology / renal
  { venue: 'Nephrology Dialysis Transplantation', reason: 'is_noise: Nephrology Dialysis Transplantation — renal medicine' },
  { venue: 'American Journal of Kidney Diseases', reason: 'is_noise: Am J Kidney Diseases — renal medicine / KDOQI guidelines' },
  { venue: 'Kidney International',       reason: 'is_noise: Kidney International — renal medicine' },
  { venue: 'Clinical Journal of the American Society of Nephrology', reason: 'is_noise: CJASN — renal medicine' },

  // Endocrinology (the journal, not the topic)
  { venue: 'Endocrinology',              reason: 'is_noise: Endocrinology — endocrinology (pure clinical/molecular)' },

  // Oncology — molecular oncology (epidemiology burden papers are in Int J Cancer, kept separately)
  { venue: 'Oncogene',                   reason: 'is_noise: Oncogene — molecular oncology / cancer biology' },
  { venue: 'Cancer Cell',               reason: 'is_noise: Cancer Cell — molecular oncology (duplicate, harmless)' },
  { venue: 'British Journal of Cancer', reason: 'is_noise: British Journal of Cancer — clinical oncology' },
  { venue: 'Cancer Research',           reason: 'is_noise: Cancer Research — molecular cancer research' },

  // Crystallography / structural chemistry — definitively non-econ
  { venue: 'Journal of Applied Crystallography', reason: 'is_noise: J Applied Crystallography — X-ray crystallography (SHELX tools etc)' },
  { venue: 'Crystal Growth & Design',   reason: 'is_noise: Crystal Growth & Design — crystallography / materials chemistry' },
  { venue: 'Acta Crystallographica Section A Foundations of Crystallography', reason: 'is_noise: Acta Crystallographica A — crystallography' },
  { venue: 'Acta Crystallographica Section A Foundations and Advances', reason: 'is_noise: Acta Crystallographica A — crystallography' },
  { venue: 'Acta Crystallographica Section B', reason: 'is_noise: Acta Crystallographica B — crystallography' },
  { venue: 'Acta Crystallographica Section C', reason: 'is_noise: Acta Crystallographica C — crystallography' },
  { venue: 'Acta Crystallographica Section D', reason: 'is_noise: Acta Crystallographica D — crystallography' },
  { venue: 'Acta Crystallographica Section E', reason: 'is_noise: Acta Crystallographica E — crystallography' },
  { venue: 'Acta Crystallographica Section B Structural Science', reason: 'is_noise: Acta Cryst B — crystallography' },
  { venue: 'CrystEngComm',              reason: 'is_noise: CrystEngComm — crystal engineering / chemistry' },
  { venue: 'Dalton Transactions',       reason: 'is_noise: Dalton Transactions — inorganic chemistry' },

  // Pure chemistry
  { venue: 'Journal of the American Chemical Society', reason: 'is_noise: JACS — organic/physical chemistry' },
  { venue: 'Angewandte Chemie',         reason: 'is_noise: Angewandte Chemie — chemistry' },
  { venue: 'Chemistry - A European Journal', reason: 'is_noise: Chem Eur J — chemistry' },
  { venue: 'Organic Letters',           reason: 'is_noise: Organic Letters — organic chemistry' },
  { venue: 'Journal of Organic Chemistry', reason: 'is_noise: J Organic Chemistry — organic chemistry' },
  { venue: 'Tetrahedron',               reason: 'is_noise: Tetrahedron — organic chemistry' },
  { venue: 'Inorganic Chemistry',       reason: 'is_noise: Inorganic Chemistry — inorganic chemistry' },

  // Physics
  { venue: 'Physical Review B',        reason: 'is_noise: Physical Review B — condensed matter physics' },
  { venue: 'Physical Review Letters',  reason: 'is_noise: Physical Review Letters — physics' },
  { venue: 'Physical Review E',        reason: 'is_noise: Physical Review E — physics' },

  // Gastroenterology (pure clinical)
  { venue: 'Gut',                       reason: 'is_noise: Gut — gastroenterology (clinical)' },
  { venue: 'Gastroenterology',          reason: 'is_noise: Gastroenterology — clinical gastroenterology' },
  { venue: 'Hepatology',                reason: 'is_noise: Hepatology — clinical hepatology' },
  { venue: 'Journal of Hepatology',     reason: 'is_noise: Journal of Hepatology — clinical hepatology' },

  // Respiratory / critical care
  { venue: 'American Journal of Respiratory and Critical Care Medicine', reason: 'is_noise: AJRCCM — pulmonary/critical care medicine' },

  // Blood disorders / coagulation
  { venue: 'Blood',                     reason: 'is_noise: Blood — hematology (ASH guidelines)' },
  { venue: 'Blood Advances',            reason: 'is_noise: Blood Advances — hematology guidelines' },

  // Immunology
  { venue: 'Journal of Allergy and Clinical Immunology', reason: 'is_noise: JACI — clinical immunology/allergy' },

  // American Journal of Human Genetics
  { venue: 'American Journal of Human Genetics', reason: 'is_noise: AJHG — human genetics / genomics' },
];

// -----------------------------------------------------------------------
// DOI-prefix targets — catches multi-venue families via DOI prefix
// -----------------------------------------------------------------------
const DOI_PREFIX_TARGETS = [
  // IUCr (International Union of Crystallography) — all crystallography
  { prefix: '10.1107/%', reason: 'is_noise: IUCr/Acta Crystallographica (DOI prefix 10.1107) — crystallography / structural chemistry' },
  // Blood / Blood Advances (ASH hematology guidelines)
  { prefix: '10.1182/blood%', reason: 'is_noise: Blood/Blood Advances (DOI prefix 10.1182/blood) — hematology' },
];

const PAGE_SIZE = 1000;

async function fetchByVenue(venue) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from('works')
      .select('id, title, venue, citation_count, year')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .eq('venue', venue)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) { console.error('  ERR:', error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function fetchByDoiPrefix(prefix) {
  const rows = [];
  let offset = 0;
  const cleanPrefix = prefix.replace(/%/g, '');
  while (true) {
    const { data, error } = await sb.from('works')
      .select('id, title, venue, citation_count, year')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .like('id', prefix)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) { console.error('  ERR:', error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// -----------------------------------------------------------------------
// Collect all candidate rows
// -----------------------------------------------------------------------
console.log('\n=== BIOMEDICAL NOISE FLAGGING ===');
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

const allTargets = [];   // { id, title, venue, citation_count, year, reason }
const venueStats = [];

for (const { venue, reason } of VENUE_TARGETS) {
  const rows = await fetchByVenue(venue);
  if (rows.length > 0) {
    for (const r of rows) allTargets.push({ ...r, reason });
    venueStats.push({ type: 'venue', venue, reason, count: rows.length });
    console.log(`  [VENUE] ${venue}: ${rows.length} papers`);
  }
}

for (const { prefix, reason } of DOI_PREFIX_TARGETS) {
  const rows = await fetchByDoiPrefix(prefix);
  if (rows.length > 0) {
    // Deduplicate against venue-matched rows already collected
    const existingIds = new Set(allTargets.map(r => r.id));
    const newRows = rows.filter(r => !existingIds.has(r.id));
    for (const r of newRows) allTargets.push({ ...r, reason });
    venueStats.push({ type: 'doi_prefix', prefix, reason, count: rows.length, new: newRows.length });
    console.log(`  [DOI] ${prefix}: ${rows.length} papers (${newRows.length} not already matched by venue)`);
  }
}

// Deduplicate by id (safety measure)
const seen = new Set();
const deduped = allTargets.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

console.log(`\n=== SUMMARY ===`);
console.log(`Total unique papers to flag: ${deduped.length}`);
console.log(`\nBy venue/prefix:`);
for (const s of venueStats) {
  if (s.type === 'venue') console.log(`  ${s.count.toString().padStart(5)} | ${s.venue}`);
  else console.log(`  ${s.count.toString().padStart(5)} | DOI: ${s.prefix} (${s.new} unique)`);
}

// Show sample of papers to flag (top-cited per venue)
console.log('\n=== SAMPLE (top-cited per group) ===');
const perVenue = {};
for (const r of deduped) {
  const key = r.venue || r.reason.split(' — ')[0];
  if (!perVenue[key]) perVenue[key] = [];
  perVenue[key].push(r);
}
for (const [venue, rows] of Object.entries(perVenue)) {
  const sorted = rows.sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
  console.log(`\n  ${venue} (${rows.length} total):`);
  for (const r of sorted.slice(0, 3)) {
    console.log(`    [${r.year}] cites=${r.citation_count} | ${r.title?.slice(0, 75)}`);
  }
}

// Write report
const report = {
  generated_at: new Date().toISOString(),
  mode: APPLY ? 'apply' : 'dry_run',
  total_unique: deduped.length,
  venue_stats: venueStats,
  rows: deduped.map(r => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, reason: r.reason })),
};
const reportFile = `reports/biomedical-noise-${APPLY ? 'apply' : 'dryrun'}-2026-06-10.json`;
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${reportFile}`);

if (!APPLY) {
  console.log('\nDRY-RUN complete. Review the report, then re-run with --apply to commit.');
  process.exit(0);
}

// -----------------------------------------------------------------------
// APPLY: flag each paper
// -----------------------------------------------------------------------
console.log('\n=== APPLYING ===');
let denylisted = 0, flagged = 0, errors = 0;

for (const r of deduped) {
  // INSERT into corpus_denylist
  const { error: e1 } = await sb.from('corpus_denylist')
    .upsert({ work_id: r.id, reason: r.reason }, { onConflict: 'work_id', ignoreDuplicates: true });
  if (e1) {
    console.error('  denylist ERR:', r.id, e1.message);
    errors++;
  } else {
    denylisted++;
  }

  // UPDATE works: is_noise=true, embedding=NULL
  const { error: e2 } = await sb.from('works')
    .update({ is_noise: true, embedding: null })
    .eq('id', r.id);
  if (e2) {
    console.error('  works ERR:', r.id, e2.message);
    errors++;
  } else {
    flagged++;
  }

  if (denylisted % 100 === 0) process.stdout.write(`  Progress: ${denylisted}/${deduped.length}\r`);
}

report.result = { denylisted, flagged, errors };
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(`\n=== DONE ===`);
console.log(`  Denylisted: ${denylisted}`);
console.log(`  Works flagged: ${flagged}`);
console.log(`  Errors: ${errors}`);

// Verify: check how many remain active
let remainingCount = 0;
for (const { venue } of VENUE_TARGETS.slice(0, 5)) {
  const { count } = await sb.from('works').select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null).not('is_noise', 'is', true).eq('venue', venue);
  if (count && count > 0) {
    console.log(`  WARNING: ${count} rows still active for venue: ${venue}`);
    remainingCount += count;
  }
}
if (remainingCount === 0) console.log('  Verification: all sampled venues cleared from active set.');
