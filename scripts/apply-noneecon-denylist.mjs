#!/usr/bin/env node
/**
 * apply-noneecon-denylist.mjs — DESTRUCTIVE (flags is_noise, nulls embedding,
 * inserts corpus_denylist). Mirrors apply-clearcut-denylist.mjs.
 *
 * Re-derives the candidate set LIVE from the DB with the APPROVED REFINEMENTS:
 *   - Track A: monodisciplinary non-econ venues MINUS 5 dropped venues.
 *   - Track B: mixed mega-venues, threshold >=3 decisive non-econ FOS markers.
 *   - HARD protect-guard (both tracks): never flag a row whose FOS overlaps ECON_SOCIAL.
 *   - Apply-time re-check: each row re-verified (still canonical, still not noise,
 *     venue still matches, FOS still passes track + protect-guard) immediately
 *     before the write, in the same loop iteration.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-noneecon-denylist.mjs --dry-run
 *   node --env-file=.env scripts/apply-noneecon-denylist.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PAGE = 1000;
const APPLY = process.argv.includes('--apply');
const REASON = 'non_econ_field_2026_06_12';

// ---- PROTECT-SET (verbatim from probe) ----
const ECON_SOCIAL = new Set([
  'Economics','Econometrics','Finance','Financial economics','Macroeconomics','Microeconomics',
  'Development economics','Labour economics','Labor economics','Public economics','International economics',
  'Monetary economics','Agricultural economics','Environmental economics','Behavioural economics',
  'Behavioral economics','Welfare economics','Natural resource economics','Mathematical economics',
  'Law and economics','Demographic economics','Political economy','Economic growth','Economic geography',
  'Business','Marketing','Accounting','Management','Management science','Strategic management',
  'Industrial organization','Operations management','Corporate governance','Entrepreneurship',
  'Political science','Sociology','Social science','Anthropology','Public administration','Public policy',
  'Law','Demography','Education','Pedagogy','Human geography','Gender studies','Development studies',
  'Actuarial science','Criminology','Social psychology','International trade','Public finance',
]);

const DECISIVE_NONECON = new Set([
  'Genetics','Genome','Gene','Genomics','Gene expression','DNA','DNA sequencing','RNA-Seq',
  'Peptide sequence','Single-nucleotide polymorphism','Genotype','Genotyping','Reference genome',
  'Computational biology','Bioinformatics','Bioconductor','Sequence alignment','Sequence assembly',
  'Molecular biology','Cell biology','Microbiology','Virology','Immunology','Biochemistry',
  'Gene regulatory network','Genome-wide association study','Microbiome','Metagenomics','Phylogenetic tree',
  'Evolutionary biology','Botany','Taxonomy (biology)','Saccharomyces cerevisiae','Prokaryote','DNA microarray',
  'Protein structure','Protein structure prediction','Structural bioinformatics','Transcriptome',
  'Internal medicine','Endocrinology','Cardiology','Oncology','Cancer research','Pathology','Surgery',
  'Nursing','Radiology','Pharmacology','Physiology','Anatomy','Sepsis','Septic shock','Pneumonia',
  'Diabetes mellitus','Insulin resistance','Coronavirus','Severe acute respiratory syndrome coronavirus 2 (SARS-CoV-2)',
  'Intensive care medicine','Cholesterol','Blood pressure','Obesity','Comorbidity','Epidemiology',
  'Organic chemistry','Inorganic chemistry','Physical chemistry','Crystallography','Cheminformatics',
  'Materials science','Metallurgy','Nanotechnology','Condensed matter physics','Quantum mechanics',
  'Astrophysics','Statistical physics','Spintronics','Optics','Geology','Meteorology','Climatology',
  'Seismology','Hydrology','Remote sensing',
  'Convolutional neural network','Deep learning','Computer vision','Artificial neural network',
  'Autoencoder','Support vector machine','Image (mathematics)','Contextual image classification',
]);

// ---- TRACK A venues (verbatim from probe) ----
const VENUE_TARGETS_ALL = [
  'Bioinformatics','BMC Bioinformatics','Genome Research','Computer applications in the biosciences',
  'Briefings in Bioinformatics','Journal of Computational Biology','GigaScience','Current Protocols in Bioinformatics',
  'Frontiers in Neuroinformatics','Genes & Development','Protein Science','Protein Engineering Design and Selection',
  'Microbiome','Nature Microbiology','INTERNATIONAL JOURNAL OF SYSTEMATIC AND EVOLUTIONARY MICROBIOLOGY',
  'Applied and Environmental Microbiology','The ISME Journal','Journal of Extracellular Vesicles',
  'Signal Transduction and Targeted Therapy','The FASEB Journal','Electrophoresis','The Journal of Physiology',
  'Journal of Applied Physiology','Circulation Research','Frontiers in Plant Science',
  'CA: A Cancer Journal for Clinicians','European Respiratory Journal','JNCI Journal of the National Cancer Institute',
  'Cancer','International Journal of Cancer','The Journal of Urology','Obstetrics and Gynecology','Human Reproduction',
  'Age and Ageing','The Journals of Gerontology Series A','Journal of Gerontology','The Gerontologist',
  'The American Journal of Gastroenterology','Hepatogastroenterology','EP Europace','European Journal of Heart Failure',
  'Journal of the American Society of Nephrology','SLEEP','Pain','Physical Therapy','EClinicalMedicine',
  'NeuroImage','Human Brain Mapping','The Lancet Infectious Diseases','Emerging infectious diseases',
  'Eurosurveillance','MMWR Morbidity and Mortality Weekly Report','MMWR Surveillance Summaries',
  'MMWR Recommendations and Reports','Public Health Reports','Quality of Life Research',
  'Health and Quality of Life Outcomes','International Journal of Methods in Psychiatric Research',
  'Angewandte Chemie International Edition','Angewandte Chemie International Edition in English','Advanced Materials',
  'ACS Nano','Nano Letters','Advanced Energy Materials','Advanced Functional Materials','Macromolecules',
  'Langmuir','Optics Express','Journal of The Electrochemical Society','Materials Today','Journal of Cheminformatics',
  'npj Computational Materials','High Pressure Research',
  'The Astrophysical Journal','The Astrophysical Journal Letters','The Astrophysical Journal Supplement Series',
  'Monthly Notices of the Royal Astronomical Society','Journal of Geophysical Research Atmospheres',
  'Journal of Climate','Bulletin of the American Meteorological Society','Quarterly Journal of the Royal Meteorological Society',
  'International Journal of Climatology','Monthly Weather Review','Journal of Hydrometeorology','Geophysical Research Letters',
  'Global Biogeochemical Cycles','Hydrological Processes','Water Resources Research','Climatic Change',
  'Bulletin of the Seismological Society of America','Journal of Fluid Mechanics','Geoscientific model development',
  'Earth system science data','Hydrology and earth system sciences','Journal of Atmospheric and Oceanic Technology',
  'Marine Ecology Progress Series','Review of Scientific Instruments',
  'The Journal of the Acoustical Society of America','Eos',
  'Ecology','Ecology Letters','Methods in Ecology and Evolution','Journal of Animal Ecology','Journal of Ecology',
  'Journal of Applied Ecology','Ecological Applications','Ecological Monographs','Global Ecology and Biogeography',
  'Journal of Biogeography','The American Naturalist','Oikos','Evolution','Annual Review of Ecology and Systematics',
  'Annual Review of Ecology Evolution and Systematics','Environmental Conservation','BioScience',
  'Neural Computation','Journal of Machine Learning Research','Journal of Artificial Intelligence Research',
  'Proceedings of the AAAI Conference on Artificial Intelligence','Proceedings of the International AAAI Conference on Web and Social Media',
  'International Journal of Computer Vision','Machine Learning','Foundations and Trends® in Machine Learning',
  'The International Journal of Robotics Research','Evolutionary Computation','Transactions of the Association for Computational Linguistics',
  'Computational Linguistics','Computational Visual Media',
  'International Journal for Numerical Methods in Engineering','Transactions of the ASABE','Procedia CIRP',
];

// REFINEMENT 1: drop these 5 IADB-relevant venues from Track A.
const DROPPED_VENUES = new Set([
  'Climatic Change','Water Resources Research','EClinicalMedicine',
  'Quality of Life Research','Health and Quality of Life Outcomes',
]);
const VENUE_TARGETS = VENUE_TARGETS_ALL.filter(v => !DROPPED_VENUES.has(v));
const VENUE_SET = new Set(VENUE_TARGETS);

const MIXED_VENUES = [
  'Science','Nature','Proceedings of the National Academy of Sciences','Nature Communications',
  'Scientific Reports','PLoS ONE','Science Advances','Nature Human Behaviour',
];

// REFINEMENT 2: Track B threshold >=3.
const TRACK_B_MIN = 3;
// REFINEMENT 4: clinical/neuro venues whose low-cite tail must be eyeballed.
const EYEBALL_VENUES = new Set(['Pain','NeuroImage','Human Brain Mapping']);

const has = (f, set) => Array.isArray(f) && f.some(x => set.has(x));
const countIn = (f, set) => Array.isArray(f) ? f.filter(x => set.has(x)).length : 0;

async function pageThrough(applyFilters) {
  const rows = []; let offset = 0;
  while (true) {
    let q = sb.from('works')
      .select('id,title,venue,citation_count,year,fields_of_study,authors,abstract,is_noise,canonical_work_id')
      .is('canonical_work_id', null).not('is_noise', 'is', true);
    q = applyFilters(q);
    const { data, error } = await q.range(offset, offset + PAGE - 1);
    if (error) { console.error('  ERR', error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

// row passes Track A criteria
const passesTrackA = (r) => VENUE_SET.has(r.venue) && !has(r.fields_of_study, ECON_SOCIAL);
// row passes Track B criteria
const passesTrackB = (r) => MIXED_VENUES.includes(r.venue)
  && !has(r.fields_of_study, ECON_SOCIAL)
  && countIn(r.fields_of_study, DECISIVE_NONECON) >= TRACK_B_MIN;

(async () => {
  console.log(`=== NON-ECON DENYLIST APPLY (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  console.log(`Track A venues: ${VENUE_TARGETS.length} (dropped ${DROPPED_VENUES.size}) | Track B min markers: ${TRACK_B_MIN}\n`);

  // ---- TRACK A ----
  const trackA = [];
  const eyeballRows = [];
  for (const v of VENUE_TARGETS) {
    const rows = await pageThrough(q => q.eq('venue', v));
    const flaggable = rows.filter(r => !has(r.fields_of_study, ECON_SOCIAL));
    const protectedOut = rows.length - flaggable.length;
    if (rows.length) console.log(`  [A] ${String(rows.length).padStart(5)} (${protectedOut} protected) | ${v}`);
    for (const r of flaggable) {
      trackA.push({ ...r, track: 'A_venue', reason: `non-econ venue: ${v}` });
      if (EYEBALL_VENUES.has(v)) eyeballRows.push(r);
    }
  }

  // ---- TRACK B ----
  const trackB = [];
  for (const v of MIXED_VENUES) {
    const rows = await pageThrough(q => q.eq('venue', v));
    let flag = 0, keepSocial = 0, keepAmbig = 0;
    for (const r of rows) {
      if (has(r.fields_of_study, ECON_SOCIAL)) { keepSocial++; continue; }
      const n = countIn(r.fields_of_study, DECISIVE_NONECON);
      if (n >= TRACK_B_MIN) { flag++; trackB.push({ ...r, track: 'B_fos', reason: `mixed venue ${v} — ${n} decisive non-econ FOS (>=${TRACK_B_MIN}), 0 econ/social` }); }
      else keepAmbig++;
    }
    console.log(`  [B] ${v}: flag ${flag} | keep(social) ${keepSocial} | keep(ambiguous) ${keepAmbig} | total ${rows.length}`);
  }

  // dedup by id
  const all = [...trackA, ...trackB];
  const seen = new Set();
  const flagged = all.filter(r => seen.has(r.id) ? false : (seen.add(r.id), true));

  console.log(`\n=== TOTALS ===`);
  console.log(`  Track A: ${trackA.length} | Track B: ${trackB.length} | TOTAL unique: ${flagged.length}`);

  // ---- EYEBALL: lowest-cite tail of Pain/NeuroImage/Human Brain Mapping ----
  const eyeballSorted = eyeballRows.sort((a, b) => (a.citation_count || 0) - (b.citation_count || 0)).slice(0, 12);
  console.log('\n=== EYEBALL — lowest-cite Pain/NeuroImage/Human Brain Mapping (verify all non-econ) ===');
  for (const r of eyeballSorted) {
    console.log(`  [${r.citation_count ?? '—'}] ${r.venue} | ${(r.title || '').slice(0, 70)}`);
    console.log(`        FOS: ${(r.fields_of_study || []).slice(0, 8).join(', ')}`);
  }

  const baseReport = {
    generated_at: new Date().toISOString(),
    apply: APPLY,
    refinements: {
      dropped_track_a_venues: [...DROPPED_VENUES],
      track_b_min_markers: TRACK_B_MIN,
      eyeball_venues: [...EYEBALL_VENUES],
    },
    track_a_count: trackA.length,
    track_b_count: trackB.length,
    total_unique: flagged.length,
    venue_targets: VENUE_TARGETS,
    mixed_venues: MIXED_VENUES,
    eyeball_low_cite: eyeballSorted.map(r => ({ id: r.id, venue: r.venue, citation_count: r.citation_count, title: r.title, fields_of_study: r.fields_of_study })),
  };

  if (!APPLY) {
    baseReport.flagged = flagged.map(r => ({ id: r.id, title: r.title, venue: r.venue, year: r.year, citation_count: r.citation_count, fields_of_study: r.fields_of_study, track: r.track, reason: r.reason }));
    fs.writeFileSync('reports/noneecon-denylist-dryrun-refined-2026-06-12.json', JSON.stringify(baseReport, null, 2));
    console.log('\nDRY-RUN report: reports/noneecon-denylist-dryrun-refined-2026-06-12.json');
    process.exit(0);
  }

  // ============ APPLY ============
  console.log('\n=== APPLYING (with per-row re-check) ===');
  let denylisted = 0, flaggedW = 0, skippedRecheck = 0, errs = 0;
  const skippedRows = [];
  let i = 0;
  for (const t of flagged) {
    i++;
    // APPLY-TIME RE-CHECK: re-fetch the live row, re-verify ALL guards.
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,venue,fields_of_study,is_noise,canonical_work_id')
      .eq('id', t.id).maybeSingle();
    if (ferr) { console.error('refetch', t.id, ferr.message); errs++; continue; }
    if (!live) { skippedRecheck++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
    if (live.is_noise === true || live.canonical_work_id != null) { skippedRecheck++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
    // protect-guard re-check (HARD)
    if (has(live.fields_of_study, ECON_SOCIAL)) { skippedRecheck++; skippedRows.push({ id: t.id, why: 'now_econ_social_fos' }); continue; }
    // track re-check
    const okA = t.track === 'A_venue' && passesTrackA(live);
    const okB = t.track === 'B_fos' && passesTrackB(live);
    if (!okA && !okB) { skippedRecheck++; skippedRows.push({ id: t.id, why: 'no_longer_matches_track', venue: live.venue }); continue; }

    // WRITE: denylist + is_noise + null embedding. Only these fields touched (golden rule).
    const { error: e1 } = await sb.from('corpus_denylist')
      .upsert({ work_id: t.id, reason: REASON }, { onConflict: 'work_id', ignoreDuplicates: true });
    if (e1) { console.error('denylist', t.id, e1.message); errs++; continue; }
    denylisted++;
    const { error: e2 } = await sb.from('works')
      .update({ is_noise: true, embedding: null }).eq('id', t.id);
    if (e2) { console.error('works update', t.id, e2.message); errs++; continue; }
    flaggedW++;
    if (i % 1000 === 0) console.log(`  ...${i}/${flagged.length} (flagged ${flaggedW}, skipped ${skippedRecheck}, err ${errs})`);
  }

  baseReport.result = { denylisted, works_flagged: flaggedW, skipped_recheck: skippedRecheck, errors: errs };
  baseReport.skipped_sample = skippedRows.slice(0, 50);
  baseReport.flagged_ids = flagged.map(r => r.id);
  fs.writeFileSync('reports/noneecon-denylist-apply-2026-06-12.json', JSON.stringify(baseReport, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped_recheck=${skippedRecheck} errors=${errs}`);
  console.log(`  Report: reports/noneecon-denylist-apply-2026-06-12.json`);
})();
