/**
 * eval-gold.mjs
 *
 * Thin one-command eval harness over the 23 gold queries. Prints one line of
 * metrics + writes evals/baseline.json so future runs can compare.
 *
 * Two metrics in one pass:
 *   classifier agreement   — q01-q03 labeled papers, macro-F1 over {direct, indirect, excluded}
 *   canary_top20 hit rate  — fraction of canary_papers (with doi_hint) found in match_works_v2 top-20
 *
 * Mirrors production-faithful logic from eval-direct-indirect-classifier.mjs
 * (per-facet floor 0.45, prod thresholds 0.50/0.55) but outputs aggregate
 * numbers only — for trend tracking, not for diagnosis. Use the longer scripts
 * when you need a per-paper report.
 *
 * Usage:
 *   node scripts/eval-gold.mjs                 # run, print, update baseline
 *   node scripts/eval-gold.mjs --no-write      # run, print, do not write baseline
 *   node scripts/eval-gold.mjs --thresholds proposed   # 0.40/0.45 instead of prod
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL,
 *   LLM_API_KEY, OLLAMA_EMBEDDING_MODEL, LLM_MODEL.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';
// Production ranking — the REAL functions retrieveWorks() runs, imported straight
// from the Deno/TS shared module. Node 24 strips the TS types on import, so this
// .mjs can replay prod's rerank without the drift-prone JS mirror it used to carry.
// Same import pattern as scripts/rerank-ablation.ts / rerank-multiquery-eval.ts.
import {
  rerankUnified,
  orderByChannel,
  selectTopKDiverse,
  unifiedProfileName,
  DEFAULT_SELECTION_POOL_SIZE,
} from '../supabase/functions/_shared/rerank.ts';

// Load .env from cwd first, then optionally an external file via EVAL_ENV_FILE
// (the LLM/Supabase credentials may live outside the repo).
loadEnv();
if (process.env.EVAL_ENV_FILE) {
  loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });
}

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH  = join(__dir, '../evals/queries.json');
const BASELINE_PATH = join(__dir, '../evals/baseline.json');

const args = process.argv.slice(2);
const NO_WRITE = args.includes('--no-write');
const CALIBRATE = args.includes('--calibrate'); // sweep classifier thresholds (pff/floor/gm), no retrieval/canary
const PROPOSED = args.includes('--thresholds') && args[args.indexOf('--thresholds') + 1] === 'proposed';
const ONLY_ARG = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const ONLY = ONLY_ARG
  ? new Set(ONLY_ARG.split(',').map(s => s.trim()).filter(Boolean))
  : null;

const THRESHOLDS = PROPOSED
  ? { floor: 0.40, gm: 0.45, label: 'proposed (0.40/0.45)' }
  : { floor: 0.35, gm: 0.35, label: 'prod qwen (0.35/0.35)' }; // matches directIndirectClassifier getThresholds (qwen-768 recalibration 2026-06-12)

const PER_FACET_FLOOR = 0.35; // qwen-768: mirror prod floor (was 0.45 nomic)
const MATCH_THRESHOLD = 0.40;
const MATCH_COUNT_POOL = 100;  // broader pool fetched from RPC
const TOP_K            = 20;   // post-rerank top-K we evaluate canary hits in

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL  = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';

if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// LLM and geometry helpers (mirror of eval-direct-indirect-classifier.mjs)
// ---------------------------------------------------------------------------

const DECOMPOSE_SYSTEM_PROMPT = `You decompose policy/economics research queries into 2-4 conceptual FACETS for a faceted retrieval system.

Each facet represents one independent thing the user is asking about. ORDER MATTERS - the FIRST facet must be the user's primary subject (the intervention, technology, or core topic). Geography is almost never primary and should appear LAST.

For each facet output 10-22 synonyms / near-synonyms / lay terms / sub-types that academic papers in that subfield use. Include literature vocabulary, not just rephrasings of the user's words.

When the query mentions LAC, include Spanish (and Portuguese for Brazil) terms. Extract a "geography" facet ONLY when the query mentions a region/country.

Output strict JSON:
{ "facets": [ { "label": "<short label>", "expansion": ["term1", "term2", ...] } ] }

Labels lowercase. Terms lowercase. No duplicates.`;

const LAC_TERMS = [
  'latin america','latin american','america latina','américa latina','latam','lac',
  'caribbean','caribe','south america','central america','mesoamerica',
  'argentina','bolivia','brazil','brasil','chile','colombia','costa rica','cuba',
  'dominican republic','ecuador','el salvador','guatemala','haiti','honduras',
  'jamaica','mexico','méxico','nicaragua','panama','paraguay','peru','perú',
  'uruguay','venezuela',
];
function foldAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const LAC_REGEX = new RegExp(`\\b(${LAC_TERMS.map(t => foldAccents(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

async function qwenDecompose(query) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'system', content: DECOMPOSE_SYSTEM_PROMPT }, { role: 'user', content: query }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  const j = await r.json();
  try { return JSON.parse(j.choices?.[0]?.message?.content ?? '{}'); }
  catch { return { facets: [] }; }
}

// Match the PROD embed path (ollamaClient): task prefixes are nomic-only — qwen
// needs none (and a stray 'search_query: ' lands it in the wrong sub-space). qwen
// is an MRL model so we MUST request dimensions=768 or it returns 4096-dim and the
// cosine() length-mismatch guard nulls every similarity → 0 recall.
const EVAL_IS_NOMIC = /nomic/i.test(EMBED_MODEL);
const EVAL_EMBED_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;
async function embedBatch(texts, prefix = 'search_query: ') {
  const pfx = EVAL_IS_NOMIC ? prefix : '';
  const body = { model: EMBED_MODEL, input: texts.map(t => pfx + t) };
  if (EVAL_EMBED_DIMS) body.dimensions = EVAL_EMBED_DIMS;
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.data) throw new Error('embed fail: ' + JSON.stringify(j).slice(0, 150));
  return j.data.map(d => d.embedding);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
}
function geometricMean(values) {
  if (!values.length) return 0;
  const safe = values.map(v => Math.max(v, 1e-6));
  return Math.exp(safe.reduce((s, v) => s + Math.log(v), 0) / safe.length);
}
function geographyHit(title, abstract) {
  return LAC_REGEX.test(foldAccents(`${title ?? ''} ${abstract ?? ''}`.toLowerCase()));
}
function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }

function classify(facetSims, requiredFacets, geoHit) {
  const scores = requiredFacets.map(f => facetSims[f] ?? 0);
  if (!scores.length) return 'excluded';
  const gm = geometricMean(scores);
  const allClear = scores.every(s => s >= THRESHOLDS.floor);
  const anyClear = scores.some(s => s >= THRESHOLDS.floor);
  if (allClear && gm >= THRESHOLDS.gm) return geoHit ? 'direct-lac' : 'direct-global';
  if (anyClear) return 'indirect';
  return 'excluded';
}

// ---------------------------------------------------------------------------
// Production ranking replay — retrieval.ts rerank section.
//
// The gate used to carry a HAND-MAINTAINED JS MIRROR of the retired legacy
// rerankMerged(). Production retrieveWorks() now ranks EXCLUSIVELY through
// rerankUnified() (the RB_UNIFIED flag was retired), so the gate must run the
// SAME code prod runs — there is nothing to keep in sync. The three ranking
// functions (rerankUnified / selectTopKDiverse / orderByChannel) are imported
// from rerank.ts at the top of this file. This section adds only the two things
// retrieval.ts wraps around them: the real-cosine attach (cosine_for_ids RPC)
// and the cosine relevance floor.
//
// normDoiKey / normTitleKey are the pool-merge dedup keys used by canaryHit —
// kept here (they mirror the exported helpers rerank.ts uses internally).
// ---------------------------------------------------------------------------

function normDoiKey(doi) {
  if (!doi) return '';
  return String(doi).toLowerCase().trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

function normTitleKey(title) {
  if (!title) return '';
  return String(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bnber\s+working\s+paper\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\biza\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\bssrn\s+\d+\b/g, '')
    .replace(/\bcesifo\s+(working\s+paper|wp)\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\bcepr\s+(discussion\s+paper|dp)\s+(no\.?\s+)?\d+\b/g, '')
    .replace(/\(working\s+paper\)/g, '')
    .replace(/\(preprint\)/g, '')
    .replace(/\(revised\)/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Real query·paper cosine for an explicit id set — mirror of vectorSearch.ts
// cosineForIds (retrieval.ts attaches paper.realCosine with this before rerank).
// The SB service-role client calls the cosine_for_ids RPC directly; ids with a
// null embedding are absent from the returned map (caller falls back to
// paper.similarity). Same 500-id chunking + param names as prod.
async function cosineForIds(queryVec, ids) {
  const out = new Map();
  if (!ids.length || !queryVec?.length) return out;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await SB.rpc('cosine_for_ids', { p_query: queryVec, p_ids: slice });
    if (error) { console.error('[cosineForIds]', error.message); continue; }
    for (const r of data ?? []) out.set(String(r.id), Number(r.cosine));
  }
  return out;
}

// Cosine relevance floor — mirror of retrieval.ts (post-orderByChannel trim).
// Keeps papers whose REAL query cosine ≥ max(RB_REL_FLOOR 0.45, topCos − RB_REL_DELTA
// 0.15); topCos is computed over GENUINE cosines only (papers with _realCosExact),
// falling back to all only in the degraded embed path. Always retains at least
// RB_REL_MIN_KEEP (8) most-relevant papers (unless RB_REL_MINKEEP_STRICT=1).
// RB_REL_FLOOR=0 disables. Returns the trimmed list.
function applyRelevanceFloor(evidence) {
  const relAbsMin  = Number(process.env.RB_REL_FLOOR ?? '0.45');
  const relDelta   = Number(process.env.RB_REL_DELTA ?? '0.15');
  const relMinKeep = Number(process.env.RB_REL_MIN_KEEP ?? '8');
  const strict     = process.env.RB_REL_MINKEEP_STRICT === '1';
  if (!(relAbsMin > 0) || evidence.length <= relMinKeep) return evidence;
  const cos = (p) => Number(p.realCosine ?? p.similarity ?? 0);
  const exact = evidence.filter((p) => p._realCosExact);
  const topPool = exact.length > 0 ? exact : evidence;
  const top = topPool.reduce((m, p) => Math.max(m, cos(p)), 0);
  const thr = Math.max(relAbsMin, top - relDelta);
  const above = evidence.filter((p) => cos(p) >= thr);
  const keepIds = new Set(
    [...evidence].sort((a, b) => cos(b) - cos(a)).slice(0, relMinKeep).map((p) => p.id),
  );
  const byCosDesc = evidence.filter((p) => keepIds.has(p.id));
  return strict ? above : (above.length >= relMinKeep ? above : byCosDesc);
}

// ---------------------------------------------------------------------------
// Metric 1: classifier agreement on labeled queries
// ---------------------------------------------------------------------------

async function classifierAgreement(query) {
  const labeled = Object.values(query.labels ?? {}).filter(e => e.doi);
  if (!labeled.length) return null;

  const facets = (await qwenDecompose(query.query)).facets ?? [];
  const topicFacets = facets.filter(f => !/^(geo|geography|region|location|country|countries|place)$/i.test(f.label));
  if (!topicFacets.length) return null;

  const facetTexts = topicFacets.map(f => `${f.label} ${(f.expansion ?? []).slice(0, 12).join(' ')}`);
  const facetVecs = await embedBatch(facetTexts);

  const dois = labeled.map(l => normDoi(l.doi));
  const { data: rows } = await SB.from('works').select('id, canonical_doi, title, abstract, embedding').in('canonical_doi', dois);
  const rowByDoi = new Map((rows ?? []).map(r => [normDoi(r.canonical_doi), r]));

  // Returns array of { humanLabel, predicted } for each labeled paper that we could score
  const out = [];
  for (const lp of labeled) {
    const row = rowByDoi.get(normDoi(lp.doi));
    if (!row) { out.push({ humanLabel: lp.label, predicted: 'not_in_corpus' }); continue; }
    const emb = parseEmbedding(row.embedding);
    if (!emb) { out.push({ humanLabel: lp.label, predicted: 'no_embedding' }); continue; }
    const sims = {};
    for (let i = 0; i < topicFacets.length; i++) {
      const c = cosine(facetVecs[i], emb);
      sims[topicFacets[i].label] = (c == null || c < PER_FACET_FLOOR) ? 0 : c;
    }
    const geo = geographyHit(row.title, row.abstract);
    out.push({ humanLabel: lp.label, predicted: classify(sims, topicFacets.map(f => f.label), geo) });
  }
  return out;
}

// Map predicted classifier output to {direct, indirect, excluded} bucket
function bucket(predicted) {
  if (predicted === 'direct-lac' || predicted === 'direct-global') return 'direct';
  if (predicted === 'indirect') return 'indirect';
  if (predicted === 'excluded') return 'excluded';
  return null; // not_in_corpus / no_embedding — exclude from metric
}
// Expected bucket per human label
function expectedBucket(humanLabel) {
  if (humanLabel === 'relevant') return 'direct';
  if (humanLabel === 'partial') return 'indirect';
  if (humanLabel === 'irrelevant') return 'excluded';
  return null;
}

function computeMacroF1(allPairs) {
  const classes = ['direct', 'indirect', 'excluded'];
  const tp = Object.fromEntries(classes.map(c => [c, 0]));
  const fp = Object.fromEntries(classes.map(c => [c, 0]));
  const fn = Object.fromEntries(classes.map(c => [c, 0]));
  let scored = 0;
  for (const { humanLabel, predicted } of allPairs) {
    const exp = expectedBucket(humanLabel);
    const got = bucket(predicted);
    if (!exp || !got) continue;
    scored++;
    if (got === exp) tp[exp]++;
    else { fp[got]++; fn[exp]++; }
  }
  const f1s = classes.map(c => {
    const p = tp[c] + fp[c] === 0 ? 0 : tp[c] / (tp[c] + fp[c]);
    const r = tp[c] + fn[c] === 0 ? 0 : tp[c] / (tp[c] + fn[c]);
    return p + r === 0 ? 0 : (2 * p * r) / (p + r);
  });
  return { macroF1: f1s.reduce((s, v) => s + v, 0) / classes.length, scored, perClass: Object.fromEntries(classes.map((c, i) => [c, f1s[i]])) };
}

function perLabelRecall(allPairs) {
  const buckets = { relevant: { hit: 0, total: 0 }, partial: { hit: 0, total: 0 }, irrelevant: { hit: 0, total: 0 } };
  for (const { humanLabel, predicted } of allPairs) {
    if (!buckets[humanLabel]) continue;
    buckets[humanLabel].total++;
    if (bucket(predicted) === expectedBucket(humanLabel)) buckets[humanLabel].hit++;
  }
  return {
    relevant_recall:   buckets.relevant.total   ? buckets.relevant.hit   / buckets.relevant.total   : null,
    partial_recall:    buckets.partial.total    ? buckets.partial.hit    / buckets.partial.total    : null,
    irrelevant_recall: buckets.irrelevant.total ? buckets.irrelevant.hit / buckets.irrelevant.total : null,
    counts: buckets,
  };
}

// ---------------------------------------------------------------------------
// Topic+Geography parallel channel — MIRROR of supabase/functions/_shared/topicGeoChannel.ts.
//
// Vector retrieval (match_works_v2) misses ~95% of relevant papers on queries
// like "AI and labor in LAC" because nomic-embed-text under-performs on the
// Spanish/Portuguese long-tail and specialty journals. This deterministic
// channel queries the works table by scl_topics + geography arrays directly,
// merges results into the pool before rerank, and lets the composite
// (similarity 0.50, rigor 0.15, citation 0.20, fts 0.05, etc.) sort them.
//
// Semantics: AND across topics (paper has ALL inferred topics), AND with
// geography. Smoke-tested AI×LAC: 43k OR matches → 59 AND matches.
// Synthetic similarity=0.45 just above the 0.40 gate; vector-strong papers
// (sim > 0.45) still outrank.
//
// Keep in sync with topicGeoChannel.ts SCL_TOPICS / GEOGRAPHY_KEYWORDS.
// ---------------------------------------------------------------------------

const SCL_TOPICS_EVAL = {
  ecd: [
    "early childhood","child development","parenting program","home visiting",
    "nurturing care","early stimulation","preschool","kindergarten","ecd",
    "early intervention","child mental health","infant","toddler","caregiver training",
    "early years","child welfare","daycare","childcare","creche","head start",
    "early education","developmental delay","school readiness","cognitive stimulation",
    "primera infancia","desarrollo infantil","cuidado infantil","estimulacion temprana",
  ],
  education: [
    "teacher effectiveness","teacher quality","teacher sorting","teacher allocation",
    "school quality","learning outcomes","education technology","edtech",
    "college access","dropout","stem education","literacy","numeracy","curriculum",
    "principal leadership","teacher training","teacher recruitment","school efficiency",
    "remote tutoring","student achievement","test score","pisa","terce","serce",
    "private school","voucher","charter school","education reform","higher education",
    "university access","school dropout","retention school",
    "educacion","maestro","docente","escuela","aprendizaje",
  ],
  labor_markets: [
    "labor market","labour market","employment","wage subsidy","tvet",
    "vocational training","skills certification","active labor market",
    "public employment service","unemployment","informal employment","informality",
    "monopsony","labor regulation","minimum wage","job training","digital skills",
    "workforce development","occupational","labor productivity","wage inequality",
    "labor formalization","cerrando brechas","taxing wages",
    "mercado laboral","empleo","desempleo","salario","capacitacion",
    "labor","labour","wages","earnings","jobs","workers","workforce",
    "trabajo","trabalho","trabajadores","trabalhadores","salaire",
  ],
  social_protection: [
    "cash transfer","conditional cash","unconditional cash","cct",
    "social protection","social registry","social assistance","safety net",
    "bolsa familia","progresa","oportunidades","familias en accion","targeting",
    "beneficiary selection","social insurance","social spending","food stamps",
    "in-kind transfer","workfare","welfare program","anti-poverty",
    "transferencias condicionadas","proteccion social","registro social",
  ],
  aging_ltc: [
    "aging","ageing","elderly","older adult","older worker","pension",
    "retirement","long-term care","dementia","alzheimer","frail elderly",
    "informal caregiver","caregiver burden","geriatric","elder care",
    "care economy","social care","nursing home","home care","pension reform",
    "aging population","population aging","silver economy",
    "envejecimiento","adulto mayor","cuidado largo plazo","cuidados informales",
  ],
  health: [
    "health system","hospital efficiency","primary care","ncd",
    "non-communicable disease","chronic disease","public health",
    "health insurance","mental health","maternal health","child health",
    "vaccination","immunization","health workforce","telemedicine",
    "salud","atencion primaria","salud publica",
  ],
  gender_gbv: [
    "gender","women","female labor","gender gap","gender wage gap",
    "intimate partner violence","domestic violence","ipv","gender-based violence",
    "violence against women","femicide","gender norms","female empowerment",
    "genero","violencia de genero","violencia domestica",
  ],
  diversity: [
    "racial","ethnic","indigenous","afro-descendant","afro-latino",
    "minority","discrimination","diversity","inclusion",
    "afrodescendiente","pueblos indigenas","discriminacion",
  ],
  migration: [
    "migration","immigration","emigration","migrant","remittance","refugee",
    "displaced","diaspora","venezuelan migration","central american migration",
    "migracion","remesas","refugiados","desplazados",
  ],
  ai_digital: [
    "artificial intelligence","machine learning","automation impact","ai impact",
    "digital transformation","platform economy","algorithm","fintech","govtech",
    "ai education","ai in labor","robot","job displacement","future of work",
    "ai bias","ai health","ai hiring","algorithmic","digital public service",
    "ai automation","task automation","technology unemployment",
    "inteligencia artificial","automatizacion","transformacion digital","plataformas digitales",
    "ai","automation","robots","robotics","generative ai","chatgpt","llm",
    "deep learning","neural network","computerization","industry 4.0",
    "technological change","skill-biased technical change","sbtc",
  ],
  climate_resilience: [
    "climate change","climate shock","natural disaster","drought","flood",
    "hurricane","extreme weather","climate adaptation","climate mitigation",
    "environmental policy","climate resilience","disaster risk","weather shock",
    "cambio climatico","desastres naturales","resiliencia climatica",
  ],
};

const GEOGRAPHY_KEYWORDS_EVAL = {
  "Latin America": ["latin america","america latina","latinoamericana","latinoamerica","latam","lac"],
  "Caribbean": ["caribbean","caribe"],
  "Mexico": ["mexico","méxico"],
  "Brazil": ["brazil","brasil"],
  "Argentina": ["argentina"],
  "Chile": ["chile"],
  "Colombia": ["colombia"],
  "Peru": ["peru","perú"],
  "Ecuador": ["ecuador"],
  "Venezuela": ["venezuela"],
  "Bolivia": ["bolivia"],
  "Paraguay": ["paraguay"],
  "Uruguay": ["uruguay"],
  "Costa Rica": ["costa rica"],
  "Panama": ["panama","panamá"],
  "Guatemala": ["guatemala"],
  "Honduras": ["honduras"],
  "Nicaragua": ["nicaragua"],
  "El Salvador": ["el salvador"],
  "Dominican Republic": ["dominican republic","república dominicana"],
  "Haiti": ["haiti","haití"],
  "Jamaica": ["jamaica"],
};

function inferTopicsFromQueryEval(query) {
  const text = foldAccents(String(query)).toLowerCase();
  const matched = [];
  for (const [topic, kws] of Object.entries(SCL_TOPICS_EVAL)) {
    for (const kw of kws) {
      if (text.includes(foldAccents(kw).toLowerCase())) { matched.push(topic); break; }
    }
  }
  return matched;
}

function inferGeographyFromQueryEval(query) {
  const text = foldAccents(String(query)).toLowerCase();
  const matched = new Set();
  for (const [canonical, kws] of Object.entries(GEOGRAPHY_KEYWORDS_EVAL)) {
    for (const kw of kws) {
      if (text.includes(foldAccents(kw).toLowerCase())) { matched.add(canonical); break; }
    }
  }
  if (matched.size > 0) { matched.add("Latin America"); matched.add("LAC"); }
  return [...matched];
}

// 0.55 picked by parameter sweep (see topicGeoChannel.ts header).
// Sweep summary on gold canary_top20 (baseline 0.237):
//   sim=0.45/0.50  → 0.237 (no effect — never reaches top-20)
//   sim=0.55       → 0.237 or 0.254 across runs (bimodal; LLM query-expansion
//                    noise on the same param dominates the channel's signal)
//   sim=0.60       → 0.237 (regresses below 0.55's best — too aggressive)
// Channel's true value isn't in the gold metric (canaries are well-embedded)
// but in long-tail queries where vector recall is poor — see header.
// Env-overridable so future sweeps don't need code edits.
const TOPIC_GEO_SYNTHETIC_SIM = Number(process.env.TOPIC_GEO_SYNTHETIC_SIM ?? '0.55');
const TOPIC_GEO_LIMIT = Number(process.env.TOPIC_GEO_LIMIT ?? '200');

async function retrieveTopicGeoEval(query) {
  const topics = inferTopicsFromQueryEval(query);
  const geographies = inferGeographyFromQueryEval(query);
  if (topics.length === 0 && geographies.length === 0) {
    return { papers: [], topics, geographies, totalMatched: 0 };
  }
  let q = SB.from('works')
    // `classification` is runtime-attached by the classifier, not a column.
    .select('id, canonical_doi, title, abstract, year, citation_count, venue, venue_kind, source, source_family, methodology_design, sms_level, causal_strength, scl_topics, geography, publication_type', { count: 'exact' })
    .not('abstract', 'is', null)
    .limit(TOPIC_GEO_LIMIT);
  if (topics.length > 0)        q = q.contains('scl_topics', topics);
  if (geographies.length > 0)   q = q.overlaps('geography', geographies);
  const { data, count, error } = await q;
  if (error) {
    console.warn(`[eval topicGeo] ${error.message}`);
    return { papers: [], topics, geographies, totalMatched: null };
  }
  const papers = (data ?? []).map(row => ({
    ...row,
    similarity: TOPIC_GEO_SYNTHETIC_SIM,
    _retrievalSource: 'topic_geo_channel',
  }));
  return { papers, topics, geographies, totalMatched: count ?? null };
}

// ---------------------------------------------------------------------------
// Metric 2: canary top-20 hit rate
// ---------------------------------------------------------------------------

async function canaryHit(query, queryVec) {
  const canaries = (query.canary_papers ?? []).filter(c => c.doi_hint);
  if (!canaries.length) return { found: 0, total: 0, perPaper: [], pre2010: { found: 0, total: 0 }, post2010: { found: 0, total: 0 } };

  // Pull a broad pool from match_works_v2, then apply the imported production
  // ranking (rerankUnified), then take top-K. This matches the production
  // retrieveWorks() pipeline: RPC returns RRF-merged candidates, rerankUnified()
  // reorders by relevance (real cosine) × bounded channel/region boosts.
  // NOTE: query_text passes through raw — production's expandQueryForFTS()
  // is a no-op in effect because it AND-s synonyms (websearch_to_tsquery
  // bug; documented in IMPROVEMENT_PLAN.md Phase 1.1 findings). Mirroring
  // the no-op here keeps the eval consistent with prod.
  // Fire RPC + topic+geo channel in parallel (mirrors retrieval.ts Promise.all).
  const [rpcRes, topicGeoRes] = await Promise.all([
    SB.rpc('match_works_v2', {
      query_embedding: queryVec,
      query_text: query.query,
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT_POOL,
    }),
    retrieveTopicGeoEval(query.query),
  ]);
  if (rpcRes.error) return { error: rpcRes.error.message, found: 0, total: canaries.length, perPaper: [], pre2010: { found: 0, total: 0 }, post2010: { found: 0, total: 0 } };

  // Merge pools — vector pool first (real similarity preserved on duplicates),
  // topic+geo pool second (synthetic 0.45). Mirror of deduplicatePapers order
  // in retrieval.ts. Use canonical_doi (preferred) or normalized title as key.
  const seen = new Set();
  const keyOf = (p) => {
    const doi = normDoiKey(p.canonical_doi);
    if (doi) return `doi:${doi}`;
    const t = normTitleKey(p.title);
    return t ? `t:${t}` : `id:${p.id}`;
  };
  const pool = [];
  for (const p of (rpcRes.data ?? [])) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push(p);
  }
  let topicGeoAdded = 0;
  for (const p of topicGeoRes.papers) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push(p);
    topicGeoAdded++;
  }
  // Prod ranking replay (retrieval.ts rerank section): attach REAL query·paper
  // cosine to every candidate, then rerankUnified → slice(selection pool) →
  // selectTopKDiverse → orderByChannel → cosine relevance floor. Channels default
  // to the PROD UI DEFAULT set (App.tsx searchChannels = causal+foundational+recent),
  // because that is what a normal user search sends — the foundational citation
  // boost is what surfaces seminal papers. Override with EVAL_CHANNELS (comma list,
  // or "none" for the pure-cosine path). Regions=[] (default unfiltered search).
  const _chEnv = process.env.EVAL_CHANNELS;
  const activeChannels = _chEnv === 'none'
    ? []
    : (_chEnv ? _chEnv.split(',').map(s => s.trim()).filter(Boolean) : ['causal', 'foundational', 'recent']);
  const rerankFilters = { regions: [] };
  // realCosine attach — reuse the whole-query embedding already computed for
  // match_works_v2 (prod reuses corpusResult.queryEmbedding the same way).
  const ids = pool.map(p => String(p.id)).filter(Boolean);
  const cosMap = await cosineForIds(queryVec, ids);
  for (const p of pool) {
    const rc = cosMap.get(String(p.id));
    const exact = typeof rc === 'number';
    p.realCosine = exact ? rc : Number(p.similarity ?? 0);
    p._realCosExact = exact; // topCos in the relevance floor uses genuine cosines only
  }
  const composite = rerankUnified(pool, rerankFilters, activeChannels, unifiedProfileName(), null, null);
  const selectionPool = composite.slice(0, DEFAULT_SELECTION_POOL_SIZE);
  const { selected, duplicatesSkipped } = selectTopKDiverse(selectionPool, TOP_K);
  const ordered = orderByChannel(selected, activeChannels);
  const reranked = applyRelevanceFloor(ordered);
  const top = new Set(reranked.map(p => normDoi(p.canonical_doi)));

  // Density metrics on the top-K window (Phase 1.4 acceptance criteria):
  const uniqueDois = new Set(reranked.map(p => normDoi(p.canonical_doi)).filter(Boolean));
  const uniqueVenues = new Set(reranked.map(p => (p.venue ?? '').toLowerCase().trim()).filter(Boolean));
  const uniqueVenueKinds = new Set(reranked.map(p => p.venue_kind ?? null).filter(Boolean));
  const uniqueSourceFamilies = new Set(reranked.map(p => p.source_family ?? null).filter(Boolean));
  const reviewCount = reranked.filter(p => String(p.methodology_design ?? '').toLowerCase() === 'review').length;
  const density = {
    duplicates_skipped: duplicatesSkipped,
    unique_dois: uniqueDois.size,
    unique_venues: uniqueVenues.size,
    unique_venue_kinds: uniqueVenueKinds.size,
    unique_source_families: uniqueSourceFamilies.size,
    review_count: reviewCount,
  };
  const perPaper = canaries.map(c => ({
    id: c.id,
    doi: c.doi_hint,
    year: c.year ?? null,
    found: top.has(normDoi(c.doi_hint)),
  }));
  // Split by year: we don't always care about pre-2010 misses (e.g. constrained
  // queries with a 2010 floor are correct to miss Card 1990). Reporting both
  // lets the human decide which moves matter for which retrieval class.
  const pre2010 = perPaper.filter(p => p.year != null && p.year < 2010);
  const post2010 = perPaper.filter(p => p.year != null && p.year >= 2010);
  return {
    found: perPaper.filter(p => p.found).length,
    total: canaries.length,
    perPaper,
    pre2010: { found: pre2010.filter(p => p.found).length, total: pre2010.length },
    post2010: { found: post2010.filter(p => p.found).length, total: post2010.length },
    density,
    topic_geo: {
      topics: topicGeoRes.topics,
      geographies: topicGeoRes.geographies,
      total_matched: topicGeoRes.totalMatched,
      merged_into_pool: topicGeoAdded,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Classifier-threshold calibration (--calibrate). Embeds facets + labeled-paper
// vectors ONCE (reusing qwenDecompose/embedBatch/cosine — which now match the
// prod qwen embed path), captures RAW per-facet cosines, then grid-sweeps
// (PER_FACET_FLOOR, floor, gm) in memory. The facet-cosine classifier is the
// retrieval fallback + eval mirror; the swept PER_FACET_FLOOR also feeds the RF's
// *_above_floor features (so it informs the RF retrain). Cheap full enumeration —
// no BO needed for 3 thresholds on cached cosines.
function classifyParam(rawSims, pff, floor, gmT, geoHit) {
  const scores = rawSims.map((c) => (c < pff ? 0 : c));
  const gm = geometricMean(scores);
  const allClear = scores.every((s) => s >= floor);
  const anyClear = scores.some((s) => s >= floor);
  if (allClear && gm >= gmT) return geoHit ? 'direct-lac' : 'direct-global';
  if (anyClear) return 'indirect';
  return 'excluded';
}

async function calibrate() {
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = evals.queries.filter((q) => Object.keys(q.labels ?? {}).length > 0);
  const samples = []; // { rawSims:number[], geoHit, humanLabel }
  for (const query of queries) {
    const labeled = Object.values(query.labels ?? {}).filter((e) => e.doi);
    if (!labeled.length) continue;
    const facets = (await qwenDecompose(query.query)).facets ?? [];
    const topicFacets = facets.filter((f) => !/^(geo|geography|region|location|country|countries|place)$/i.test(f.label));
    if (!topicFacets.length) continue;
    const facetTexts = topicFacets.map((f) => `${f.label} ${(f.expansion ?? []).slice(0, 12).join(' ')}`);
    const facetVecs = await embedBatch(facetTexts);
    const dois = labeled.map((l) => normDoi(l.doi));
    const { data: rows } = await SB.from('works').select('canonical_doi, title, abstract, embedding').in('canonical_doi', dois);
    const rowByDoi = new Map((rows ?? []).map((r) => [normDoi(r.canonical_doi), r]));
    for (const lp of labeled) {
      const row = rowByDoi.get(normDoi(lp.doi));
      if (!row) continue;
      const emb = parseEmbedding(row.embedding);
      if (!emb) continue;
      const rawSims = topicFacets.map((_, i) => { const c = cosine(facetVecs[i], emb); return c == null ? 0 : c; });
      samples.push({ rawSims, geoHit: geographyHit(row.title, row.abstract), humanLabel: lp.label });
    }
    process.stdout.write('.');
  }
  console.log(`\n${EMBED_MODEL}: ${samples.length} labeled samples (${queries.length} queries)`);
  // raw max-facet-cosine distribution per gold label — shows where to cut
  const byLabel = {};
  for (const s of samples) (byLabel[s.humanLabel] ??= []).push(Math.max(...s.rawSims));
  for (const [lbl, arr] of Object.entries(byLabel)) {
    arr.sort((a, b) => a - b);
    const pct = (p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] ?? 0;
    console.log(`  ${lbl.padEnd(11)} n=${String(arr.length).padStart(3)}  maxFacetCos p10=${pct(.1).toFixed(3)} p25=${pct(.25).toFixed(3)} p50=${pct(.5).toFixed(3)} p75=${pct(.75).toFixed(3)} p90=${pct(.9).toFixed(3)}`);
  }
  const score = (pff, floor, gmT) => {
    const pairs = samples.map((s) => ({ humanLabel: s.humanLabel, predicted: classifyParam(s.rawSims, pff, floor, gmT, s.geoHit) }));
    const f1 = computeMacroF1(pairs).macroF1;
    const rec = perLabelRecall(pairs);
    return { f1, rel: rec.relevant_recall ?? 0, par: rec.partial_recall ?? 0, irr: rec.irrelevant_recall ?? 0 };
  };
  const cur = score(0.45, 0.50, 0.55); // current prod cosine-classifier thresholds
  console.log(`\nCURRENT prod (pff=0.45 floor=0.50 gm=0.55): macroF1=${cur.f1.toFixed(3)} rel=${cur.rel.toFixed(3)} par=${cur.par.toFixed(3)} irr=${cur.irr.toFixed(3)}`);
  const results = [];
  for (let pff = 0.15; pff <= 0.60001; pff += 0.05)
    for (let floor = 0.15; floor <= 0.60001; floor += 0.05)
      for (let gmT = 0.15; gmT <= 0.65001; gmT += 0.05) {
        const r = score(pff, floor, gmT);
        results.push({ pff, floor, gmT, ...r });
      }
  results.sort((a, b) => b.f1 - a.f1);
  console.log('\nTop 12 (macroF1 | rel/par/irr):');
  for (const r of results.slice(0, 12))
    console.log(`  pff=${r.pff.toFixed(2)} floor=${r.floor.toFixed(2)} gm=${r.gmT.toFixed(2)}  f1=${r.f1.toFixed(3)}  rel=${r.rel.toFixed(2)} par=${r.par.toFixed(2)} irr=${r.irr.toFixed(2)}`);
}

async function main() {
  if (CALIBRATE) { await calibrate(); return; }
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = ONLY
    ? evals.queries.filter(q => [...ONLY].some(id => q.id === id || q.id.startsWith(`${id}-`)))
    : evals.queries;
  if (ONLY && queries.length === 0) {
    console.error(`No queries matched --only ${ONLY_ARG}`);
    process.exit(1);
  }
  const allPairs = [];
  const canaryRollup = { found: 0, total: 0, pre2010_found: 0, pre2010_total: 0, post2010_found: 0, post2010_total: 0 };
  const perQueryCanary = [];
  // Density rollup across queries: summed counts (avg = sum / n_queries).
  const densityRollup = {
    total_duplicates_skipped: 0,
    sum_unique_dois: 0,
    sum_unique_venues: 0,
    sum_unique_venue_kinds: 0,
    sum_unique_source_families: 0,
    sum_review_count: 0,
    n_queries_with_density: 0,
  };

  for (const q of queries) {
    process.stdout.write(`▸ ${q.id.padEnd(50)} `);
    const [qVec] = await embedBatch([q.query]);
    const ch = await canaryHit(q, qVec);
    canaryRollup.found += ch.found;
    canaryRollup.total += ch.total;
    canaryRollup.pre2010_found  += ch.pre2010.found;
    canaryRollup.pre2010_total  += ch.pre2010.total;
    canaryRollup.post2010_found += ch.post2010.found;
    canaryRollup.post2010_total += ch.post2010.total;
    perQueryCanary.push({
      id: q.id,
      retrieval_class: q.retrieval_class ?? null,
      canary_found: ch.found,
      canary_total: ch.total,
      pre2010:  ch.pre2010,
      post2010: ch.post2010,
      density:  ch.density ?? null,
    });
    if (ch.density) {
      densityRollup.total_duplicates_skipped += ch.density.duplicates_skipped;
      densityRollup.sum_unique_dois          += ch.density.unique_dois;
      densityRollup.sum_unique_venues        += ch.density.unique_venues;
      densityRollup.sum_unique_venue_kinds   += ch.density.unique_venue_kinds;
      densityRollup.sum_unique_source_families += ch.density.unique_source_families;
      densityRollup.sum_review_count         += ch.density.review_count;
      densityRollup.n_queries_with_density   += 1;
    }

    let classifier = null;
    if (Object.keys(q.labels ?? {}).length > 0) {
      const pairs = await classifierAgreement(q);
      if (pairs) {
        allPairs.push(...pairs);
        classifier = `labeled=${pairs.length}`;
      }
    }
    console.log(`canary=${ch.found}/${ch.total} (pre=${ch.pre2010.found}/${ch.pre2010.total} post=${ch.post2010.found}/${ch.post2010.total})${classifier ? '  ' + classifier : ''}`);
  }

  const f1 = computeMacroF1(allPairs);
  const recalls = perLabelRecall(allPairs);
  const canary_top20         = canaryRollup.total         ? canaryRollup.found         / canaryRollup.total         : null;
  const canary_top20_pre2010 = canaryRollup.pre2010_total ? canaryRollup.pre2010_found / canaryRollup.pre2010_total : null;
  const canary_top20_post2010= canaryRollup.post2010_total? canaryRollup.post2010_found/ canaryRollup.post2010_total: null;

  const result = {
    runAt: new Date().toISOString(),
    thresholds: THRESHOLDS,
    n_queries: queries.length,
    only: ONLY_ARG ?? null,
    n_labeled_papers: allPairs.length,
    n_labeled_papers_scored: f1.scored,
    metrics: {
      macro_f1:             round3(f1.macroF1),
      relevant_recall:      round3(recalls.relevant_recall),
      partial_recall:       round3(recalls.partial_recall),
      irrelevant_recall:    round3(recalls.irrelevant_recall),
      canary_top20:         round3(canary_top20),
      canary_top20_pre2010: round3(canary_top20_pre2010),
      canary_top20_post2010:round3(canary_top20_post2010),
    },
    per_class_f1: Object.fromEntries(Object.entries(f1.perClass).map(([k, v]) => [k, round3(v)])),
    label_counts: recalls.counts,
    canary: {
      found: canaryRollup.found, total: canaryRollup.total,
      pre2010_found: canaryRollup.pre2010_found, pre2010_total: canaryRollup.pre2010_total,
      post2010_found: canaryRollup.post2010_found, post2010_total: canaryRollup.post2010_total,
    },
    per_query_canary: perQueryCanary,
    density: (() => {
      const n = densityRollup.n_queries_with_density;
      if (!n) return null;
      return {
        total_duplicates_skipped: densityRollup.total_duplicates_skipped,
        avg_duplicates_skipped_per_query: round3(densityRollup.total_duplicates_skipped / n),
        avg_unique_dois:          round3(densityRollup.sum_unique_dois / n),
        avg_unique_venues:        round3(densityRollup.sum_unique_venues / n),
        avg_unique_venue_kinds:   round3(densityRollup.sum_unique_venue_kinds / n),
        avg_unique_source_families: round3(densityRollup.sum_unique_source_families / n),
        avg_review_count:         round3(densityRollup.sum_review_count / n),
        n_queries: n,
      };
    })(),
  };

  const m = result.metrics;
  console.log('');
  console.log(`=== eval-gold (${THRESHOLDS.label})  topic_geo_sim=${TOPIC_GEO_SYNTHETIC_SIM} ===`);
  console.log(`macro_f1=${m.macro_f1}  relevant_recall=${m.relevant_recall}  partial_recall=${m.partial_recall}  irrelevant_recall=${m.irrelevant_recall}`);
  console.log(`canary_top20=${m.canary_top20}  pre2010=${m.canary_top20_pre2010}  post2010=${m.canary_top20_post2010}  (n=${canaryRollup.total}, pre=${canaryRollup.pre2010_total}, post=${canaryRollup.post2010_total})`);
  console.log(`n_queries=${result.n_queries}  n_labeled=${result.n_labeled_papers_scored}`);
  if (result.density) {
    const d = result.density;
    console.log(`density  duplicates_skipped=${d.total_duplicates_skipped} (avg ${d.avg_duplicates_skipped_per_query}/query)  unique_dois=${d.avg_unique_dois}/${TOP_K}  unique_venues=${d.avg_unique_venues}  venue_kinds=${d.avg_unique_venue_kinds}  source_families=${d.avg_unique_source_families}  reviews=${d.avg_review_count}`);
  }

  if (existsSync(BASELINE_PATH)) {
    const prev = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const pm = prev.metrics ?? {};
    console.log('');
    console.log('delta vs baseline:');
    for (const k of Object.keys(m)) {
      if (typeof m[k] !== 'number' || typeof pm[k] !== 'number') continue;
      const d = m[k] - pm[k];
      const sign = d > 0 ? '+' : '';
      console.log(`  ${k.padEnd(22)} ${pm[k]} → ${m[k]}  (${sign}${round3(d)})`);
    }
  } else {
    console.log('');
    console.log(`(no previous baseline at ${BASELINE_PATH}; this run will become the baseline)`);
  }

  if (!NO_WRITE) {
    writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2));
    console.log('');
    console.log(`wrote ${BASELINE_PATH}`);
  }
}

function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });
