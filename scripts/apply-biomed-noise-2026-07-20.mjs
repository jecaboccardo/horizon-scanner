#!/usr/bin/env node
/**
 * apply-biomed-noise-2026-07-20.mjs — DESTRUCTIVE on --apply (flags is_noise,
 * nulls embedding, inserts corpus_denylist). Sibling of
 * apply-apparatus-denylist-corpuswide.mjs, same verify-before-flag /
 * audit-before-commit method.
 *
 * Flags a set of mono-disciplinary biomedical/neuroscience/immunology/
 * cell-biology venues that entered the corpus AFTER the 2026-06-12 non-econ
 * denylist pass (probe-noneecon-contamination.mjs's static venue list predates
 * them). Spot-checked 2026-07-20: every sampled title across all 49 venues is
 * pure lab/clinical biology with zero economics/development relevance (e.g.
 * "Rutin prevents tau pathology and neuroinflammation in a mouse model",
 * "Exosomes derived from human umbilical cord blood mesenchymal stem cells").
 *
 * Same hard protect-guard as the non-econ probe: a row is NEVER flagged if its
 * fields_of_study overlaps the econ/social set (keeps any genuine health-econ /
 * development paper that happens to sit in one of these venues).
 *
 * GOLDEN RULE: only mutations per row are is_noise=true, noise_reason,
 * embedding=null (active qwen-768 col), and a corpus_denylist upsert. Apply
 * re-checks each row (canonical / non-noise / still fails protect-guard)
 * before write.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-biomed-noise-2026-07-20.mjs --dry-run
 *   node --env-file=.env scripts/apply-biomed-noise-2026-07-20.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const REASON = 'biomed_noneecon_2026_07_20';

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
const has = (f, set) => Array.isArray(f) && f.some(x => set.has(x));

// Mono-disciplinary biomedical venues found 2026-07-20 (bio/cell/molecular/neuro
// venue-name census), verified by title sample — none in the 2026-06-12 list.
const VENUES = [
  'Science Immunology', 'Journal of Neuroinflammation', 'Cell Death and Disease',
  'Frontiers in Microbiology', 'Acta Neuropathologica', 'Cell Death Discovery', 'Neuron',
  'Frontiers in Cellular and Infection Microbiology', 'Stem Cell Research & Therapy',
  'Journal of NeuroEngineering and Rehabilitation', 'Microbiology Spectrum',
  'Frontiers in Neurorobotics', 'Neuropsychopharmacology', 'Diagnostic microbiology and infectious disease',
  'Virology', 'Neurourology and Urodynamics', 'Annual Review of Immunology', 'eNeuro',
  'Trends in Neurosciences', 'European Neuropsychopharmacology', 'Molecular Neurobiology',
  'Neurospine', 'European Journal of Immunology', 'Neurological Sciences',
  'Annual Review of Biochemistry', 'Biochemical and Biophysical Research Communications',
  'BMC Genomic Data', 'Neuropharmacology', 'Neurosurgical Focus',
  'Cellular Molecular and Biomedical Reports', 'Molecular and Cellular Neuroscience',
  'Journal of Cellular Biochemistry', 'G3 Genes Genomes Genetics', 'Journal of Hepatocellular Carcinoma',
  'Journal of Extracellular Biology', 'Journal of Biochemical and Molecular Toxicology',
  'Journal of Microbiology Immunology and Infection', 'Neuropathology and Applied Neurobiology',
  'FEMS Microbiology Ecology', 'Microbial Cell Factories', 'Biochemia Medica',
  'Journal of Molecular and Cellular Cardiology',
  'American Journal of Physiology-Lung Cellular and Molecular Physiology',
  'Molecular and Cellular Therapies',
];

async function fetchVenueRows(venue) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from('works')
      .select('id,title,venue,citation_count,fields_of_study,is_noise,canonical_work_id')
      .eq('venue', venue).is('canonical_work_id', null).not('is_noise', 'is', true)
      .range(offset, offset + 999);
    if (error) { console.error(`  ERR [${venue}]`, error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

(async () => {
  console.log(`=== BIOMED NON-ECON DENYLIST (${APPLY ? 'APPLY' : 'DRY-RUN'}) — reason=${REASON} ===\n`);

  const flagged = [];
  const protectedRows = [];
  for (const v of VENUES) {
    const rows = await fetchVenueRows(v);
    for (const r of rows) {
      if (has(r.fields_of_study, ECON_SOCIAL)) protectedRows.push(r);
      else flagged.push(r);
    }
    if (rows.length) console.log(`  ${String(rows.length).padStart(4)} total (${rows.filter(r=>has(r.fields_of_study,ECON_SOCIAL)).length} protected) | ${v}`);
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`  flaggable: ${flagged.length}`);
  console.log(`  protected (held, not flagged): ${protectedRows.length}`);

  const report = {
    generated_at: new Date().toISOString(), apply: APPLY, reason: REASON,
    venues: VENUES, flaggable_count: flagged.length, protected_count: protectedRows.length,
    flagged: flagged.map(r => ({ id: r.id, title: r.title, venue: r.venue, citation_count: r.citation_count, fields_of_study: r.fields_of_study })),
    protected: protectedRows.map(r => ({ id: r.id, title: r.title, venue: r.venue, fields_of_study: r.fields_of_study })),
  };

  if (!APPLY) {
    fs.writeFileSync('reports/biomed-noise-dryrun-2026-07-20.json', JSON.stringify(report, null, 2));
    console.log('\nDRY-RUN report: reports/biomed-noise-dryrun-2026-07-20.json');
    process.exit(0);
  }

  console.log(`\n=== APPLYING ${flagged.length} rows (batched, per-row re-check) ===`);
  let denylisted = 0, flaggedW = 0, skip = 0, errs = 0;
  const skippedRows = [];
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  let done = 0;
  for (const batch of chunk(flagged, 75)) {
    const ids = batch.map(r => r.id);
    const { data: live, error: ferr } = await sb.from('works')
      .select('id,venue,is_noise,canonical_work_id,fields_of_study').in('id', ids);
    if (ferr) { console.error('refetch batch', ferr.message); errs += batch.length; continue; }
    const liveById = new Map((live || []).map(r => [r.id, r]));

    for (const t of batch) {
      const r = liveById.get(t.id);
      if (!r) { skip++; skippedRows.push({ id: t.id, why: 'row_gone' }); continue; }
      if (r.is_noise === true || r.canonical_work_id != null) { skip++; skippedRows.push({ id: t.id, why: 'already_noise_or_shadow' }); continue; }
      if (has(r.fields_of_study, ECON_SOCIAL)) { skip++; skippedRows.push({ id: t.id, why: 'now_protected_recheck' }); continue; }

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

  report.result = { denylisted, works_flagged: flaggedW, skipped_recheck: skip, errors: errs };
  report.skipped_sample = skippedRows.slice(0, 80);
  fs.writeFileSync('reports/biomed-noise-apply-2026-07-20.json', JSON.stringify(report, null, 2));
  console.log(`\n=== APPLIED ===`);
  console.log(`  denylisted=${denylisted} works_flagged=${flaggedW} skipped=${skip} errors=${errs}`);
  console.log(`  Report: reports/biomed-noise-apply-2026-07-20.json`);
})();
