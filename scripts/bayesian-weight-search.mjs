/**
 * bayesian-weight-search.mjs (v2)
 *
 * Per-channel Bayesian optimization of rerank weights.
 * Runs twice — HyDE off (current VPS state) then HyDE on — and prints a
 * side-by-side comparison so we can see how optimal weights shift.
 *
 * Constraints vs v1 (unconstrained):
 *   default:       causal% floor ≥ 0.55 (IADB needs rigorous evidence by default)
 *                  sim ≥ 0.25 (relevance can't be abandoned)
 *   causal:        sim ≥ 0.20
 *   foundational:  sim ≥ 0.15
 *   recent:        sim ≥ 0.15 + reg fixed at 0.03 (region is spurious for "recent")
 *   lac:           sim ≥ 0.15
 *
 * Why HyDE changes weights:
 *   Without HyDE: sim is query→document cosine (type-mismatch gap); fts adds
 *   complementary keyword signal. With HyDE: sim is document→document cosine
 *   (type-matched); sim and fts become more redundant → expect optimal fts to drop.
 *
 * Usage:
 *   node --env-file=.env scripts/bayesian-weight-search.mjs
 *   node ... --no-hyde            # skip HyDE run (faster)
 *   node ... --no-base            # skip non-HyDE run
 *   node ... --channels causal,foundational
 *   node ... --init 30 --iters 80
 *   node ... --top 30
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');

const argv      = process.argv.slice(2);
const get       = flag => argv.includes(flag) ? argv[argv.indexOf(flag)+1] : null;
const TOP_K     = get('--top')      ? +get('--top')      : 20;
const N_INIT    = get('--init')     ? +get('--init')     : 25;
const N_ITERS   = get('--iters')   ? +get('--iters')   : 60;
const N_CAND    = get('--cand')    ? +get('--cand')    : 500;
const CHANNELS  = get('--channels') ? new Set(get('--channels').split(',').map(s=>s.trim())) : null;
const RUN_BASE  = !argv.includes('--no-base');
const RUN_HYDE  = !argv.includes('--no-hyde');

const SB          = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE    = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY     = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL  = process.env.OLLAMA_GENERATION_MODEL ?? process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';
const YEAR_NOW    = 2026;

if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

// ── Linear algebra ─────────────────────────────────────────────────────────────

function luFactor(A) {
  const n = A.length;
  const M = A.map(r => Float64Array.from(r));
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let c = 0; c < n; c++) {
    let maxR = c;
    for (let r = c+1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[maxR][c])) maxR = r;
    if (maxR !== c) { [M[c], M[maxR]] = [M[maxR], M[c]]; [piv[c], piv[maxR]] = [piv[maxR], piv[c]]; }
    const pv = M[c][c];
    if (Math.abs(pv) < 1e-14) continue;
    for (let r = c+1; r < n; r++) {
      const f = M[r][c] / pv; M[r][c] = f;
      for (let k = c+1; k < n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return { LU: M, piv };
}

function luSolve({ LU, piv }, b) {
  const n = piv.length;
  const x = Float64Array.from(piv.map(i => b[i]));
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) x[i] -= LU[i][j] * x[j];
  for (let i = n-1; i >= 0; i--) {
    for (let j = i+1; j < n; j++) x[i] -= LU[i][j] * x[j];
    x[i] /= LU[i][i] || 1e-14;
  }
  return x;
}

// ── Gaussian Process ──────────────────────────────────────────────────────────

const RBF_L = 0.25;
function rbf(a, b) { let d=0; for (let i=0;i<a.length;i++) d+=(a[i]-b[i])**2; return Math.exp(-d/(2*RBF_L*RBF_L)); }

function buildGP(xObs, yObs, sigNoise = 0.025) {
  const n = xObs.length;
  const K = Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => rbf(xObs[i], xObs[j])));
  for (let i=0; i<n; i++) K[i][i] += sigNoise*sigNoise;
  const lu = luFactor(K);
  return { xObs, alpha: luSolve(lu, yObs), lu };
}

function gpPredict(xNew, gp) {
  const kS = gp.xObs.map(x => rbf(xNew, x));
  const mu = kS.reduce((s,k,i) => s + k*gp.alpha[i], 0);
  const v  = luSolve(gp.lu, kS);
  return { mu, sigma: Math.sqrt(Math.max(0, 1 - kS.reduce((s,k,i)=>s+k*v[i],0))) };
}

// ── Acquisition ───────────────────────────────────────────────────────────────

function npdf(z) { return Math.exp(-0.5*z*z) / 2.5066282746310002; }
function ncdf(z) {
  const s=z<0?-1:1; const t=1/(1+0.2316419*Math.abs(z)); const d=npdf(z);
  return 0.5+s*(0.5-d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212559+t*1.3302744)))));
}
function ei(mu, sigma, fBest, xi=0.005) {
  if (sigma < 1e-10) return mu > fBest ? mu-fBest : 0;
  const z = (mu-fBest-xi)/sigma;
  return (mu-fBest-xi)*ncdf(z) + sigma*npdf(z);
}

// ── Constrained simplex sampling ──────────────────────────────────────────────

const DIM = 6; // [sim, cit, rig, rec, reg, fts]

/**
 * Sample from simplex with per-dimension minimums and optional fixed dimensions.
 * fixedDims: { dimIndex: value } — these are held constant, not sampled.
 * minValues: array[DIM] of minimums for each dimension (fixed dims ignored).
 */
