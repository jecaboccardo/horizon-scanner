/**
 * mock-cross-encoder.mjs
 *
 * Eval Qwen-as-judge cross-encoder reranking on the 23 gold queries.
 * Mirrors the production crossEncoderRerank shape but runs from the eval
 * harness so we can A/B without enabling ENABLE_CROSS_ENCODER in prod.
 *
 * Flow per query:
 *   1. match_works_v2 → top-150 pool, apply composite rerank.
 *   2. Take top-50 of composite-sorted pool.
 *   3. Ask Qwen to score each (query, paper) on 0-100 relevance + direction
 *      (match | reverse | tangential), batched 10 per call.
 *   4. Blend cross-encoder score into composite: new_score = base + 0.15 * (qwen/100)
 *      Penalty if direction = "tangential" (-0.10) since prod's intent is to
 *      demote off-direction papers but keep reverse-direction evidence.
 *   5. Resort top-50, then selectTopKDiverse for top-20.
 *   6. Compare canary_top20 with vs without cross-encoder.
 *
 * Latency: ~5 batches/query × 23 queries × ~5s/batch (concurrent within query)
 * → roughly 4-5 minutes added.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';

const POOL = 150;
const CE_TOP_N = 50;
const CE_BATCH = 10;
const K = 20;
const CE_WEIGHT = 0.15;
const CE_TANGENTIAL_PENALTY = -0.10;

const RW = { similarity: 0.50, rigor: 0.15, recency: 0.05, region: 0.05, citation: 0.20, fts: 0.05 };
const CIT_CEIL = Math.log(1 + 500);
const LAC_RE = /\b(latin america|caribbean|lac|mexico|brazil|argentina|chile|colombia|peru)\b/i;
const WEAK = new Set(['observational', 'theoretical', 'descriptive']);
const REVIEW_RE = /\b(systematic|literature|meta[\s-]?analy[sz]is)\s+(review|analysis)\b|\bmeta[\s-]analys[ie]s\b|\bevidence\s+synthesis\b|\bhandbook\s+of\b/i;

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }
function normTitleKey(t) {
  if (!t) return '';
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^the\s+/, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function rrSim(p) { const s = Number(p.similarity ?? 0); return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0; }
function rrRig(p) { const s = Number(p.sms_level ?? 0); return s >= 1 ? Math.min(s, 5) / 5 : 0; }
function rrRec(p) { const y = Number(p.year ?? 0); if (y < 1900) return 0; return Math.max(0, 1 - Math.max(0, new Date().getUTCFullYear() - y) / 25); }
function rrReg(p, re) { if (!re) return 0; return re.test(`${p.title ?? ''} ${p.abstract ?? ''}`) ? 1 : 0; }
function rrCit(p) { const c = Number(p.citation_count ?? 0); if (c <= 0) return 0; const y = Number(p.year ?? 0); if (y < 1900) return 0; const age = Math.max(1, new Date().getUTCFullYear() - y + 1); return Math.max(0, Math.min(1, Math.log(1 + c/age) / CIT_CEIL)); }
function rrFts(p) { const r = Number(p.ftsRank ?? p.fts_rank ?? 0); return r > 0 ? Math.min(1, r) : 0; }
function rrDir(p) { const c = String(p.classification ?? ''); return c === 'direct-lac' ? 0.10 : c === 'direct-global' ? 0.07 : c === 'excluded' ? -0.15 : 0; }
function rrReview(p) {
  const md = String(p.methodology_design ?? '').toLowerCase();
  if (md === 'review') return 0.025;
  return REVIEW_RE.test(p.title ?? '') ? 0.025 : 0;
}

function composite(p, q) {
  const useLac = LAC_RE.test(q);
  const regW = useLac ? RW.region : 0;
  const effSim = regW === 0 ? RW.similarity + RW.region : RW.similarity;
  return effSim*rrSim(p) + RW.rigor*rrRig(p) + RW.recency*rrRec(p) + regW*rrReg(p, useLac?LAC_RE:null) + RW.citation*rrCit(p) + RW.fts*rrFts(p) + rrDir(p) + rrReview(p);
}

const CE_SYSTEM = "You are a relevance scorer. Given a research query and N papers, score each on 0-100 (100=strongly relevant evidence, 40=tangential, 10=off-topic) and tag direction (match=studies the queried direction, reverse=studies the reverse direction (still relevant evidence!), tangential=topically related but different relationship). Return JSON only.";

async function crossEncoderBatch(query, batch) {
  const lines = [`QUERY: ${query}`, '', 'PAPERS:'];
  batch.forEach((p, i) => {
    const title = String(p.title ?? '').slice(0, 300);
    const abstract = String(p.abstract ?? '').slice(0, 600);
    lines.push(`${i}. Title: ${title}`);
    lines.push(`   Abstract: ${abstract}`);
    lines.push('');
  });
  lines.push(`Return JSON: {"scores":[{"idx":0,"score":<0-100>,"direction":"match"|"reverse"|"tangential"}, ...]}`);

  try {
    const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [{ role: 'system', content: CE_SYSTEM }, { role: 'user', content: lines.join('\n') }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content ?? '';
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

async function crossEncoderScore(papers, query) {
  const result = new Map(); // paper.id -> { score, direction }
  const top = papers.slice(0, CE_TOP_N);
  const batches = [];
  for (let i = 0; i < top.length; i += CE_BATCH) {
    batches.push(top.slice(i, i + CE_BATCH));
  }
  // 5 batches concurrent (matches prod)
  for (let i = 0; i < batches.length; i += 5) {
    const slice = batches.slice(i, i + 5);
    const responses = await Promise.all(slice.map(b => crossEncoderBatch(query, b)));
    responses.forEach((resp, batchIdx) => {
      if (!resp?.scores) return;
      const batch = slice[batchIdx];
      for (const s of resp.scores) {
        if (s.idx == null || s.idx >= batch.length) continue;
        result.set(batch[s.idx].id, { score: Number(s.score) || 0, direction: s.direction });
      }
    });
  }
  return result;
}

function selectTopK(papers, k, ceScores) {
  // Pass 1: dedup
  const seenDoi = new Set(), seenTitle = new Set();
  const deduped = [];
  for (const p of papers) {
    const d = normDoi(p.canonical_doi ?? p.doi);
    const t = normTitleKey(p.title);
    if ((d && seenDoi.has(d)) || (t && seenTitle.has(t))) continue;
    deduped.push(p); if (d) seenDoi.add(d); if (t) seenTitle.add(t);
  }
  // Apply cross-encoder boost to deduped, then sort
  if (ceScores) {
    for (const p of deduped) {
      const ce = ceScores.get(p.id);
      if (ce) {
        let bonus = CE_WEIGHT * (ce.score / 100);
        if (ce.direction === 'tangential') bonus += CE_TANGENTIAL_PENALTY;
        p._compositeScore = (p._compositeScore ?? 0) + bonus;
      }
    }
    deduped.sort((a, b) => (b._compositeScore ?? 0) - (a._compositeScore ?? 0));
  }
  // Pass 2: greedy with weak-method crowding
  const sel = [];
  const wkCount = new Map();
  const rem = new Set(deduped.map((_,i)=>i));
  while (sel.length < k && rem.size > 0) {
    let bi = -1, bs = -Infinity;
    for (const i of rem) {
      const p = deduped[i];
      const md = String(p.methodology_design ?? '').toLowerCase();
      let crowd = 0;
      if (WEAK.has(md)) {
        const c = wkCount.get('__weak__') ?? 0;
        if (c >= 3) crowd = Math.min(0.015 * (c - 2), 0.06);
      }
      const eff = Number(p._compositeScore ?? 0) - crowd;
      if (eff > bs) { bs = eff; bi = i; }
    }
    if (bi === -1) break;
    const picked = deduped[bi]; sel.push(picked); rem.delete(bi);
    const md = String(picked.methodology_design ?? '').toLowerCase();
    if (WEAK.has(md)) wkCount.set('__weak__', (wkCount.get('__weak__') ?? 0) + 1);
  }
  return sel;
}

async function embed(t) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: EMBED_MODEL, input: 'search_query: ' + t }) });
  return (await r.json()).data?.[0]?.embedding ?? null;
}

async function main() {
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  let totalCanaryWoCe = 0, totalCanaryCe = 0;
  let totalLatencyMs = 0;
  const perQuery = [];

  for (const q of evals.queries) {
    process.stdout.write(`▸ ${q.id.padEnd(50)} `);
    const t0 = Date.now();
    const vec = await embed(q.query);
    const { data } = await SB.rpc('match_works_v2', { query_embedding: vec, query_text: q.query, match_threshold: 0.40, match_count: POOL });
    const pool = (data ?? []).map(p => ({ ...p, _compositeScore: composite(p, q.query) }));
    pool.sort((a, b) => b._compositeScore - a._compositeScore);

    // Baseline (no CE)
    const woCe = selectTopK(pool.slice(0, POOL), K, null);
    const woHits = woCe.filter(p => (q.canary_papers ?? []).some(c => c.doi_hint && normDoi(c.doi_hint) === normDoi(p.canonical_doi))).length;

    // Cross-encoder
    const ceT0 = Date.now();
    const ceScores = await crossEncoderScore(pool.slice(0, POOL), q.query);
    const ceLatency = Date.now() - ceT0;
    // Need to recompute baseScore on pool since selectTopK without CE didn't mutate
    const poolForCe = pool.slice(0, POOL).map(p => ({ ...p, _compositeScore: p._compositeScore }));
    const ceTop20 = selectTopK(poolForCe, K, ceScores);
    const ceHits = ceTop20.filter(p => (q.canary_papers ?? []).some(c => c.doi_hint && normDoi(c.doi_hint) === normDoi(p.canonical_doi))).length;

    totalCanaryWoCe += woHits;
    totalCanaryCe += ceHits;
    const totLat = Date.now() - t0;
    totalLatencyMs += totLat;
    const canaryTotal = (q.canary_papers ?? []).filter(c => c.doi_hint).length;
    perQuery.push({ id: q.id, woHits, ceHits, canaryTotal, ceLatency, scored: ceScores.size });
    console.log(`canary ${woHits}→${ceHits}/${canaryTotal}  ce_scored=${ceScores.size}  ce_latency=${ceLatency}ms  total=${totLat}ms`);
  }

  console.log('\n=== Summary ===');
  console.log(`canary_top20 without CE: ${totalCanaryWoCe}/59 = ${(totalCanaryWoCe/59).toFixed(3)}`);
  console.log(`canary_top20 with CE:    ${totalCanaryCe}/59 = ${(totalCanaryCe/59).toFixed(3)}`);
  console.log(`Δ canary_top20:          ${((totalCanaryCe - totalCanaryWoCe)/59).toFixed(3)}`);
  console.log(`Avg per-query latency:   ${Math.round(totalLatencyMs/perQuery.length)}ms`);

  console.log('\nPer-query (where canary changed):');
  for (const r of perQuery) {
    if (r.ceHits !== r.woHits) {
      console.log(`  ${r.id.padEnd(50)} ${r.woHits}→${r.ceHits}/${r.canaryTotal}  ce_scored=${r.scored}/${CE_TOP_N}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
