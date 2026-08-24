#!/usr/bin/env node
/** POST-COMMIT AUDIT for the non-econ denylist apply (2026-06-12). Read-only. */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
const DROPPED = ['Climatic Change','Water Resources Research','EClinicalMedicine','Quality of Life Research','Health and Quality of Life Outcomes'];
const NEURO = ['Pain','NeuroImage','Human Brain Mapping'];

const report = JSON.parse(fs.readFileSync('reports/noneecon-denylist-apply-2026-06-12.json','utf8'));

(async () => {
  const out = { generated_at: new Date().toISOString(), checks: {} };

  // 1) sample 20 flagged rows -> confirm all is_noise + embedding null + non-econ FOS
  const ids = report.flagged_ids;
  const pick = [];
  for (let k=0;k<20;k++) pick.push(ids[Math.floor(Math.random()*ids.length)]);
  const { data: flaggedRows } = await sb.from('works')
    .select('id,venue,is_noise,embedding,fields_of_study,title,sms_level,citation_count,authors,abstract')
    .in('id', pick);
  const sampleFlagged = (flaggedRows||[]).map(r => ({
    id:r.id, venue:r.venue, is_noise:r.is_noise, embedding_null:r.embedding==null,
    has_econ_social: has(r.fields_of_study, ECON_SOCIAL),
    sms_present: r.sms_level!=null, cites: r.citation_count, has_authors: Array.isArray(r.authors)&&r.authors.length>0,
    has_abstract: !!r.abstract, title:(r.title||'').slice(0,60), fos:(r.fields_of_study||[]).slice(0,6),
  }));
  out.checks.sample_flagged = {
    n: sampleFlagged.length,
    all_is_noise: sampleFlagged.every(r=>r.is_noise===true),
    all_embedding_null: sampleFlagged.every(r=>r.embedding_null),
    any_econ_social: sampleFlagged.some(r=>r.has_econ_social),
    rows: sampleFlagged,
  };

  // 2) protect-guard boundary: confirm 0 econ/social rows got flagged with our reason
  //    Count denylist rows with our reason whose work still has econ/social FOS.
  const { data: dl } = await sb.from('corpus_denylist').select('work_id').eq('reason','non_econ_field_2026_06_12').limit(100000);
  const dlIds = (dl||[]).map(r=>r.work_id);
  out.checks.denylist_rows_with_reason = dlIds.length;
  let econViolations = 0; const violRows = [];
  for (let i=0;i<dlIds.length;i+=500) {
    const chunk = dlIds.slice(i,i+500);
    const { data } = await sb.from('works').select('id,venue,fields_of_study').in('id', chunk);
    for (const r of (data||[])) if (has(r.fields_of_study, ECON_SOCIAL)) { econViolations++; if (violRows.length<20) violRows.push({id:r.id,venue:r.venue,fos:r.fields_of_study}); }
  }
  out.checks.protect_guard = { econ_social_violations: econViolations, sample: violRows };

  // 3) dropped venues: confirm none flagged with our reason; and they still have live non-noise rows
  out.checks.dropped_venues = {};
  for (const v of DROPPED) {
    const { count: flaggedCnt } = await sb.from('works').select('id',{count:'exact',head:true})
      .eq('venue', v).eq('is_noise', true).is('canonical_work_id', null);
    const { count: liveCnt } = await sb.from('works').select('id',{count:'exact',head:true})
      .eq('venue', v).not('is_noise','is',true).is('canonical_work_id', null);
    // Which of the flagged ones (if any) carry OUR reason?
    const { data: vIds } = await sb.from('works').select('id').eq('venue', v).eq('is_noise', true).is('canonical_work_id', null).limit(5000);
    let ourReason = 0;
    const vidList = (vIds||[]).map(r=>r.id);
    for (let i=0;i<vidList.length;i+=500){const ch=vidList.slice(i,i+500);const {data}=await sb.from('corpus_denylist').select('work_id').eq('reason','non_econ_field_2026_06_12').in('work_id',ch);ourReason+=(data||[]).length;}
    out.checks.dropped_venues[v] = { flagged_total: flaggedCnt, flagged_by_our_reason: ourReason, live_nonnoise: liveCnt };
  }

  // 4) neuro/clinical venues: confirm they WERE flagged (sanity), count by our reason
  out.checks.neuro_venues = {};
  for (const v of NEURO) {
    const { data: vIds } = await sb.from('works').select('id').eq('venue', v).eq('is_noise', true).limit(5000);
    const vidList = (vIds||[]).map(r=>r.id);
    let ourReason = 0;
    for (let i=0;i<vidList.length;i+=500){const ch=vidList.slice(i,i+500);const {data}=await sb.from('corpus_denylist').select('work_id').eq('reason','non_econ_field_2026_06_12').in('work_id',ch);ourReason+=(data||[]).length;}
    const { count: liveCnt } = await sb.from('works').select('id',{count:'exact',head:true}).eq('venue', v).not('is_noise','is',true).is('canonical_work_id', null);
    out.checks.neuro_venues[v] = { flagged_by_our_reason: ourReason, remaining_live_nonnoise: liveCnt };
  }

  // 5) new canonical non-noise total
  const { count: canonNonNoise } = await sb.from('works').select('id',{count:'exact',head:true})
    .is('canonical_work_id', null).not('is_noise','is', true);
  out.checks.canonical_non_noise_total = canonNonNoise;

  // 6) confirm flagged rows are gone from the active set (0 of our flagged remain non-noise)
  let stillActive = 0;
  for (let i=0;i<ids.length;i+=500){const ch=ids.slice(i,i+500);const {data}=await sb.from('works').select('id,is_noise,canonical_work_id').in('id',ch);for(const r of (data||[])) if(r.is_noise!==true) stillActive++;}
  out.checks.flagged_still_active = stillActive;

  fs.writeFileSync('reports/noneecon-denylist-audit-2026-06-12.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.checks, (k,v)=> k==='rows'? `[${v.length} rows]` : (k==='sample'&&Array.isArray(v)?`[${v.length}]`:v), 2));
})();
