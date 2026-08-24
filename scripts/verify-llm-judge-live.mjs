/**
 * verify-llm-judge-live.mjs
 *
 * Trigger a real search-run against the live VPS API and check whether the
 * evidence_classification rows carry llmRationale (= LLM-judge fired) or
 * only the cosine-classifier fields (= flag not picked up or LLM failed).
 *
 * Mints a JWT via Supabase admin auth (same path eval-synonym-bridge.mjs uses).
 */
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROD_API = process.env.PROD_API_BASE || 'http://localhost:3002';
const USER_EMAIL = 'horizon-scanner@iadb.org';

const QUERY = 'do cash transfer programs increase school attendance and learning outcomes';

async function mintToken() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: USER_EMAIL });
  if (error) throw error;
  const sb = createClient(SUPABASE_URL, ANON_KEY);
  const { data: v, error: vErr } = await sb.auth.verifyOtp({ type: 'magiclink', token_hash: data?.properties?.hashed_token });
  if (vErr) throw vErr;
  return v.session.access_token;
}

async function main() {
  const t0 = Date.now();
  console.log('Minting JWT…');
  const token = await mintToken();
  console.log(`  ok (${(Date.now() - t0)}ms)`);

  console.log(`\nPOSTing /api/search-runs  query="${QUERY}"`);
  const sr0 = Date.now();
  const r = await fetch(`${PROD_API}/api/search-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!r.ok) {
    console.error(`  HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const run = await r.json();
  console.log(`  run id: ${run.id}  (${(Date.now() - sr0)/1000 | 0}s)`);

  // Fetch the full row via Supabase to inspect evidence_classification
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: full } = await sb.from('search_runs').select('id, query, evidence_classification, query_facets').eq('id', run.id).single();
  if (!full) { console.error('  search_run not found in DB'); process.exit(1); }
  const cls = full.evidence_classification ?? {};
  const ids = Object.keys(cls);
  console.log(`\nclassified papers: ${ids.length}`);
  if (ids.length === 0) { console.log('no classifications attached'); return; }

  let withLlmRationale = 0, withTrained = 0, cosineOnly = 0;
  const sample = [];
  for (const id of ids) {
    const c = cls[id];
    if (c.llmRationale)      withLlmRationale++;
    else if (c.trainedProbs) withTrained++;
    else                      cosineOnly++;
    if (sample.length < 5) sample.push({ id, ...c });
  }
  console.log(`tier 1 — LLM-judge:        ${withLlmRationale}`);
  console.log(`tier 2 — trained model:    ${withTrained}`);
  console.log(`tier 3 — cosine fallback:  ${cosineOnly}`);

  console.log('\nSample classifications:');
  for (const s of sample) {
    console.log(`  ${s.id.slice(0,16)}  class=${s.classification}  gm=${s.gmRequired?.toFixed(3) ?? '—'}`);
    if (s.llmRationale) console.log(`    LLM: ${s.llmRationale.slice(0, 120)}`);
    if (s.facetScores) console.log(`    facets: ${JSON.stringify(s.facetScores).slice(0,80)}`);
  }

  // Fetch the production caps to interpret tier coverage correctly.
  let llmCap = null, trainedCap = null;
  try {
    const v = await fetch(`${PROD_API}/api/_version`).then(r => r.json());
    llmCap = v?.classifier?.llmJudgeCap ?? null;
    trainedCap = v?.classifier?.trainedClassifierCap ?? null;
    console.log(`\n/api/_version classifier: ` +
      `LLM enabled=${v?.classifier?.llmJudgeEnabled} cap=${llmCap} parallel=${v?.classifier?.llmJudgeParallel}` +
      ` · trained enabled=${v?.classifier?.trainedClassifierEnabled} cap=${trainedCap}`);
  } catch { /* best-effort */ }

  const fires = [];
  if (llmCap != null && withLlmRationale >= llmCap - 3) fires.push(`LLM ${withLlmRationale}/${llmCap}`);
  else if (withLlmRationale > 0) fires.push(`LLM ${withLlmRationale} (under cap ${llmCap})`);
  if (trainedCap != null && withTrained > 0) fires.push(`trained ${withTrained}`);
  if (cosineOnly > 0) fires.push(`cosine ${cosineOnly}`);
  console.log(`\n${withLlmRationale > 0 ? '✅' : '⚠️'} Tiers: ${fires.join(' + ')} of ${ids.length}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
