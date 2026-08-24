#!/usr/bin/env node
/**
 * eval-rerank-boost.mjs  — READ-ONLY comparative retrieval eval
 *
 * Extends _eval-a-vs-b-vs-current.mjs with:
 *   OPTION B+boost@0.80 — same pool as B, but synthetic sim of bridged lexical
 *     foundational papers (option_b_bridged) is raised to 0.80 before rerank.
 *   OPTION B+boost@0.88 — same but sim raised to 0.88.
 *
 * Metrics:
 *   recall@20  — fraction of doi_hint canaries found in top-20
 *   meanCos@20 — mean TRUE query·paper cosine over top-20 (precision guard)
 *                Fetched from stored works.embedding via dot product.
 *
 * Run:
 *   node --env-file=.env scripts/eval-rerank-boost.mjs
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_API_KEY,
 *   OLLAMA_EMBEDDING_MODEL, LLM_BASE_URL
 *
 * Outputs: reports/eval-rerank-boost.json
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');
const REPORTS_DIR  = join(__dir, '../reports');
const OUTPUT_PATH  = join(REPORTS_DIR, 'eval-rerank-boost.json');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SB = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const LLM_BASE    = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY     = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

const MATCH_THRESHOLD  = 0.40;
const MATCH_COUNT_POOL = 100;
const TOP_20_K         = 20;
const TOPIC_GEO_LIMIT  = 200;
const TOPIC_GEO_SIM    = 0.55;
const OPTION_B_QUOTA   = 40;

// Query IDs to run (same as _eval-a-vs-b-vs-current.mjs + the new one)
const SELECTED_QUERY_IDS = new Set([
  'q04-minwage-informality-lac',
  'q05-cct-school-attendance-learning',
  'q06-migration-native-wages',
  'q09-early-nutrition-adult-earnings',
  'q10-trade-liberalization-wage-inequality',
  'q11-teacher-quality-student-learning',
  'q13-financial-inclusion-resilience',
  'q15-violence-youth-education',
  'q-student-learning-productivity-growth',  // NEW — Hanushek headline case
]);

// New query not in queries.json — defined inline
const EXTRA_QUERIES = [
  {
    id: 'q-student-learning-productivity-growth',
    query: 'What is the impact of student learning on productivity and long-term growth?',
    canary_papers: [
      {
        id: 'hanushek-2000-aer',
        label: 'relevant',
        title: 'Schooling, Labor-Force Quality, and the Growth of Nations',
        authors: 'Hanushek & Kimko',
        year: 2000,
        doi_hint: '10.1257/aer.90.5.1184',
      },
      {
        id: 'barro-2001-aer',
        label: 'relevant',
        title: 'Human Capital and Growth',
        authors: 'Barro',
        year: 2001,
        doi_hint: '10.1257/aer.101.5.1872',
      },
      {
        id: 'mrw-1992-qje',
        label: 'relevant',
        title: 'A Contribution to the Empirics of Economic Growth',
        authors: 'Mankiw, Romer & Weil',
        year: 1992,
        doi_hint: '10.2307/2118477',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rerank weights (mirrors DEFAULT_RERANK_WEIGHTS in rerank.ts)
// ---------------------------------------------------------------------------
const RERANK_WEIGHTS = {
  similarity: 0.428,
  rigor:      0.160,
  recency:    0.021,
  region:     0.087,
  citation:   0.157,
  fts:        0.147,
};
const CITATION_RATE_CEILING     = 500;
const CITATION_RATE_LOG_CEILING = Math.log(1 + CITATION_RATE_CEILING);

const RERANK_LAC_KEYWORDS = [
  'latin america','latin american','america latina','latam','lac','caribbean',
  'caribe','south america','central america','argentina','bolivia','brazil',
  'brasil','chile','colombia','costa rica','cuba','dominican republic','ecuador',
  'el salvador','guatemala','haiti','honduras','jamaica','mexico','nicaragua',
  'panama','paraguay','peru','uruguay','venezuela',
  'andean','mercosur','cono sur',
];
const RERANK_LAC_REGEX = new RegExp(
  `\\b(${RERANK_LAC_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

function normDoi(d) {
  return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}
function normTitleKey(title) {
  if (!title) return '';
  return String(title)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bnber\s+working\s+paper\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\biza\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function keyOf(p) {
  const doi = normDoi(p.canonical_doi);
  if (doi) return `doi:${doi}`;
  const t = normTitleKey(p.title);
  return t ? `t:${t}` : `id:${p.id}`;
}

// ---------------------------------------------------------------------------
// Composite rerank score (mirrors _eval-a-vs-b-vs-current.mjs rerankScore)
// ---------------------------------------------------------------------------
function rerankScore(p, queryMentionsLAC) {
  const sim = Math.max(0, Math.min(1, Number(p.similarity ?? 0)));
  const rigor = (() => {
    const sms = Number(p.sms_level ?? 0);
    return (sms >= 1 && sms <= 5) ? sms / 5 : 0;
  })();
  const recency = (() => {
    const yr = Number(p.year ?? 0);
    if (yr < 1900) return 0;
    return Math.max(0, 1 - (new Date().getUTCFullYear() - yr) / 25);
  })();
  const region = (() => {
    if (!queryMentionsLAC) return 0;
    const hay = [p.title ?? '', p.abstract ?? '', Array.isArray(p.geography) ? p.geography.join(' ') : ''].join(' ');
    return RERANK_LAC_REGEX.test(hay) ? 1 : 0;
  })();
  const citation = (() => {
    const cites = Number(p.citation_count ?? 0);
    const yr = Number(p.year ?? 0);
    if (cites <= 0 || yr < 1900) return 0;
    const age = Math.max(1, new Date().getUTCFullYear() - yr + 1);
    return Math.max(0, Math.min(1, Math.log(1 + cites / age) / CITATION_RATE_LOG_CEILING));
  })();
  const fts = Math.min(1, Math.max(0, Number(p.fts_rank ?? p.ftsRank ?? 0)));
  // V1 P0 gate — mirrors _eval-a-vs-b-vs-current.mjs
  const SYNTHETIC_SRCS = new Set(['topic_geo_channel','foundational_channel_sql','foundational_channel_fts','causal_channel','recent_channel','option_b_bridged']);
  const isSynthetic = SYNTHETIC_SRCS.has(String(p._retrievalSource ?? ''));
  const cls = String(p.classification ?? '');
  const onTopic = cls.startsWith('direct') || fts >= 0.20;
  const topicallyWeak = isSynthetic ? !onTopic : (sim < 0.50 && !cls.startsWith('direct') && fts < 0.20);
  const citFactor = topicallyWeak ? 0.20 : 1.0;
  const regionWeight = queryMentionsLAC ? RERANK_WEIGHTS.region : 0;
  const effSim = queryMentionsLAC ? RERANK_WEIGHTS.similarity : RERANK_WEIGHTS.similarity + RERANK_WEIGHTS.region;
  return (
    effSim                    * sim +
    RERANK_WEIGHTS.rigor      * rigor +
    RERANK_WEIGHTS.recency    * recency +
    regionWeight              * region +
    RERANK_WEIGHTS.citation   * citation * citFactor +
    RERANK_WEIGHTS.fts        * fts
  );
}

function rerankAndDedup(pool, query, topK) {
  const useLAC = RERANK_LAC_REGEX.test(query);
  const scored = pool.map(p => ({ p, score: rerankScore(p, useLAC) }));
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const deduped = [];
  for (const { p } of scored) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(p);
    if (deduped.length >= topK) break;
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------
async function embed(text) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: [`search_query: ${text}`] }),
  });
  const j = await r.json();
  if (!j.data?.[0]?.embedding) throw new Error(`embed fail: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data[0].embedding;
}

// ---------------------------------------------------------------------------
// True cosine similarity (query vector · stored paper embedding)
// ---------------------------------------------------------------------------
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) {
  const na = norm(a), nb = norm(b);
  return (na && nb) ? dot(a, b) / (na * nb) : 0;
}
function parseVec(e) {
  if (Array.isArray(e)) return e;
  if (typeof e === 'string') { try { return JSON.parse(e); } catch { return null; } }
  return null;
}

/**
 * Fetch true cosines for a set of paper IDs from stored works.embedding.
 * Returns a Map<id, cosine> for the query vector.
 */
