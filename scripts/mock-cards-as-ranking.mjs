/**
 * mock-cards-as-ranking.mjs
 *
 * Mock evaluation of the same-finding penalty using the existing ~26k
 * evidence_cards. For each gold query:
 *   1. Run match_works_v2 → top-150 pool
 *   2. Apply current rerankMerged composite scoring
 *   3. Fetch evidence_cards for any pool paper that has one
 *   4. Greedy top-20 selection with:
 *      - duplicate collapse (Phase 1.4a)
 *      - weak-method crowding (Phase 1.4g)
 *      - NEW: same-finding penalty (when both papers in a pair have cards)
 *   5. Compare canary_top20 vs current (no card penalty)
 *
 * Same-finding signal (Phase 2):
 *   Two cards count as "same finding" if BOTH of:
 *     - intervention text overlap ≥ 0.5 (Jaccard on token sets)
 *     - outcome text overlap ≥ 0.5 (Jaccard on token sets)
 *   (Both fields populated in only 39-48% of cards, so we require both
 *   explicitly — partial-match would over-trigger on weak data.)
 *
 * Penalty when same-finding detected against already-selected paper:
 *   First same-finding repeat: −0.04
 *   Each subsequent:           +-0.02
 *
 * Reports per-query: pool_size, papers_with_cards, same_finding_pairs_in_top20,
 * canary_top20 with-and-without penalty, what canaries moved.
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

const POOL = 150;
const K = 20;

const RW = { similarity: 0.50, rigor: 0.15, recency: 0.05, region: 0.05, citation: 0.20, fts: 0.05 };
const CIT_CEIL = Math.log(1 + 500);
const LAC_RE = /\b(latin america|caribbean|lac|mexico|brazil|argentina|chile|colombia|peru|ecuador|venezuela|bolivia|paraguay|uruguay)\b/i;
const WEAK = new Set(['observational', 'theoretical', 'descriptive']);
const REVIEW_RE = /\b(systematic|literature|meta[\s-]?analy[sz]is|narrative)\s+(review|analysis)\b|\bmeta[\s-]analys[ie]s\b|\bevidence\s+synthesis\b|\bhandbook\s+of\b|\bannual\s+review\s+of\b/i;

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }
function normTitleKey(t) {
  if (!t) return '';
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\bnber\s+working\s+paper\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\biza\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, '')
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

// Card-based same-finding similarity (Jaccard on tokenized intervention + outcome)
function tokenize(text) {
  if (!text) return new Set();
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3));
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function isUsableText(value, minLength = 3) {
  if (value == null) return false;
  const text = String(value).trim();
  if (text.length < minLength) return false;
  const lower = text.toLowerCase();
  if (['unclear', 'unknown', 'n/a', 'na', 'none', 'null'].includes(lower)) return false;
  return !lower.includes('unclear');
}

function isUsableDesign(value) {
  return ['rct', 'quasi-experimental', 'observational', 'qualitative', 'review', 'descriptive']
    .includes(String(value ?? '').trim().toLowerCase());
}

function cardUsableForRanking(card) {
  if (!card) return false;
  if (typeof card.card_usable_for_ranking === 'boolean') return card.card_usable_for_ranking;
  return isUsableText(card.intervention)
    && isUsableText(card.outcome)
    && isUsableDesign(card.study_design)
    && isUsableText(card.source_text, 40);
}

function isSameFinding(card1, card2) {
  if (!card1 || !card2) return false;
  if (!card1.intervention || !card2.intervention) return false;
  if (!card1.outcome || !card2.outcome) return false;
  const intJ = jaccard(tokenize(card1.intervention), tokenize(card2.intervention));
  const outJ = jaccard(tokenize(card1.outcome), tokenize(card2.outcome));
  return intJ >= 0.5 && outJ >= 0.5;
}

function sameFindingPenalty(paper, cardLookup, selectedFindingsList) {
  const myCard = cardLookup.get(paper.id);
  if (!myCard) return 0;
  let matches = 0;
  for (const otherCard of selectedFindingsList) {
    if (isSameFinding(myCard, otherCard)) matches++;
  }
  if (matches === 0) return 0;
  return Math.min(0.04 + 0.02 * (matches - 1), 0.10);
}

function weakCrowdingPenalty(paper, counts) {
  const md = String(paper.methodology_design ?? '').toLowerCase();
  if (!WEAK.has(md)) return 0;
  const count = counts.get('__weak__') ?? 0;
  if (count < 3) return 0;
  return Math.min(0.015 * (count - 2), 0.06);
}

function selectTopK(papers, k, cardLookup, useCardsPenalty) {
  // Pass 1: dedup
  const seenDoi = new Set(), seenTitle = new Set();
  const deduped = [];
  for (const p of papers) {
    const d = normDoi(p.canonical_doi ?? p.doi);
    const t = normTitleKey(p.title);
    if ((d && seenDoi.has(d)) || (t && seenTitle.has(t))) continue;
    deduped.push(p); if (d) seenDoi.add(d); if (t) seenTitle.add(t);
  }
  // Pass 2: greedy with crowding + same-finding
  const sel = [];
  const selFindings = []; // cards of selected papers
  const wkCount = new Map();
  const rem = new Set(deduped.map((_,i)=>i));
  let sameFindingHits = 0;
  while (sel.length < k && rem.size > 0) {
    let bi = -1, bs = -Infinity;
    for (const i of rem) {
      const p = deduped[i];
      const base = Number(p._compositeScore ?? 0);
      let crowd = weakCrowdingPenalty(p, wkCount);
      if (useCardsPenalty) crowd += sameFindingPenalty(p, cardLookup, selFindings);
      const eff = base - crowd;
      if (eff > bs) { bs = eff; bi = i; }
    }
    if (bi === -1) break;
    const picked = deduped[bi]; sel.push(picked); rem.delete(bi);
    const md = String(picked.methodology_design ?? '').toLowerCase();
    if (WEAK.has(md)) wkCount.set('__weak__', (wkCount.get('__weak__') ?? 0) + 1);
    const card = cardLookup.get(picked.id);
    if (card) selFindings.push(card);
    if (useCardsPenalty && card) {
      for (const other of selFindings.slice(0, -1)) {
        if (isSameFinding(card, other)) { sameFindingHits++; break; }
      }
    }
  }
  return { selected: sel, sameFindingHits };
}

async function embed(t) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: EMBED_MODEL, input: 'search_query: ' + t }) });
  return (await r.json()).data?.[0]?.embedding ?? null;
}

async function main() {
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  let totalCanaryWithoutCards = 0, totalCanaryWithCards = 0;
  let totalSameFindingHits = 0;
  const perQuery = [];

  for (const q of evals.queries) {
    process.stdout.write(`▸ ${q.id.padEnd(50)} `);
    const vec = await embed(q.query);
    const { data } = await SB.rpc('match_works_v2', { query_embedding: vec, query_text: q.query, match_threshold: 0.40, match_count: POOL });
    const pool = (data ?? []).map(p => ({ ...p, _compositeScore: composite(p, q.query) }));
    pool.sort((a, b) => b._compositeScore - a._compositeScore);

    // Fetch cards for any paper in the pool. Prefer the generated DB flag
    // when deployed; fall back to the same explicit-field check on older DBs.
    const poolIds = pool.map(p => p.id);
    const cardColumns = 'work_id, intervention, outcome, effect_direction, study_design, country, source_text, card_usable_for_ranking';
    let cards;
    const cardResult = await SB.from('evidence_cards').select(cardColumns).in('work_id', poolIds);
    if (cardResult.error && String(cardResult.error.message).includes('card_usable_for_ranking')) {
      const fallback = await SB.from('evidence_cards').select('work_id, intervention, outcome, effect_direction, study_design, country, source_text').in('work_id', poolIds);
      if (fallback.error) throw fallback.error;
      cards = fallback.data ?? [];
    } else if (cardResult.error) {
      throw cardResult.error;
    } else {
      cards = cardResult.data ?? [];
    }
    const usableCards = cards.filter(cardUsableForRanking);
    const cardLookup = new Map(usableCards.map(c => [c.work_id, c]));
    const cardsInPool = cards?.length ?? 0;

    // Without cards
    const woCards = selectTopK(pool.slice(0, POOL), K, cardLookup, false);
    // With cards penalty
    const wCards = selectTopK(pool.slice(0, POOL), K, cardLookup, true);

    const canaryDois = new Set((q.canary_papers ?? []).filter(c => c.doi_hint).map(c => normDoi(c.doi_hint)));
    const woHits = woCards.selected.filter(p => canaryDois.has(normDoi(p.canonical_doi))).length;
    const wHits = wCards.selected.filter(p => canaryDois.has(normDoi(p.canonical_doi))).length;
    totalCanaryWithoutCards += woHits;
    totalCanaryWithCards += wHits;
    totalSameFindingHits += wCards.sameFindingHits;
    perQuery.push({ id: q.id, cardsInPool, usableCardsInPool: usableCards.length, woHits, wHits, sameFindingHits: wCards.sameFindingHits, total: canaryDois.size });
    console.log(`pool=${pool.length} cards_in_pool=${cardsInPool} usable=${usableCards.length} canaries=${woHits}/${canaryDois.size}→${wHits}/${canaryDois.size} same_finding_hits=${wCards.sameFindingHits}`);
  }

  console.log('\n=== Summary ===');
  console.log(`canary_top20 without cards penalty: ${totalCanaryWithoutCards}/59 = ${(totalCanaryWithoutCards/59).toFixed(3)}`);
  console.log(`canary_top20 with cards penalty:    ${totalCanaryWithCards}/59 = ${(totalCanaryWithCards/59).toFixed(3)}`);
  console.log(`Δ canary_top20:                     ${((totalCanaryWithCards - totalCanaryWithoutCards)/59).toFixed(3)}`);
  console.log(`Total same-finding hits across queries: ${totalSameFindingHits}`);

  console.log('\nPer-query (only where same_finding fired or canary changed):');
  for (const r of perQuery) {
    if (r.sameFindingHits > 0 || r.wHits !== r.woHits) {
      console.log(`  ${r.id.padEnd(50)} cards_in_pool=${r.cardsInPool} usable=${r.usableCardsInPool}  canary ${r.woHits}→${r.wHits}/${r.total}  same_finding=${r.sameFindingHits}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