function sampleSimplex(minValues, fixedDims = {}) {
  const freeIdx = Array.from({length: DIM}, (_,i)=>i).filter(i => !(i in fixedDims));
  const fixedSum = Object.values(fixedDims).reduce((a,b)=>a+b, 0);
  const freeMins = freeIdx.map(i => minValues[i]);
  const totalMin = freeMins.reduce((a,b)=>a+b, 0);
  const freeMass = 1 - fixedSum - totalMin;
  if (freeMass < 0.01) throw new Error('Weight constraints infeasible');
  const g = freeIdx.map(() => -Math.log(Math.random()+1e-15));
  const s = g.reduce((a,b)=>a+b, 0);
  const result = new Array(DIM).fill(0);
  for (const [i, v] of Object.entries(fixedDims)) result[+i] = +v;
  freeIdx.forEach((di, k) => result[di] = freeMins[k] + (g[k]/s)*freeMass);
  return result;
}

function arrToW(a) { return { sim:a[0], cit:a[1], rig:a[2], rec:a[3], reg:a[4], fts:a[5] }; }
function wToArr(W) { return [W.sim, W.cit, W.rig, W.rec, W.reg, W.fts]; }

// ── Channel definitions ───────────────────────────────────────────────────────
//
// weightMins:   per-dimension minimums [sim,cit,rig,rec,reg,fts]
// fixedDims:    {dimIndex: value} — held constant (not optimized)
// objective:    metrics → scalar (higher = better)
// recallFloor:  penalty if canary_recall < this
// metricFloors: [{field, min, factor}] — additional metric floors

