#!/usr/bin/env node
/**
 * A/B test for two proposed JEL quality agent additions:
 *   A) Kris-style citation validator (verify cited DOIs against OA/SS/CrossRef)
 *   B) Multi-agent Devil's Advocate (3 specialist reviewers → synthesis)
 *
 * Runs both on an existing completed JEL paper and compares:
 *   - Output quality / findings
 *   - Latency
 *
 * Usage:
 *   node --env-file=.env scripts/test-jel-agents.mjs [jelPaperId]
 *   node --env-file=.env scripts/test-jel-agents.mjs 370798c2-...   # AI+labor paper
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const JEL_ID = process.argv[2] || '370798c2-39ae-418e-9f10-5e64c2a71cd7';

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const OA_MAILTO    = 'horizon-scanner@iadb.org';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------
async function callGemini(system, user, maxTokens = 4096) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens }
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().catch(()=>'')}`);
  const d = await res.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try { return JSON.parse(text.replace(/^```json\s*/,'').replace(/\s*```$/,'')); }
  catch { return { raw: text }; }
}

// ---------------------------------------------------------------------------
// BASELINE: Current single Devil's Advocate
// ---------------------------------------------------------------------------
async function runBaselineDA(paper, sections) {
  const sectionPreviews = sections
    .filter(s => !['critique','coherence'].includes(String(s.number)))
    .map(s => `§${s.number} "${s.heading}" (${s.wordCount}w):\n${s.body?.split(/\s+/).slice(0,300).join(' ')}…`)
    .join('\n\n---\n\n');

  const system = `You are the Devil's Advocate reviewer for a JEL-style survey paper.
Challenge the paper across 8 dimensions: causal identification, external validity,
publication bias, evidence gaps, contradictory evidence, methodology concentration,
geographic concentration, temporal validity. Be specific and rigorous.
Return JSON: {"critique": "<700-900 word critique>", "topIssues": ["issue1","issue2","issue3"]}`;

  const user = `ARTICLE: ${paper.query}\n\nSECTION PREVIEWS:\n${sectionPreviews}\n\nProvide your critical assessment.`;
  return await callGemini(system, user, 4096);
}

// ---------------------------------------------------------------------------
// ENHANCED: Multi-agent Devil's Advocate (3 specialists → synthesis)
// ---------------------------------------------------------------------------
async function runMultiAgentDA(paper, sections) {
  const sectionPreviews = sections
    .filter(s => !['critique','coherence'].includes(String(s.number)))
    .map(s => `§${s.number} "${s.heading}" (${s.wordCount}w):\n${s.body?.split(/\s+/).slice(0,300).join(' ')}…`)
    .join('\n\n---\n\n');

  const context = `ARTICLE: ${paper.query}\n\nSECTION PREVIEWS:\n${sectionPreviews}`;

  // 3 specialist agents run in parallel, each blind to the others
  const [methodAgent, lacAgent, policyAgent] = await Promise.all([

    callGemini(
      `You are a quantitative methods specialist reviewing a JEL survey paper.
Focus ONLY on: causal identification strategies, threats to internal validity,
publication bias and p-hacking concerns, methodology concentration (over-reliance
on one design), and whether effect sizes are credibly estimated.
Ignore geographic scope and policy implications — that is another reviewer's job.
Return JSON: {"reviewerRole": "methodology", "critique": "<300-400 word specialist critique>", "topIssues": ["issue1","issue2","issue3"]}`,
      context, 2048
    ),

    callGemini(
      `You are a Latin America & Caribbean regional specialist reviewing a JEL survey paper.
Focus ONLY on: external validity for LAC contexts, whether findings from OECD/Asia
can transfer to LAC, geographic concentration of studies, missing LAC countries,
country income heterogeneity (Haiti vs Chile), and informal economy nuances.
Ignore methodology design details — that is another reviewer's job.
Return JSON: {"reviewerRole": "lac_specialist", "critique": "<300-400 word specialist critique>", "topIssues": ["issue1","issue2","issue3"]}`,
      context, 2048
    ),

    callGemini(
      `You are a policy practitioner reviewing a JEL survey paper for IADB economists.
Focus ONLY on: whether the evidence actually informs actionable policy,
evidence-to-policy gaps, implementation feasibility in LAC, missing cost-effectiveness
data, time lags between research and policy relevance, and whether the research
frontier addresses what governments actually need to decide.
Ignore econometric methods — that is another reviewer's job.
Return JSON: {"reviewerRole": "policy_practitioner", "critique": "<300-400 word specialist critique>", "topIssues": ["issue1","issue2","issue3"]}`,
      context, 2048
    ),
  ]);

  // Synthesis agent reads all three and produces unified critique
  const synthSystem = `You are the lead editor synthesizing three independent peer reviews of a JEL survey.
You receive reviews from a methodology specialist, a LAC regional specialist, and a policy practitioner.
Your job: identify where reviewers AGREE (high-priority issues), where they DISAGREE or complement each other,
and produce a unified, non-redundant critique that is richer than any single reviewer.
Return JSON: {
  "critique": "<700-900 word unified critique that credits each specialist's angle>",
  "topIssues": ["top 3 cross-cutting issues all reviewers converge on"],
  "specialistDivergence": "one sentence on where the specialists saw things differently"
}`;

  const synthUser = `METHODOLOGY REVIEW:\n${JSON.stringify(methodAgent, null, 2)}\n\nLAC REVIEW:\n${JSON.stringify(lacAgent, null, 2)}\n\nPOLICY REVIEW:\n${JSON.stringify(policyAgent, null, 2)}\n\nSynthesize into unified critique.`;

  const synthesis = await callGemini(synthSystem, synthUser, 4096);
  return { methodAgent, lacAgent, policyAgent, synthesis };
}

// ---------------------------------------------------------------------------
// KRIS: Citation validator (verify cited DOIs against OpenAlex)
// ---------------------------------------------------------------------------
async function runKrisValidator(sections, works) {
  // Build map of workId → works table entry
  const worksMap = new Map(works.map(w => [w.id, w]));

  // Collect all unique cited workIds from all sections
  const citedIds = new Set();
  for (const s of sections) {
    for (const id of (s.citedWorkIds ?? [])) citedIds.add(id);
  }

  const doiIds = [...citedIds].filter(id => id.startsWith('10.'));
  console.log(`  Kris: validating ${doiIds.length} DOI citations against OpenAlex…`);

  const results = { verified: [], mismatch: [], notFound: [], ssOnly: [] };
  const BATCH = 25;

  for (let i = 0; i < doiIds.length; i += BATCH) {
    const batch = doiIds.slice(i, i + BATCH);
    const filter = `doi:${batch.join('|')}`;
    const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&select=doi,title,authorships&per-page=25&mailto=${OA_MAILTO}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      const oaByDoi = new Map();
      for (const r of (data.results ?? [])) {
        const doi = (r.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
        if (doi) oaByDoi.set(doi, r);
      }

      for (const id of batch) {
        const localWork = worksMap.get(id);
        const oaWork = oaByDoi.get(id.toLowerCase());

        if (!oaWork) {
          results.notFound.push({ id, localTitle: localWork?.title?.slice(0, 60) });
          continue;
        }

        // Compare titles (fuzzy — first 40 chars, lowercased)
        const localTitle = (localWork?.title || '').toLowerCase().replace(/[^\w\s]/g,'').slice(0, 40);
        const oaTitle = (oaWork.title || '').toLowerCase().replace(/[^\w\s]/g,'').slice(0, 40);
        const titleMatch = localTitle.length > 10 && oaTitle.length > 10 &&
          (localTitle.startsWith(oaTitle.slice(0, 20)) || oaTitle.startsWith(localTitle.slice(0, 20)));

        if (titleMatch) {
          results.verified.push({ id, title: localWork?.title?.slice(0, 60) });
        } else {
          results.mismatch.push({
            id,
            localTitle: localWork?.title?.slice(0, 60),
            oaTitle: oaWork.title?.slice(0, 60),
          });
        }
      }
    } catch (e) {
      console.log(`  Kris batch error: ${e.message}`);
    }
    await sleep(120); // ~8 req/s
    process.stdout.write(`\r  Kris: ${Math.min(i + BATCH, doiIds.length)}/${doiIds.length} validated`);
  }
  process.stdout.write('\n');
  return results;
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== JEL Agent A/B Test ===`);
  console.log(`Paper: ${JEL_ID}\n`);

  // Fetch JEL paper + search run + works
  const { data: paper } = await sb.from('jel_papers').select('*').eq('id', JEL_ID).single();
  if (!paper) { console.error('Paper not found. Run with: node ... [jelPaperId]'); process.exit(1); }

  console.log(`Query: ${paper.query?.slice(0, 80)}`);
  console.log(`Sections: ${paper.sections?.length}, Status: ${paper.status}\n`);

  const sections = paper.sections || [];
  const contentSections = sections.filter(s => !['critique','coherence'].includes(String(s.number)));

  // Get evidence works for Kris validation
  const { data: searchRun } = await sb.from('search_runs').select('evidence_work_ids').eq('id', paper.search_run_id).single();
  const evidenceIds = searchRun?.evidence_work_ids?.slice(0, 50) || [];
  const { data: works } = await sb.from('works').select('id, title, authors, year').in('id', evidenceIds);

  console.log(`Evidence works loaded: ${works?.length || 0}\n`);

  const report = { paperId: JEL_ID, query: paper.query, timestamp: new Date().toISOString() };

  // ── Test 1: Baseline DA ──────────────────────────────────────────────────
  console.log('【1/4】 Baseline Devil\'s Advocate (current single-agent)…');
  const t0 = Date.now();
  const baselineDA = await runBaselineDA(paper, contentSections).catch(e => ({ error: e.message }));
  const baselineDAMs = Date.now() - t0;
  console.log(`  ✓ Done in ${(baselineDAMs/1000).toFixed(1)}s`);
  console.log(`  Top issues: ${baselineDA.topIssues?.join(' | ') || 'N/A'}`);
  report.baselineDA = { latencyMs: baselineDAMs, topIssues: baselineDA.topIssues, critiqueLength: baselineDA.critique?.length || 0 };

  // ── Test 2: Multi-agent DA ───────────────────────────────────────────────
  console.log('\n【2/4】 Multi-agent Devil\'s Advocate (3 specialists + synthesis)…');
  const t1 = Date.now();
  const multiDA = await runMultiAgentDA(paper, contentSections).catch(e => ({ error: e.message }));
  const multiDAMs = Date.now() - t1;
  console.log(`  ✓ Done in ${(multiDAMs/1000).toFixed(1)}s`);
  console.log(`  Top issues (synthesis): ${multiDA.synthesis?.topIssues?.join(' | ') || 'N/A'}`);
  console.log(`  Specialist divergence: ${multiDA.synthesis?.specialistDivergence || 'N/A'}`);
  report.multiDA = {
    latencyMs: multiDAMs,
    topIssues: multiDA.synthesis?.topIssues,
    specialistDivergence: multiDA.synthesis?.specialistDivergence,
    critiqueLength: multiDA.synthesis?.critique?.length || 0,
    methodIssues: multiDA.methodAgent?.topIssues,
    lacIssues: multiDA.lacAgent?.topIssues,
    policyIssues: multiDA.policyAgent?.topIssues,
  };

  // ── Test 3: Kris citation validator ─────────────────────────────────────
  console.log('\n【3/4】 Kris citation validator (OpenAlex DOI verification)…');
  const t2 = Date.now();
  const kris = await runKrisValidator(contentSections, works || []).catch(e => ({ error: e.message }));
  const krisMs = Date.now() - t2;
  console.log(`  ✓ Done in ${(krisMs/1000).toFixed(1)}s`);
  console.log(`  Verified: ${kris.verified?.length || 0} | Not in OA: ${kris.notFound?.length || 0} | Title mismatch: ${kris.mismatch?.length || 0}`);
  if (kris.mismatch?.length > 0) {
    console.log('  ⚠️  Mismatches (potential abstract errors):');
    kris.mismatch.forEach(m => console.log(`     [${m.id?.slice(0,20)}] Local: "${m.localTitle}" | OA: "${m.oaTitle}"`));
  }
  report.kris = { latencyMs: krisMs, verified: kris.verified?.length, notFound: kris.notFound?.length, mismatches: kris.mismatch };

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log('TIMING COMPARISON');
  console.log('════════════════════════════════════════');
  console.log(`Baseline DA:      ${(baselineDAMs/1000).toFixed(1)}s`);
  console.log(`Multi-agent DA:   ${(multiDAMs/1000).toFixed(1)}s  (+${((multiDAMs-baselineDAMs)/1000).toFixed(1)}s overhead)`);
  console.log(`Kris validator:   ${(krisMs/1000).toFixed(1)}s`);
  console.log(`Total enhanced:   ${((multiDAMs+krisMs)/1000).toFixed(1)}s vs baseline ${(baselineDAMs/1000).toFixed(1)}s`);

  console.log('\nQUALITY COMPARISON');
  console.log('════════════════════════════════════════');
  console.log(`Baseline critique length: ${report.baselineDA.critiqueLength} chars`);
  console.log(`Multi-agent critique length: ${report.multiDA.critiqueLength} chars`);
  console.log(`\nBaseline top issues:\n  ${baselineDA.topIssues?.map((i,n)=>`${n+1}. ${i}`).join('\n  ')}`);
  console.log(`\nMulti-agent top issues:\n  ${multiDA.synthesis?.topIssues?.map((i,n)=>`${n+1}. ${i}`).join('\n  ')}`);
  console.log(`\nMethodology specialist:\n  ${multiDA.methodAgent?.topIssues?.join('\n  ')}`);
  console.log(`LAC specialist:\n  ${multiDA.lacAgent?.topIssues?.join('\n  ')}`);
  console.log(`Policy specialist:\n  ${multiDA.policyAgent?.topIssues?.join('\n  ')}`);

  // Write full report
  const reportPath = `reports/jel-agent-ab-test-${new Date().toISOString().slice(0,10)}.json`;
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ report, baselineDA, multiDA, kris }, null, 2));
  console.log(`\nFull report: ${reportPath}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