async function fetchTrueCosines(paperIds, queryVec) {
  const cosMap = new Map();
  const uniqueIds = [...new Set(paperIds.filter(Boolean))];
  for (let i = 0; i < uniqueIds.length; i += 200) {
    const batch = uniqueIds.slice(i, i + 200);
    const { data, error } = await SB.from('works')
      .select('id, embedding')
      .in('id', batch);
    if (error) { console.warn(`  [cosine] fetch error: ${error.message}`); continue; }
    for (const row of (data ?? [])) {
      const vec = parseVec(row.embedding);
      if (vec && queryVec) {
        cosMap.set(row.id, cosineSim(queryVec, vec));
      }
    }
  }
  return cosMap;
}

function meanCosineTop20(top20, cosMap) {
  const cosines = top20.map(p => cosMap.get(p.id)).filter(c => c != null && isFinite(c));
  if (!cosines.length) return null;
  return cosines.reduce((a, b) => a + b, 0) / cosines.length;
}

// ---------------------------------------------------------------------------
// Topic-geo channel (mirrors _eval-a-vs-b-vs-current.mjs)
// ---------------------------------------------------------------------------
const SCL_TOPICS = {
  ecd: ['early childhood','child development','preschool','kindergarten','daycare','childcare','early education','school readiness'],
  education: ['teacher effectiveness','teacher quality','school quality','learning outcomes','test score','student achievement','dropout','literacy','numeracy','curriculum','teacher training','teacher recruitment'],
  labor_markets: ['labor market','labour market','employment','wages','unemployment','informal employment','informality','minimum wage','job training','wage inequality','labor','labour','workers','workforce'],
  social_protection: ['cash transfer','conditional cash','unconditional cash','cct','social protection','safety net','bolsa familia','progresa','oportunidades'],
  health: ['health system','primary care','public health','health insurance','mental health','maternal health','child health','vaccination','health workforce'],
  gender_gbv: ['gender','women','female labor','gender gap','intimate partner violence','domestic violence','ipv','gender-based violence','violence against women'],
  migration: ['migration','immigration','emigration','migrant','remittance','refugee','displaced'],
  ai_digital: ['artificial intelligence','machine learning','automation impact','digital transformation','fintech','robotics','job displacement','future of work','automation','robots','computerization'],
  climate_resilience: ['climate change','climate shock','natural disaster','drought','flood','hurricane','extreme weather'],
};
const GEOGRAPHY_KWS = {
  'Latin America': ['latin america','america latina','latinoamerica','latam','lac'],
  'Caribbean': ['caribbean','caribe'],
  'Mexico': ['mexico'], 'Brazil': ['brazil','brasil'], 'Argentina': ['argentina'],
  'Chile': ['chile'], 'Colombia': ['colombia'], 'Peru': ['peru'],
  'Ecuador': ['ecuador'], 'Venezuela': ['venezuela'],
};

function foldAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function inferTopics(query) {
  const text = foldAccents(query).toLowerCase();
  return Object.entries(SCL_TOPICS)
    .filter(([, kws]) => kws.some(k => text.includes(foldAccents(k).toLowerCase())))
    .map(([t]) => t);
}
function inferGeography(query) {
  const text = foldAccents(query).toLowerCase();
  const matched = new Set();
  for (const [canonical, kws] of Object.entries(GEOGRAPHY_KWS)) {
    if (kws.some(k => text.includes(foldAccents(k).toLowerCase()))) matched.add(canonical);
  }
  if (matched.size > 0) { matched.add('Latin America'); matched.add('LAC'); }
  return [...matched];
}

async function fetchTopicGeoPool(query) {
  const topics = inferTopics(query);
  const geos   = inferGeography(query);
  if (!topics.length && !geos.length) return [];
  let q = SB.from('works')
    .select('id,canonical_doi,title,abstract,year,citation_count,venue,venue_kind,source,source_family,methodology_design,sms_level,causal_strength,scl_topics,geography,publication_type')
    .not('abstract', 'is', null)
    .limit(TOPIC_GEO_LIMIT);
  if (topics.length) q = q.contains('scl_topics', topics);
  if (geos.length)   q = q.overlaps('geography', geos);
  const { data, error } = await q;
  if (error) { console.warn(`  [topic-geo] ${error.message}`); return []; }
  return (data ?? []).map(r => ({ ...r, similarity: TOPIC_GEO_SIM, _retrievalSource: 'topic_geo_channel' }));
}