const CHANNEL_DEFS = {
  default: {
    label: 'maximize canary recall (causal%≥55, sim≥0.25)',
    weightMins:   [0.25, 0.02, 0.02, 0.02, 0.02, 0.02],
    fixedDims:    {},
    objective:    m => m.canary_recall,
    recallFloor:  null,
    metricFloors: [{ field: 'pct_causal', min: 0.55, factor: 4 }],
  },
  causal: {
    label: 'maximize causal% (SMS≥4), recall≥0.18, sim≥0.20',
    weightMins:   [0.20, 0.02, 0.02, 0.02, 0.02, 0.02],
    fixedDims:    {},
    objective:    m => 0.70*m.pct_causal + 0.30*m.canary_recall,
    recallFloor:  0.18,
    metricFloors: [],
  },
  foundational: {
    label: 'maximize pct_foundational (cit≥100+yr≤2015), recall≥0.18, sim≥0.15',
    weightMins:   [0.15, 0.02, 0.02, 0.02, 0.02, 0.02],
    fixedDims:    {},
    objective:    m => 0.70*m.pct_found + 0.30*m.canary_recall,
    recallFloor:  0.18,
    metricFloors: [],
  },
  recent: {
    label: 'maximize pct_recent (yr≥2020), recall≥0.12, sim≥0.15, reg fixed=0.03',
    weightMins:   [0.15, 0.02, 0.02, 0.02, 0.03, 0.02],
    fixedDims:    { 4: 0.03 }, // reg fixed — not spurious-signal hunting
    objective:    m => 0.70*m.pct_recent + 0.30*m.canary_recall,
    recallFloor:  0.12,
    metricFloors: [],
  },
  lac: {
    label: 'maximize pct_lac (LAC geography), recall≥0.18, sim≥0.15',
    weightMins:   [0.15, 0.02, 0.02, 0.02, 0.02, 0.02],
    fixedDims:    {},
    objective:    m => 0.70*m.pct_lac + 0.30*m.canary_recall,
    recallFloor:  0.18,
    metricFloors: [],
  },
};

const CHANNEL_ORDER = ['default', 'causal', 'foundational', 'recent', 'lac'];

// ── Rerank helpers ────────────────────────────────────────────────────────────

const LAC_KW  = ['latin america','latin american','latam','lac','caribbean','south america','central america','argentina','bolivia','brazil','brasil','chile','colombia','costa rica','cuba','dominican republic','ecuador','el salvador','guatemala','haiti','honduras','jamaica','mexico','méxico','nicaragua','panama','paraguay','peru','perú','uruguay','venezuela'];
const LAC_RE  = new RegExp(`\\b(${LAC_KW.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`,'i');
const LAC_GEO = new Set(LAC_KW.map(k=>k.toLowerCase()));
const CIT_CAP = Math.log(1+500);

function rrSim(p) { const s=+p.similarity??0; return isFinite(s)?Math.max(0,Math.min(1,s)):0; }
function rrCit(p) { const c=+(p.citation_count??0); if(!isFinite(c)||c<=0)return 0; const y=+(p.year??0); if(!isFinite(y)||y<1900)return 0; return Math.max(0,Math.min(1,Math.log(1+c/Math.max(1,YEAR_NOW-y+1))/CIT_CAP)); }
function rrRig(p) { const s=+(p.sms_level??0); return (isFinite(s)&&s>=1)?Math.min(s,5)/5:0; }
function rrRec(p) { const y=+(p.year??0); return (isFinite(y)&&y>=1900)?Math.max(0,1-Math.max(0,YEAR_NOW-y)/25):0; }
function rrFts(p) { const r=+(p.ftsRank??p.fts_rank??0); return isFinite(r)&&r>0?Math.min(1,r):0; }
function rrReg(p,re) { if(!re)return 0; return re.test([p.title??'',(p.geography??[]).join(' ')].join(' '))?1:0; }

function normDoi(d) { if(!d)return null; return String(d).toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//,''); }
function keyOf(p)   { const d=normDoi(p.canonical_doi); return d?`doi:${d}`:`t:${String(p.title??'').toLowerCase().slice(0,60)}`; }

function isCausal(p)       { return +(p.sms_level??0)>=4; }
function isFoundational(p) { return +(p.year??0)>0&&+(p.year)<2020&&+(p.citation_count??0)>=75; }
function isRecent(p)       { return +(p.year??0)>=2020; }
function isLac(p)          { return (p.geography??[]).some(g=>LAC_GEO.has(String(g).toLowerCase())); }

function rerankWith(papers, queryStr, W) {
  const useLac = LAC_RE.test(queryStr);
  const re     = useLac ? LAC_RE : null;
  const regW   = useLac ? W.reg : 0;
  const simW   = regW===0 ? W.sim+W.reg : W.sim;
  return papers
    .map(p=>({ p, s: simW*rrSim(p)+W.cit*rrCit(p)+W.rig*rrRig(p)+W.rec*rrRec(p)+regW*rrReg(p,re)+W.fts*rrFts(p) }))
    .sort((a,b)=>b.s-a.s).map(x=>x.p);
}

// ── Objective evaluation ──────────────────────────────────────────────────────

function evalWeights(W, queryResults, def) {
  let found=0, total=0, sumC=0, sumF=0, sumR=0, sumL=0, n=0;
  for (const qr of queryResults) {
    const topK    = rerankWith(qr.pool, qr.query, W).slice(0, TOP_K);
    const topDois = new Set(topK.map(p=>normDoi(p.canonical_doi)).filter(Boolean));
    total += qr.canaries.length;
    found += qr.canaries.filter(c=>topDois.has(normDoi(c.doi_hint))).length;
    const len = topK.length||1;
    sumC += topK.filter(isCausal).length/len;
    sumF += topK.filter(isFoundational).length/len;
    sumR += topK.filter(isRecent).length/len;
    sumL += topK.filter(isLac).length/len;
    n++;
  }
  const m = {
    canary_recall: total ? found/total : 0,
    pct_causal:  n?sumC/n:0, pct_found:  n?sumF/n:0,
    pct_recent:  n?sumR/n:0, pct_lac:    n?sumL/n:0,
  };
  let score = def.objective(m);
  if (def.recallFloor!==null && m.canary_recall < def.recallFloor)
    score -= 5 * (def.recallFloor - m.canary_recall);
  for (const p of def.metricFloors)
    if (m[p.field] < p.min) score -= p.factor * (p.min - m[p.field]);
  return { score, metrics: m };
}

// ── Bayesian optimiser ────────────────────────────────────────────────────────

function bayesOpt(queryResults, def, { nInit=N_INIT, nIter=N_ITERS }={}) {
  const obsX=[], obsY=[];

  process.stdout.write(`  init (${nInit}):`);
  for (let i=0; i<nInit; i++) {
    const w = sampleSimplex(def.weightMins, def.fixedDims);
    const { score } = evalWeights(arrToW(w), queryResults, def);
    obsX.push(w); obsY.push(score);
    if ((i+1)%5===0) process.stdout.write(` ${i+1}`);
  }
  let fBest = Math.max(...obsY);
  console.log(`  seed-best=${fBest.toFixed(4)}`);

  for (let iter=0; iter<nIter; iter++) {
    const gp = buildGP(obsX, obsY);
    let bestEI=-Infinity, bestCand=null;
    for (let c=0; c<N_CAND; c++) {
      const cand = sampleSimplex(def.weightMins, def.fixedDims);
      const { mu, sigma } = gpPredict(cand, gp);
      const eiVal = ei(mu, sigma, fBest);
      if (eiVal > bestEI) { bestEI=eiVal; bestCand=cand; }
    }
    const { score, metrics } = evalWeights(arrToW(bestCand), queryResults, def);
    obsX.push(bestCand); obsY.push(score);
    if (score > fBest) fBest = score;
    process.stdout.write(`\r  iter ${String(iter+1).padStart(3)}/${nIter}  best=${fBest.toFixed(4)}  ei=${bestEI.toFixed(4)}  recall=${metrics.canary_recall.toFixed(3)}   `);
  }
  console.log();

  const bestIdx = obsY.indexOf(Math.max(...obsY));
  const bestW   = arrToW(obsX[bestIdx]);
  const { score, metrics } = evalWeights(bestW, queryResults, def);
  return { weights: bestW, score, metrics, nEvals: nInit+nIter };
}

// ── Data collection (embed + retrieve) ───────────────────────────────────────

async function collectData(queries, useHyde) {
  const tag = useHyde ? '[HyDE]' : '[base]';

  if (useHyde) {
    console.log(`\n${tag} Generating HyDE abstracts (Qwen)...`);
    const abstracts = [];
    for (let i=0; i<queries.length; i++) {
      process.stdout.write(`  [${i+1}/${queries.length}] ${queries[i].id.padEnd(44)}`);
      const t = Date.now();
      const prompt = `Write a 120-180 word hypothetical abstract for an economics or social science paper that would directly answer this research query:\n\n${queries[i].query}\n\nUse natural academic vocabulary, typical variables, outcomes, and empirical framing. Do not invent author names, citations, or specific findings.`;
      const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${LLM_KEY}`},
        body: JSON.stringify({ model:QWEN_MODEL, messages:[{role:'user',content:prompt}], temperature:0.3 }),
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content?.trim() ?? '';
      abstracts.push(text.length > 50 ? text : queries[i].query);
      console.log(` ${Date.now()-t}ms  ${abstracts.at(-1).length}c`);
    }
    // Embed as documents (not queries) since HyDE abstracts are document-style
    process.stdout.write(`${tag} Embedding HyDE abstracts...`);
    const r2 = await fetch(`${LLM_BASE}/v1/embeddings`, {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${LLM_KEY}`},
      body: JSON.stringify({ model:EMBED_MODEL, input: abstracts.map(t=>`search_document: ${t}`) }),
    });
    const ej = await r2.json();
    if (!ej.data) { console.error('\nEmbed failed:', JSON.stringify(ej).slice(0,300)); process.exit(1); }
    const embeddings = ej.data.map(d=>d.embedding);
    console.log(' done');
    return await retrieveAll(queries, embeddings, tag);
  } else {
    process.stdout.write(`\n${tag} Embedding queries...`);
    const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${LLM_KEY}`},
      body: JSON.stringify({ model:EMBED_MODEL, input: queries.map(q=>`search_query: ${q.query}`) }),
    });
    const ej = await r.json();
    if (!ej.data) { console.error('\nEmbed failed:', JSON.stringify(ej).slice(0,300)); process.exit(1); }
    console.log(' done');
    return await retrieveAll(queries, ej.data.map(d=>d.embedding), tag);
  }
}

async function retrieveAll(queries, embeddings, tag) {
  console.log(`${tag} Retrieving candidates (match_works_v2, n=300)...`);
  const results = [];
  for (let qi=0; qi<queries.length; qi++) {
    const q = queries[qi];
    process.stdout.write(`  [${String(qi+1).padStart(2)}/${queries.length}] ${q.id.padEnd(44)}`);
    const { data, error } = await SB.rpc('match_works_v2', {
      query_embedding: embeddings[qi],
      query_text:      q.query,
      match_threshold: 0.35,
      match_count:     300,
    });
    if (error||!data) { console.log(` ERR: ${error?.message}`); continue; }
    const seen=new Set();
    const pool=data.filter(p=>{const k=keyOf(p);if(seen.has(k))return false;seen.add(k);return true;});
    const canaries=(q.canary_papers??[]).filter(c=>c.doi_hint);
    results.push({ id:q.id, query:q.query, pool, canaries });
    console.log(` pool=${pool.length}  canaries=${canaries.length}`);
  }
  return results;
}

// ── Run BO for one mode (base or HyDE) ───────────────────────────────────────

async function runMode(queries, useHyde, modeLabel) {
  const queryResults = await collectData(queries, useHyde);
  console.log(`\n${queryResults.length} queries ready.\n`);

  const DEFAULT_W = { sim:0.50, cit:0.20, rig:0.15, rec:0.05, reg:0.05, fts:0.05 };
  const defRef = {};
  for (const [ch, def] of Object.entries(CHANNEL_DEFS)) {
    const { metrics } = evalWeights(DEFAULT_W, queryResults, def);
    defRef[ch] = metrics;
  }
  const dm = defRef.default;
  console.log(`Current default (${modeLabel}): recall=${dm.canary_recall.toFixed(3)}  causal=${(dm.pct_causal*100).toFixed(1)}%  found=${(dm.pct_found*100).toFixed(1)}%  recent=${(dm.pct_recent*100).toFixed(1)}%  lac=${(dm.pct_lac*100).toFixed(1)}%\n`);

  const results = {};
  for (const ch of CHANNEL_ORDER) {
    if (CHANNELS && !CHANNELS.has(ch)) continue;
    const def = CHANNEL_DEFS[ch];
    console.log(`${'═'.repeat(72)}`);
    console.log(`[${modeLabel}] Channel: ${ch}`);
    console.log(`Goal: ${def.label}`);
    console.log('─'.repeat(72));
    results[ch] = bayesOpt(queryResults, def);
    const W=results[ch].weights, m=results[ch].metrics;
    console.log(`Best: sim=${W.sim.toFixed(3)} cit=${W.cit.toFixed(3)} rig=${W.rig.toFixed(3)} rec=${W.rec.toFixed(3)} reg=${W.reg.toFixed(3)} fts=${W.fts.toFixed(3)}`);
    console.log(`      recall=${m.canary_recall.toFixed(3)}  causal=${(m.pct_causal*100).toFixed(1)}%  found=${(m.pct_found*100).toFixed(1)}%  recent=${(m.pct_recent*100).toFixed(1)}%  lac=${(m.pct_lac*100).toFixed(1)}%\n`);
  }

  return { results, defaultMetrics: defRef, defaultWeights: DEFAULT_W };
}

// ── Comparison table ──────────────────────────────────────────────────────────

function printComparison(baseOut, hydeOut) {
  const modes = [
    baseOut && ['base (HyDE off)', baseOut],
    hydeOut && ['HyDE on',         hydeOut],
  ].filter(Boolean);

  console.log('\n' + '═'.repeat(120));
  console.log('COMPARISON — OPTIMAL WEIGHTS: BASE vs HyDE');
  console.log('Hypothesis: HyDE→sim↑ and fts↓ (sim+fts become redundant with document-style embed)');
  console.log('─'.repeat(120));

  for (const ch of CHANNEL_ORDER) {
    console.log(`\n  Channel: ${ch}  (${CHANNEL_DEFS[ch].label})`);
    console.log(`  ${'mode'.padEnd(14)} ${'sim'.padStart(6)} ${'cit'.padStart(6)} ${'rig'.padStart(6)} ${'rec'.padStart(6)} ${'reg'.padStart(6)} ${'fts'.padStart(6)}  →  ${'recall'.padStart(7)} ${'causal%'.padStart(8)} ${'found%'.padStart(7)} ${'recent%'.padStart(8)} ${'lac%'.padStart(6)}`);
    for (const [label, out] of modes) {
      if (!out.results[ch]) continue;
      const W=out.results[ch].weights, m=out.results[ch].metrics;
      console.log(`  ${label.padEnd(14)} ${W.sim.toFixed(3).padStart(6)} ${W.cit.toFixed(3).padStart(6)} ${W.rig.toFixed(3).padStart(6)} ${W.rec.toFixed(3).padStart(6)} ${W.reg.toFixed(3).padStart(6)} ${W.fts.toFixed(3).padStart(6)}     ${m.canary_recall.toFixed(3).padStart(7)} ${(m.pct_causal*100).toFixed(1).padStart(7)}% ${(m.pct_found*100).toFixed(1).padStart(6)}% ${(m.pct_recent*100).toFixed(1).padStart(7)}% ${(m.pct_lac*100).toFixed(1).padStart(5)}%`);
    }
    // Delta if both modes present
    if (modes.length === 2) {
      const [,b]   = modes[0]; const [,h] = modes[1];
      if (!b.results[ch] || !h.results[ch]) continue;
      const Wb=b.results[ch].weights, Wh=h.results[ch].weights;
      const fmtΔ = (a,b) => { const d=b-a; return (d>=0?'+':'')+d.toFixed(3); };
      console.log(`  ${'Δ(HyDE-base)'.padEnd(14)} ${fmtΔ(Wb.sim,Wh.sim).padStart(6)} ${fmtΔ(Wb.cit,Wh.cit).padStart(6)} ${fmtΔ(Wb.rig,Wh.rig).padStart(6)} ${fmtΔ(Wb.rec,Wh.rec).padStart(6)} ${fmtΔ(Wb.reg,Wh.reg).padStart(6)} ${fmtΔ(Wb.fts,Wh.fts).padStart(6)}`);
    }
  }
  console.log('\n' + '═'.repeat(120));
}

function printSnippet(out, label) {
  if (!out) return;
  console.log(`\n── ${label}: channelsToRerankWeights snippet ──`);
  for (const ch of CHANNEL_ORDER) {
    if (ch==='default' || !out.results[ch]) continue;
    const W=out.results[ch].weights;
    console.log(`  ${ch}: { sim:${W.sim.toFixed(3)}, cit:${W.cit.toFixed(3)}, rig:${W.rig.toFixed(3)}, rec:${W.rec.toFixed(3)}, reg:${W.reg.toFixed(3)}, fts:${W.fts.toFixed(3)} },`);
  }
  if (out.results.default) {
    const W=out.results.default.weights;
    console.log(`\n  Proposed DEFAULT_RERANK_WEIGHTS:`);
    console.log(`    sim:${W.sim.toFixed(3)}, cit:${W.cit.toFixed(3)}, rig:${W.rig.toFixed(3)}, rec:${W.rec.toFixed(3)}, reg:${W.reg.toFixed(3)}, fts:${W.fts.toFixed(3)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { queries: ALL_QUERIES } = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const queries = ALL_QUERIES.filter(q => (q.canary_papers??[]).some(c=>c.doi_hint));

console.log(`\nBayesian weight search v2 (constrained)`);
console.log(`Queries: ${queries.length}  Init: ${N_INIT}  BO-iters: ${N_ITERS}  Cands/iter: ${N_CAND}  Top-K: ${TOP_K}`);
console.log(`Runs: ${[RUN_BASE&&'base',RUN_HYDE&&'HyDE'].filter(Boolean).join(' + ')}`);
console.log(`Channels: ${CHANNELS?[...CHANNELS].join(','):'all'}`);
console.log(`LLM: ${LLM_BASE}  |  Embed: ${EMBED_MODEL}  |  Qwen: ${QWEN_MODEL}`);

let baseOut = null, hydeOut = null;
const date = new Date().toISOString().slice(0,10);

if (RUN_BASE) {
  console.log('\n' + '█'.repeat(72));
  console.log('█  RUN 1: BASE (HyDE off — current VPS state)');
  console.log('█'.repeat(72));
  baseOut = await runMode(queries, false, 'base');
  const path = join(__dir, `../reports/bayesian-weights-base-${date}.json`);
  writeFileSync(path, JSON.stringify({ date, mode:'base', ...baseOut }, null, 2));
  console.log(`Saved: ${path}`);
}

if (RUN_HYDE) {
  console.log('\n' + '█'.repeat(72));
  console.log('█  RUN 2: HyDE on');
  console.log('█  Hypothesis: sim↑, fts↓ vs base (query gap bridged by synthetic abstract)');
  console.log('█'.repeat(72));
  hydeOut = await runMode(queries, true, 'HyDE');
  const path = join(__dir, `../reports/bayesian-weights-hyde-${date}.json`);
  writeFileSync(path, JSON.stringify({ date, mode:'hyde', ...hydeOut }, null, 2));
  console.log(`Saved: ${path}`);
}

if (baseOut && hydeOut) printComparison(baseOut, hydeOut);
printSnippet(baseOut, 'base');
printSnippet(hydeOut, 'HyDE');

console.log('\nNext steps:');
console.log('  1. Check Δ(HyDE-base) for fts — expect fts↓ if hypothesis holds');
console.log('  2. Apply base weights to App.tsx + rerank.ts (current VPS has HyDE off)');
console.log('  3. Validate: node scripts/eval-weight-combinations.mjs (≥0.231 gate, re-pinned 2026-07-06)');
console.log('  4. When re-enabling HyDE: switch to HyDE weights and re-validate');