// ---------------------------------------------------------------------------
// Synonym expander (mirrors _eval-a-vs-b-vs-current.mjs)
// ---------------------------------------------------------------------------
const SYNONYM_MAP = [
  { pattern: /\bgender.{0,5}violence\b|\bgbv\b/i,
    expansions: ['domestic violence','intimate partner violence','IPV','violence against women'] },
  { pattern: /\bdomestic violence\b/i,
    expansions: ['intimate partner violence','IPV','gender violence','gender-based violence'] },
  { pattern: /\blabor (outcomes?|market results?)\b|\blabour (outcomes?|market results?)\b/i,
    expansions: ['employment','wages','earnings','unemployment','workforce participation'] },
  { pattern: /\binformal (sector|employment|work)\b/i,
    expansions: ['informality','informal labor','self-employment','undeclared work'] },
  { pattern: /\bcash transfers?\b/i,
    expansions: ['conditional cash transfer','CCT','social protection','safety net','Bolsa Familia','Progresa','Oportunidades'] },
  { pattern: /\beducation outcomes?\b|\blearning outcomes?\b/i,
    expansions: ['school enrollment','attendance','test scores','academic achievement','literacy'] },
  { pattern: /\bteacher incentives?\b/i,
    expansions: ['teacher bonuses','teacher retention','teacher recruitment','merit pay'] },
  { pattern: /\bteacher quality\b|\bteacher effectiveness\b/i,
    expansions: ['teacher value-added','teacher VA','teacher effects','value-added teacher','teacher impacts'] },
  { pattern: /\bnutrition\b/i,
    expansions: ['stunting','malnutrition','food security','child development','dietary'] },
  { pattern: /\b(im|e)?migration\b|\b(im|e)?migrants?\b/i,
    expansions: ['emigration','immigration','remittances','displacement','refugees','internal migration','foreign-born','Mariel'] },
  { pattern: /\btrade liberali[sz]ation\b|\btariff (cut|reduction)s?\b|\btrade reform\b/i,
    expansions: ['import competition','China shock','tariff reduction','WTO accession','globalization','trade shock'] },
  { pattern: /\bfinancial inclusion\b/i,
    expansions: ['banking access','credit access','microfinance','mobile money','digital payments','unbanked'] },
  { pattern: /\bminimum wage\b/i,
    expansions: ['minimum wages','wage floor','minimum pay','statutory wage','labor regulation'] },
  { pattern: /\bclimate (shock|change)\b|\bweather shock\b/i,
    expansions: ['drought','flood','temperature shock','rainfall','natural disaster','crop yield'] },
  { pattern: /\bviolence\b/i,
    expansions: ['crime','homicide','conflict','gang violence','drug trafficking'] },
  { pattern: /\bautomation\b|\broboti(cs|zation)\b/i,
    expansions: ['artificial intelligence','technological displacement','job displacement','routine tasks','task automation'] },
  { pattern: /\bstudent learning\b|\bhuman capital\b|\bschooling\b/i,
    expansions: ['cognitive skills','test scores','school quality','educational attainment','productivity growth','GDP growth'] },
  { pattern: /\bproductivity\b|\bgrowth\b/i,
    expansions: ['total factor productivity','TFP','GDP growth','economic growth','long-run growth'] },
];

function expandQuery(query) {
  const appended = [];
  const added = new Set();
  for (const { pattern, expansions } of SYNONYM_MAP) {
    if (pattern.test(query)) {
      for (const term of expansions) {
        const n = term.toLowerCase();
        if (!query.toLowerCase().includes(n) && !added.has(n)) {
          appended.push(term);
          added.add(n);
        }
      }
    }
  }
  return appended.length ? `${query} ${appended.join(' ')}` : query;
}

// ---------------------------------------------------------------------------
// OPTION B: bridged foundational slice (mirrors _eval-a-vs-b-vs-current.mjs)
// ---------------------------------------------------------------------------
function buildBridgeTerms(query) {
  const expanded = expandQuery(query);
  const STOP = new Set(['what','is','the','of','on','in','and','for','to','a','an','does','do','how','impact','effect','effects','evidence','causal','best','works','countries']);
  const words = foldAccents(expanded.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
  const uniq = [...new Set(words)];
  return uniq.slice(0, 15);
}

function lexScore(p, bridgeTerms) {
  const title = (p.title ?? '').toLowerCase();
  const abst  = (p.abstract ?? '').toLowerCase();
  let score = 0;
  for (const term of bridgeTerms) {
    if (title.includes(term)) score += 3;
    if (abst.includes(term))  score += 1;
  }
  return score;
}

async function fetchOptionBSlice(query) {
  const bridgeTerms = buildBridgeTerms(query);
  if (!bridgeTerms.length) return { papers: [], bridgeTerms };
  const ftsQuery = bridgeTerms.slice(0, 8).join(' OR ');
  const { data, error } = await SB.from('works')
    .select('id,canonical_doi,title,abstract,year,citation_count,venue,venue_kind,source,source_family,methodology_design,sms_level,causal_strength,geography,publication_type')
    .is('canonical_work_id', null)
    .not('is_noise', 'eq', true)
    .not('abstract', 'is', null)
    .lte('year', 2019)
    .gte('citation_count', 75)
    .textSearch('fts_vector', ftsQuery, { type: 'websearch', config: 'english' })
    .order('citation_count', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) {
    console.warn(`  [option-B] FTS error: ${error.message}`);
    return { papers: [], bridgeTerms };
  }
  const scored = (data ?? []).map(r => ({
    ...r,
    _lexScore: lexScore(r, bridgeTerms),
    similarity: 0.55,   // synthetic (original value)
    _retrievalSource: 'option_b_bridged',
  }));
  scored.sort((a, b) => (b._lexScore - a._lexScore) || (b.citation_count - a.citation_count));
  return { papers: scored.slice(0, OPTION_B_QUOTA), bridgeTerms, totalFtsMatches: data.length };
}

// ---------------------------------------------------------------------------
// Canary recall measurement
// ---------------------------------------------------------------------------
function measureRecall20(retrievedPapers, canaries) {
  const topSet = new Set(
    retrievedPapers.slice(0, TOP_20_K)
      .map(p => normDoi(p.canonical_doi))
      .filter(Boolean),
  );
  return canaries
    .filter(c => c.doi_hint)
    .map(c => ({
      id: c.id,
      doi_hint: c.doi_hint,
      title: c.title,
      label: c.label,
      year: c.year ?? null,
      found: topSet.has(normDoi(c.doi_hint)),
    }));
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== eval-rerank-boost ===');
  console.log('Variants: CURRENT | OPTION-B | B+boost@0.80 | B+boost@0.88\n');

  // Merge queries.json with extra inline queries
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const allQueries = [
    ...evals.queries.filter(q => SELECTED_QUERY_IDS.has(q.id)),
    ...EXTRA_QUERIES,
  ];

  if (!allQueries.length) {
    console.error('No matching queries found'); process.exit(1);
  }

  // Validate a couple of canaries first
  console.log('--- Validation: resolving Hanushek DOI in corpus ---');
  const hanushekDoi = '10.1257/aer.90.5.1184';
  const { data: hRows } = await SB.from('works')
    .select('id, canonical_doi, title, citation_count, year')
    .eq('canonical_doi', hanushekDoi)
    .limit(2);
  if (hRows?.length) {
    console.log(`  Hanushek 2000 FOUND in corpus: id=${hRows[0].id} cit=${hRows[0].citation_count} year=${hRows[0].year}`);
  } else {
    console.log(`  Hanushek 2000 NOT FOUND in corpus by exact DOI — will check normalised doi in retrieval`);
    // Try normalized
    const { data: hRows2 } = await SB.from('works')
      .select('id, canonical_doi, title, citation_count, year')
      .ilike('canonical_doi', `%aer.90.5%`)
      .limit(3);
    if (hRows2?.length) {
      console.log(`  Fuzzy match: ${hRows2.map(r => `id=${r.id} doi=${r.canonical_doi}`).join(', ')}`);
    } else {
      console.log(`  Not found by fuzzy match either — corpus may not have this paper`);
    }
  }
  console.log('--- Validation complete ---\n');

  const results = [];
  // Accumulators for aggregate means
  const acc = {
    current:    { recall20: 0, meanCos: 0, n: 0, cosN: 0 },
    optionB:    { recall20: 0, meanCos: 0, n: 0, cosN: 0 },
    boost080:   { recall20: 0, meanCos: 0, n: 0, cosN: 0 },
    boost088:   { recall20: 0, meanCos: 0, n: 0, cosN: 0 },
  };

  for (const q of allQueries) {
    const canaries = (q.canary_papers ?? []).filter(c => c.doi_hint);
    if (!canaries.length) {
      console.log(`Skipping ${q.id} — no doi_hint canaries`);
      continue;
    }
    console.log(`\n=== ${q.id} ===`);
    console.log(`  query: "${q.query}"`);
    console.log(`  canaries: ${canaries.length}`);

    // 1. Embed query (needed for both retrieval + true-cosine precision guard)
    let queryVec;
    try {
      queryVec = await embed(q.query);
    } catch (e) {
      console.error(`  embed failed: ${e.message}`); continue;
    }

    // 2. Base retrieval: vector + topic-geo
    process.stdout.write('  Fetching base pool (RPC + topic-geo)...');
    const [rpcRes, topicGeoPool] = await Promise.all([
      SB.rpc('match_works_v2', {
        query_embedding: queryVec,
        query_text: q.query,
        match_threshold: MATCH_THRESHOLD,
        match_count: MATCH_COUNT_POOL,
      }),
      fetchTopicGeoPool(q.query),
    ]);
    if (rpcRes.error) {
      console.error(`\n  RPC error: ${rpcRes.error.message}`); continue;
    }
    const seen0 = new Set();
    const basePool = [];
    for (const p of (rpcRes.data ?? [])) {
      const k = keyOf(p); if (seen0.has(k)) continue; seen0.add(k); basePool.push(p);
    }
    for (const p of topicGeoPool) {
      const k = keyOf(p); if (seen0.has(k)) continue; seen0.add(k); basePool.push(p);
    }
    console.log(` ${basePool.length} papers`);

    // 3. CURRENT: rerank base pool → top-20
    const currentTop20 = rerankAndDedup(basePool, q.query, TOP_20_K);
    const currentRecall = measureRecall20(currentTop20, canaries);
    const currentHit20  = currentRecall.filter(c => c.found).length;

    // 4. OPTION B: add bridged foundational slice
    process.stdout.write('  Fetching Option B bridged slice...');
    const { papers: bPapers, bridgeTerms, totalFtsMatches } = await fetchOptionBSlice(q.query);
    console.log(` ${bPapers.length} bridged (${totalFtsMatches ?? '?'} FTS matches)`);
    if (bPapers.length) console.log(`    bridge terms: ${bridgeTerms.slice(0, 8).join(', ')}`);

    const seenB = new Set(basePool.map(p => keyOf(p)));
    const bPoolExtra = [];
    for (const p of bPapers) {
      const k = keyOf(p); if (seenB.has(k)) continue; seenB.add(k); bPoolExtra.push(p);
    }
    const bPool = [...basePool, ...bPoolExtra];
    const optionBTop20 = rerankAndDedup(bPool, q.query, TOP_20_K);
    const optionBRecall = measureRecall20(optionBTop20, canaries);
    const bHit20 = optionBRecall.filter(c => c.found).length;

    // 5. OPTION B + boost: same pool but raise synthetic sim of bridged papers
    function buildBoostPool(boostSim) {
      // Make a shallow copy of bPoolExtra with the boosted similarity,
      // preserving the rest of the paper metadata
      const boostedExtra = bPoolExtra.map(p => ({ ...p, similarity: boostSim }));
      // Rebuild pool: base papers untouched, boosted papers replacing the originals
      const seenBoost = new Set(basePool.map(p => keyOf(p)));
      const boostOnlyNew = [];
      for (const p of boostedExtra) {
        const k = keyOf(p); if (seenBoost.has(k)) continue; seenBoost.add(k); boostOnlyNew.push(p);
      }
      return [...basePool, ...boostOnlyNew];
    }

    const boost080Pool = buildBoostPool(0.80);
    const boost088Pool = buildBoostPool(0.88);
    const boost080Top20 = rerankAndDedup(boost080Pool, q.query, TOP_20_K);
    const boost088Top20 = rerankAndDedup(boost088Pool, q.query, TOP_20_K);
    const boost080Recall = measureRecall20(boost080Top20, canaries);
    const boost088Recall = measureRecall20(boost088Top20, canaries);
    const boost080Hit20 = boost080Recall.filter(c => c.found).length;
    const boost088Hit20 = boost088Recall.filter(c => c.found).length;

    // 6. Precision guard: fetch true cosines for union of all top-20 IDs
    process.stdout.write('  Fetching true cosines (precision guard)...');
    const allTop20Ids = [
      ...currentTop20, ...optionBTop20, ...boost080Top20, ...boost088Top20,
    ].map(p => p.id).filter(Boolean);
    const cosMap = await fetchTrueCosines(allTop20Ids, queryVec);
    console.log(` ${cosMap.size} vectors fetched`);

    const currentMeanCos = meanCosineTop20(currentTop20, cosMap);
    const bMeanCos       = meanCosineTop20(optionBTop20, cosMap);
    const boost080MeanCos = meanCosineTop20(boost080Top20, cosMap);
    const boost088MeanCos = meanCosineTop20(boost088Top20, cosMap);

    // 7. Per-canary breakdown
    const perCanary = canaries.map(c => ({
      id: c.id, doi: c.doi_hint, title: (c.title ?? '').slice(0, 70), label: c.label, year: c.year,
      current:   { in20: currentRecall.find(x => x.id === c.id)?.found ?? false },
      optionB:   { in20: optionBRecall.find(x => x.id === c.id)?.found ?? false },
      boost080:  { in20: boost080Recall.find(x => x.id === c.id)?.found ?? false },
      boost088:  { in20: boost088Recall.find(x => x.id === c.id)?.found ?? false },
    }));

    console.log(`  CURRENT:      recall@20=${currentHit20}/${canaries.length}  meanCos=${currentMeanCos != null ? currentMeanCos.toFixed(4) : 'n/a'}`);
    console.log(`  OPTION-B:     recall@20=${bHit20}/${canaries.length}  meanCos=${bMeanCos != null ? bMeanCos.toFixed(4) : 'n/a'}`);
    console.log(`  B+boost@0.80: recall@20=${boost080Hit20}/${canaries.length}  meanCos=${boost080MeanCos != null ? boost080MeanCos.toFixed(4) : 'n/a'}`);
    console.log(`  B+boost@0.88: recall@20=${boost088Hit20}/${canaries.length}  meanCos=${boost088MeanCos != null ? boost088MeanCos.toFixed(4) : 'n/a'}`);

    // Identify bridged papers that made it into top-20 under boost
    const bridgedIds = new Set(bPoolExtra.map(p => p.id));
    const bridgedInBoost080 = boost080Top20.filter(p => bridgedIds.has(p.id)).map(p => ({ id: p.id, title: (p.title ?? '').slice(0, 60), citation_count: p.citation_count, sms: p.sms_level, rank: boost080Top20.indexOf(p) + 1 }));
    const bridgedInBoost088 = boost088Top20.filter(p => bridgedIds.has(p.id)).map(p => ({ id: p.id, title: (p.title ?? '').slice(0, 60), citation_count: p.citation_count, sms: p.sms_level, rank: boost088Top20.indexOf(p) + 1 }));
    if (bridgedInBoost080.length) {
      console.log(`    B+boost@0.80 bridged papers in top-20: ${bridgedInBoost080.map(x => `#${x.rank} "${x.title.slice(0,40)}…"`).join(', ')}`);
    }

    results.push({
      query_id: q.id,
      query: q.query,
      n_canaries: canaries.length,
      current: {
        recall20: r2(currentHit20 / canaries.length),
        hit20: currentHit20,
        meanCos20: currentMeanCos != null ? r4(currentMeanCos) : null,
      },
      optionB: {
        recall20: r2(bHit20 / canaries.length),
        hit20: bHit20,
        meanCos20: bMeanCos != null ? r4(bMeanCos) : null,
        novel_bridged_added: bPoolExtra.length,
        total_fts_matches: totalFtsMatches ?? null,
        bridge_terms: bridgeTerms.slice(0, 8),
      },
      boost080: {
        recall20: r2(boost080Hit20 / canaries.length),
        hit20: boost080Hit20,
        meanCos20: boost080MeanCos != null ? r4(boost080MeanCos) : null,
        bridged_papers_in_top20: bridgedInBoost080.length,
        bridged_papers_detail: bridgedInBoost080,
      },
      boost088: {
        recall20: r2(boost088Hit20 / canaries.length),
        hit20: boost088Hit20,
        meanCos20: boost088MeanCos != null ? r4(boost088MeanCos) : null,
        bridged_papers_in_top20: bridgedInBoost088.length,
        bridged_papers_detail: bridgedInBoost088,
      },
      per_canary: perCanary,
    });

    // Accumulate
    acc.current.recall20  += currentHit20 / canaries.length; acc.current.n++;
    acc.optionB.recall20  += bHit20 / canaries.length; acc.optionB.n++;
    acc.boost080.recall20 += boost080Hit20 / canaries.length; acc.boost080.n++;
    acc.boost088.recall20 += boost088Hit20 / canaries.length; acc.boost088.n++;
    if (currentMeanCos != null)  { acc.current.meanCos  += currentMeanCos;  acc.current.cosN++;  }
    if (bMeanCos != null)        { acc.optionB.meanCos  += bMeanCos;        acc.optionB.cosN++;  }
    if (boost080MeanCos != null) { acc.boost080.meanCos += boost080MeanCos; acc.boost080.cosN++; }
    if (boost088MeanCos != null) { acc.boost088.meanCos += boost088MeanCos; acc.boost088.cosN++; }
  }

  const n = acc.current.n;
  const aggregate = {
    n_queries_run: n,
    mean_recall20: {
      current:  r3(acc.current.recall20 / n),
      optionB:  r3(acc.optionB.recall20 / n),
      boost080: r3(acc.boost080.recall20 / n),
      boost088: r3(acc.boost088.recall20 / n),
    },
    mean_meanCos20: {
      current:  acc.current.cosN  ? r4(acc.current.meanCos  / acc.current.cosN)  : null,
      optionB:  acc.optionB.cosN  ? r4(acc.optionB.meanCos  / acc.optionB.cosN)  : null,
      boost080: acc.boost080.cosN ? r4(acc.boost080.meanCos / acc.boost080.cosN) : null,
      boost088: acc.boost088.cosN ? r4(acc.boost088.meanCos / acc.boost088.cosN) : null,
    },
    delta_vs_current: {
      optionB_recall20:  r3((acc.optionB.recall20  - acc.current.recall20)  / n),
      boost080_recall20: r3((acc.boost080.recall20 - acc.current.recall20) / n),
      boost088_recall20: r3((acc.boost088.recall20 - acc.current.recall20) / n),
    },
  };

  // Print summary table
  console.log('\n\n=== RESULTS TABLE ===');
  console.log('Query'.padEnd(50) + ' N  CURRENT          OPTION-B         B+boost@0.80     B+boost@0.88');
  console.log(''.padEnd(50) + '    @20 / cos@20    @20 / cos@20    @20 / cos@20    @20 / cos@20');
  console.log('─'.repeat(120));
  for (const r of results) {
    const fmtCol = (recall, cos) => `${pc(recall)}/${cos != null ? cos.toFixed(3) : '?'}`;
    const curr  = fmtCol(r.current.recall20, r.current.meanCos20);
    const optB  = fmtCol(r.optionB.recall20, r.optionB.meanCos20);
    const b080  = fmtCol(r.boost080.recall20, r.boost080.meanCos20);
    const b088  = fmtCol(r.boost088.recall20, r.boost088.meanCos20);
    console.log(`${r.query_id.padEnd(50)}${String(r.n_canaries).padEnd(4)}${curr.padEnd(17)}${optB.padEnd(17)}${b080.padEnd(17)}${b088}`);
  }
  console.log('─'.repeat(120));
  const ag = aggregate;
  const currAgg  = `${pc(ag.mean_recall20.current)}/${ag.mean_meanCos20.current ?? '?'}`;
  const bAgg     = `${pc(ag.mean_recall20.optionB)}/${ag.mean_meanCos20.optionB ?? '?'}`;
  const b080Agg  = `${pc(ag.mean_recall20.boost080)}/${ag.mean_meanCos20.boost080 ?? '?'}`;
  const b088Agg  = `${pc(ag.mean_recall20.boost088)}/${ag.mean_meanCos20.boost088 ?? '?'}`;
  console.log(`${'MEAN (n=' + n + ')'.padEnd(54)}${currAgg.padEnd(17)}${bAgg.padEnd(17)}${b080Agg.padEnd(17)}${b088Agg}`);
  console.log('');
  console.log('Delta recall@20 vs CURRENT:');
  console.log(`  Option B:    ${fmtDelta(ag.delta_vs_current.optionB_recall20)}`);
  console.log(`  B+boost@0.80: ${fmtDelta(ag.delta_vs_current.boost080_recall20)}`);
  console.log(`  B+boost@0.88: ${fmtDelta(ag.delta_vs_current.boost088_recall20)}`);

  const hanushekResult = results.find(r => r.query_id === 'q-student-learning-productivity-growth');
  if (hanushekResult) {
    const hCanary = hanushekResult.per_canary.find(c => c.id === 'hanushek-2000-aer');
    if (hCanary) {
      console.log('\n--- HANUSHEK HEADLINE RESULT ---');
      console.log(`  Hanushek 2000 in top-20:`);
      console.log(`    CURRENT:      ${hCanary.current.in20 ? 'YES' : 'no'}`);
      console.log(`    OPTION-B:     ${hCanary.optionB.in20 ? 'YES' : 'no'}`);
      console.log(`    B+boost@0.80: ${hCanary.boost080.in20 ? 'YES' : 'no'}`);
      console.log(`    B+boost@0.88: ${hCanary.boost088.in20 ? 'YES' : 'no'}`);
    }
  }

  // Save output
  const output = {
    runAt: new Date().toISOString(),
    config: {
      selected_queries: [...SELECTED_QUERY_IDS],
      match_count_pool: MATCH_COUNT_POOL,
      top_k: TOP_20_K,
      option_b: { quota: OPTION_B_QUOTA },
      boost_levels: [0.80, 0.88],
      precision_guard: 'mean true query·paper cosine from stored works.embedding over top-20',
    },
    canary_matching: 'doi_hint → canonical_doi in top-20 (exact after normalization). Canaries with doi_hint:null excluded.',
    aggregate,
    per_query: results,
    caveats: [
      'recall@20 measured against a small hand-labeled canary set (2-3 per query). Sparse ground truth — a variant may swap one good paper for another equally good paper not in the canary set, appearing as a regression even when precision is maintained.',
      'meanCos@20 is the mean TRUE query·paper cosine (from stored works.embedding) over the top-20. Higher = more topically relevant pool overall. This is the precision guard: a boost that floods the top-20 with off-topic high-citation papers will show a drop here.',
      'B+boost variants raise the SYNTHETIC similarity placeholder of bridged foundational papers from 0.55 → 0.80/0.88 before reranking. This simulates what a foundational-channel-specific HyDE or a re-embedding pass would achieve — it is NOT a live vector cosine.',
      'The P0 citation gate remains active: off-topic mega-cited papers (Lancet GBD, etc.) with no FTS signal or direct-* classification still have their citation score dammed to ×0.20.',
      'Layer-2 sim floor (sms≥4 → sim 0.60) applies to the original 0.55 placeholder but is overridden by the boost values (0.80/0.88 > 0.60).',
      'option_b_bridged source is included in the SYNTHETIC_SRCS P0 gate set, so boosted bridged papers with no on-topic signal are still P0-gated on citation.',
      'Works.embedding is nullable. Papers without stored embeddings are excluded from meanCos. In practice, the eval-gold notes ~98% of canonical papers have embeddings.',
    ],
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${OUTPUT_PATH}`);
}

function r2(n) { return Math.round(n * 100) / 100; }
function r3(n) { return Math.round(n * 1000) / 1000; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function pc(f) { return `${Math.round(f * 100)}%`; }
function fmtDelta(d) {
  const s = d >= 0 ? '+' : '';
  return `${s}${Math.round(d * 100)}pp`;
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
