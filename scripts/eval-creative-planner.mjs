/**
 * eval-creative-planner.mjs
 *
 * OFFLINE A/B rig: does a *grounded* creative LLM query-planner surface
 * relevant papers that current vector+FTS retrieval misses — and at what
 * hallucination cost?
 *
 * "Claude proposes, the database disposes." The planner is allowed to be
 * creative (and even hallucinate); NOTHING it emits is treated as evidence.
 * Every proposal is resolved against the real corpus via match_works_v2 and
 * verified against the matched row's stored authors/title. A fabricated paper
 * has no row → it evaporates. The only papers that survive are real corpus rows
 * carrying their own ids/dois — exactly the production golden-rule discipline,
 * one layer earlier.
 *
 * Per gold query it reports:
 *   • BASELINE   — current retrieval (match_works_v2 on the raw query), top-K
 *   • TREATMENT  — baseline ∪ grounded-planner results
 *   • NEW        — papers TREATMENT surfaces that BASELINE missed, each scored
 *                  by TRUE cosine(query, paper) so you see if they're on-topic
 *   • RECALL lift on the query's labeled gold DOIs (relevant + partial)
 *   • RESOLUTION RATE — the hallucination-safety number: of the planner's
 *                  named-work proposals, how many resolved+verified to a real
 *                  corpus row vs. evaporated.
 *
 * It writes NOTHING to the corpus and runs read-only (match_works_v2 + selects).
 *
 * Usage:
 *   node scripts/eval-creative-planner.mjs                       # all queries, gemini planner
 *   node scripts/eval-creative-planner.mjs --only q01,q05        # subset
 *   node scripts/eval-creative-planner.mjs --planner claude      # needs ANTHROPIC_API_KEY
 *   node scripts/eval-creative-planner.mjs --planner qwen        # in-stack LiteLLM
 *   node scripts/eval-creative-planner.mjs --limit 5 --topk 50
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL,
 *   LLM_API_KEY, OLLAMA_EMBEDDING_MODEL. Planner: GEMINI_API_KEY (gemini),
 *   ANTHROPIC_API_KEY (claude), or LLM_API_KEY (qwen).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv();
if (process.env.EVAL_ENV_FILE) loadEnv({ path: process.env.EVAL_ENV_FILE, override: false });

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');
const REPORTS_DIR  = join(__dir, '../reports');

// ---- args ----
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PLANNER = flag('--planner', 'gemini');         // gemini | claude | qwen
const ONLY    = flag('--only', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const LIMIT   = Number(flag('--limit', '0')) || 0;    // 0 = all
const POOL    = Number(flag('--pool', '50'));         // match_works_v2 match_count per search
const TOP_K   = Number(flag('--topk', '50'));         // baseline window we compare against
const SUB_K   = Number(flag('--subk', '12'));         // rows kept per sub-query / named-work / literature
const REL_COS = Number(flag('--rel', '0.50'));        // cosine(query,paper) on-topic threshold
const GATE_SWEEP = args.includes('--gate-sweep');     // compare absolute vs base-anchored relative gates
const MATCH_THRESHOLD = 0.40;

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const QWEN_MODEL  = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }
if (PLANNER === 'gemini' && !GEMINI_KEY) { console.error('GEMINI_API_KEY not set for --planner gemini'); process.exit(1); }
if (PLANNER === 'claude' && !ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY not set for --planner claude'); process.exit(1); }

// ---------------------------------------------------------------------------
// Helpers (mirror eval-gold.mjs conventions)
// ---------------------------------------------------------------------------
// qwen3-embedding is Matryoshka: MUST request dimensions=768 or it returns its
// native 4096-dim vector, which mismatches the vector(768) corpus column (the RPC
// errors "different vector dimensions 4096 and 768" and returns nothing). qwen also
// uses NO task prefix (validated best post-cutover); the search_query/document prefix
// logic is nomic-only. Mirror production (reembed-qwen768 + ollamaClient).
const IS_QWEN = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL);
async function embedBatch(texts, prefix = 'search_query: ') {
  const usePrefix = IS_QWEN ? '' : prefix;
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const slice = texts.slice(i, i + 64);
    const body = { model: EMBED_MODEL, input: slice.map(t => usePrefix + t) };
    if (IS_QWEN) body.dimensions = 768;
    const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.data) throw new Error('embed fail: ' + JSON.stringify(j).slice(0, 150));
    out.push(...j.data.map(d => d.embedding));
  }
  return out;
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
}
function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }
function surname(name) {
  const parts = String(name ?? '').trim().split(/\s+/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}
function tokens(s) { return new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)); }
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
// Is an enriched corpus row a credible match for the planner's named work?
// STRONG (= "in corpus") if title overlaps strongly, or author matches + decent
// title overlap, or author + year(±1) + weak title overlap. Returns the match
// evidence or null.
function verifyAgainst(candidates, w) {
  const want = surname(w.author);
  for (const e of candidates) {
    if (!e?.title) continue;
    const authorHit = !!want && Array.isArray(e.authors) && e.authors.some(a => surname(a) === want || String(a).toLowerCase().includes(want));
    const tj = Math.max(w.title ? jaccard(w.title, e.title) : 0, jaccard(w.description, e.title));
    const yearHit = !!w.year && !!e.year && Math.abs(Number(w.year) - Number(e.year)) <= 1;
    const strong = tj >= 0.55 || (authorHit && tj >= 0.30) || (authorHit && yearHit && tj >= 0.20);
    if (strong) return { e, authorHit, tj: +tj.toFixed(2), yearHit, by: tj >= 0.55 ? 'title' : authorHit && tj >= 0.30 ? 'author+title' : 'author+year' };
  }
  return null;
}
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ---------------------------------------------------------------------------
// The creative planner — pluggable model. Returns search INTENT only.
// ---------------------------------------------------------------------------
const PLANNER_SYSTEM = `You are a senior development economist planning a literature search for a policy question. You know this field's canonical papers, competing theories, key authors, and adjacent literatures by name.

Your job is NOT to answer the question and NOT to list facts. It is to plan the most CREATIVE yet ON-TOPIC search of a corpus of economics papers. Think about: the core mechanism; competing theories/schools; seminal foundational works; the specific named studies a specialist would expect; adjacent literatures that inform the question; and methodological angles (RCTs, quasi-experiments, structural).

Output STRICT JSON, no prose:
{
  "subQueries": ["3-7 distinct sub-literature search phrases, each a rich academic description (NOT keywords)"],
  "namedWorks": [
    {"title": "the paper's title if you know it (else empty string)", "description": "a 1-2 sentence abstract-style description of a SPECIFIC paper you believe exists in this literature", "author": "Primary author full name or surname", "year": 2010}
  ],
  "literatures": ["2-5 named sub-fields to pull the most-cited papers from"]
}

namedWorks: list 4-10 specific studies you'd expect (e.g. Jensen 2010 on perceived returns to schooling). It is FINE to be wrong — every one is verified against the real corpus; fabrications are simply dropped. Be specific and ambitious.`;

async function planGemini(query) {
  const prompt = `${PLANNER_SYSTEM}\n\nPOLICY QUESTION: ${query}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  return parseJsonLoose(text);
}
async function planClaude(query) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4096, temperature: 0.7,
      system: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: `POLICY QUESTION: ${query}\n\nReturn the JSON only.` }],
    }),
  });
  const j = await r.json();
  const text = (j?.content ?? []).map(b => b.text ?? '').join('');
  return parseJsonLoose(text);
}
async function planQwen(query) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL, temperature: 0.7, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: PLANNER_SYSTEM }, { role: 'user', content: `POLICY QUESTION: ${query}` }],
    }),
  });
  const j = await r.json();
  return parseJsonLoose(j.choices?.[0]?.message?.content ?? '');
}
async function plan(query) {
  try {
    const p = PLANNER === 'claude' ? await planClaude(query) : PLANNER === 'qwen' ? await planQwen(query) : await planGemini(query);
    return {
      subQueries: Array.isArray(p?.subQueries) ? p.subQueries.slice(0, 8) : [],
      namedWorks: Array.isArray(p?.namedWorks) ? p.namedWorks.slice(0, 12) : [],
      literatures: Array.isArray(p?.literatures) ? p.literatures.slice(0, 6) : [],
    };
  } catch (e) { console.log(`  [plan] failed: ${e?.message}`); return { subQueries: [], namedWorks: [], literatures: [] }; }
}

// ---------------------------------------------------------------------------
// Retrieval primitive
// ---------------------------------------------------------------------------
async function search(vec, text, count) {
  const { data, error } = await SB.rpc('match_works_v2', {
    query_embedding: vec, query_text: text, match_threshold: MATCH_THRESHOLD, match_count: count,
  });
  if (error) { console.log(`  [rpc] ${error.message}`); return []; }
  return data ?? [];
}
// Enrich a set of ids with stored authors/title/embedding for verification + true-cosine relevance.
async function enrich(ids) {
  const out = new Map();
  const arr = [...ids];
  for (let i = 0; i < arr.length; i += 200) {
    const slice = arr.slice(i, i + 200);
    const { data } = await SB.from('works')
      .select('id, canonical_doi, title, authors, year, citation_count, embedding')
      .in('id', slice);
    for (const r of (data ?? [])) out.set(r.id, r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-query run
// ---------------------------------------------------------------------------
async function runQuery(q) {
  const query = q.query;
  const queryVec = (await embedBatch([query]))[0];

  // BASELINE: current retrieval on the raw query.
  const baseRows = await search(queryVec, query, POOL);
  const baseTop = baseRows.slice(0, TOP_K);
  const baseIds = new Set(baseTop.map(r => r.id));
  const baseDois = new Set(baseTop.map(r => normDoi(r.canonical_doi)).filter(Boolean));

  // PLAN (creative, ungrounded).
  const p = await plan(query);

  // GROUND every proposal against the corpus.
  const grounded = new Map();          // id -> { row, via:Set }
  const addRow = (r, via) => {
    if (!r?.id) return;
    if (!grounded.has(r.id)) grounded.set(r.id, { row: r, via: new Set() });
    grounded.get(r.id).via.add(via);
  };

  // sub-queries + literatures → vector/FTS search (literatures also citation-pulled later)
  const subTexts = [...p.subQueries, ...p.literatures];
  if (subTexts.length) {
    const subVecs = await embedBatch(subTexts);
    for (let i = 0; i < subTexts.length; i++) {
      const rows = await search(subVecs[i], subTexts[i], SUB_K);
      const tag = i < p.subQueries.length ? `subq` : `lit`;
      for (const r of rows) addRow(r, tag);
    }
  }

  // named-works → multi-probe corpus resolution. Only declare "really not in
  // corpus" after (1) a title-FTS probe, (2) a description-vector probe, and
  // (3) cross-check against papers already surfaced by sub-queries ALL fail.
  const named = [];
  if (p.namedWorks.length) {
    // Pre-embed every probe vector in two batches.
    const descs  = p.namedWorks.map(w => `${w.description ?? ''} ${w.author ?? ''}`.trim() || (w.title ?? query));
    const titles = p.namedWorks.map(w => (w.title ?? '').trim());
    const descVecs  = await embedBatch(descs);
    const titleIdx  = titles.map((t, i) => t ? i : -1).filter(i => i >= 0);
    const titleVecs = titleIdx.length ? await embedBatch(titleIdx.map(i => titles[i])) : [];
    const titleVecOf = new Map(titleIdx.map((origIdx, k) => [origIdx, titleVecs[k]]));

    // Candidate rows already surfaced by sub-queries (for cross-check probe 3).
    const groundedRows = [...grounded.values()].map(g => g.row);

    for (let i = 0; i < p.namedWorks.length; i++) {
      const w = p.namedWorks[i];
      const candIds = new Set();
      const rowById = new Map();
      const collect = (rows) => { for (const r of rows) { candIds.add(r.id); rowById.set(r.id, r); } };
      // Probe 1 — title FTS (strongest), if a title was given.
      if (titleVecOf.has(i)) collect(await search(titleVecOf.get(i), titles[i], 10));
      // Probe 2 — description vector.
      collect(await search(descVecs[i], w.description ?? w.title ?? w.author ?? query, 15));
      // Probe 3 — cross-check rows already retrieved by sub-queries (cheap title prefilter).
      for (const r of groundedRows) {
        if (r.title && (jaccard(w.title ?? w.description, r.title) >= 0.30)) { candIds.add(r.id); rowById.set(r.id, r); }
      }
      const enr = await enrich(candIds);
      const candidates = [...candIds].map(id => enr.get(id)).filter(Boolean);
      const v = verifyAgainst(candidates, w);
      named.push({ proposal: w, verified: !!v, by: v?.by ?? null, tj: v?.tj ?? null,
        matchedId: v?.e?.id ?? null, matchedTitle: v?.e?.title ?? null });
      if (v) { const row = rowById.get(v.e.id) ?? { id: v.e.id, canonical_doi: v.e.canonical_doi, title: v.e.title }; addRow(row, 'named'); }
    }
  }

  // TREATMENT = baseline ∪ grounded. Score everything by TRUE cosine(query, paper).
  const allIds = new Set([...baseIds, ...grounded.keys()]);
  const enrAll = await enrich(allIds);
  const scoreOf = (id) => { const e = enrAll.get(id); const emb = parseEmbedding(e?.embedding); return emb ? cosine(queryVec, emb) : null; };

  // NEW papers (grounded, not in baseline), ranked by true relevance.
  const newPapers = [...grounded.values()]
    .filter(g => !baseIds.has(g.row.id))
    .map(g => { const e = enrAll.get(g.row.id); return {
      id: g.row.id, doi: normDoi(g.row.canonical_doi ?? e?.canonical_doi), title: e?.title ?? g.row.title,
      cite: e?.citation_count ?? null, cos: scoreOf(g.row.id), via: [...g.via].join('+'),
    }; })
    .filter(x => x.cos != null)
    .sort((a, b) => (b.cos ?? 0) - (a.cos ?? 0));
  const newOnTopic = newPapers.filter(x => x.cos >= REL_COS);

  // RECALL on labeled gold DOIs (relevant + partial). Meaningful on fully-labeled queries.
  const goldDois = new Set();
  for (const v of Object.values(q.labels ?? {})) {
    if (!v?.doi) continue;
    if (v.label === 'relevant' || v.label === 'partial') goldDois.add(normDoi(v.doi));
  }
  const treatDois = new Set([...baseDois, ...newPapers.map(x => x.doi).filter(Boolean)]);
  // GATED treatment = baseline ∪ planner adds that clear the PRODUCTION relevance
  // gate (true query cosine ≥ REL_COS). This is what retrieveWorks/expand-evidence
  // actually keep after rescoreByTrueQueryCosine — so recallTreatGated is the recall
  // production realizes, vs recallTreat which counts ALL grounded adds (ungated).
  const treatDoisGated = new Set([...baseDois, ...newPapers.filter(x => x.cos >= REL_COS).map(x => x.doi).filter(Boolean)]);
  const goldArr = [...goldDois];
  const recallBase = goldArr.filter(d => baseDois.has(d)).length;
  const recallTreat = goldArr.filter(d => treatDois.has(d)).length;
  const recallTreatGated = goldArr.filter(d => treatDoisGated.has(d)).length;

  const namedVerified = named.filter(n => n.verified).length;

  // GATE-SWEEP data: per-query inputs to compare gate strategies offline without
  // re-running the planner. baseCos = the query's base-table true-cosine
  // distribution (the per-query relative anchor); adds = every grounded NEW paper
  // with its true query cosine + whether its doi is a labeled gold.
  const sweep = GATE_SWEEP ? {
    baseDois: [...baseDois],
    baseCos: baseTop.map(r => scoreOf(r.id)).filter(c => c != null),
    goldDois: goldArr,
    recallBase,
    adds: newPapers.map(x => ({ doi: x.doi, cos: x.cos, gold: !!x.doi && goldDois.has(x.doi) })),
  } : undefined;

  return {
    id: q.id, query, sweep,
    baseline: baseTop.length,
    plan: { subQueries: p.subQueries.length, namedWorks: p.namedWorks.length, literatures: p.literatures.length },
    resolution: { namedProposed: named.length, namedVerified, rate: named.length ? namedVerified / named.length : null },
    newSurfaced: newPapers.length,
    newOnTopic: newOnTopic.length,
    topNew: newOnTopic.slice(0, 10).map(x => ({ cos: +x.cos.toFixed(3), cite: x.cite, via: x.via, title: (x.title ?? '').slice(0, 80), doi: x.doi })),
    recall: { gold: goldArr.length, baseline: recallBase, treatment: recallTreat, treatmentGated: recallTreatGated },
    named,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const all = JSON.parse(readFileSync(QUERIES_PATH, 'utf8')).queries;
  let queries = ONLY ? all.filter(q => ONLY.some(o => q.id === o || q.id.startsWith(o + '-') || q.id.startsWith(o))) : all;
  if (LIMIT) queries = queries.slice(0, LIMIT);
  const modelName = PLANNER === 'claude' ? ANTHROPIC_MODEL : PLANNER === 'qwen' ? QWEN_MODEL : GEMINI_MODEL;
  console.log(`creative-planner eval — planner=${PLANNER} (${modelName}) embed=${EMBED_MODEL} queries=${queries.length} topK=${TOP_K} relCos=${REL_COS}\n`);

  const results = [];
  for (const q of queries) {
    process.stdout.write(`▶ ${q.id} … `);
    try {
      const r = await runQuery(q);
      results.push(r);
      const res = r.resolution;
      console.log(
        `new=${r.newSurfaced} on-topic=${r.newOnTopic} | named ${res.namedVerified}/${res.namedProposed} verified` +
        (res.rate != null ? ` (${(res.rate * 100).toFixed(0)}%)` : '') +
        (r.recall.gold ? ` | recall ${r.recall.baseline}→${r.recall.treatment}/${r.recall.gold}` : ''),
      );
    } catch (e) { console.log(`ERROR ${e?.message}`); results.push({ id: q.id, error: e?.message }); }
  }

  // Aggregate
  const ok = results.filter(r => !r.error);
  const sum = (f) => ok.reduce((s, r) => s + (f(r) || 0), 0);
  const namedProposed = sum(r => r.resolution?.namedProposed);
  const namedVerified = sum(r => r.resolution?.namedVerified);
  const goldTotal = sum(r => r.recall?.gold);
  const recallBase = sum(r => r.recall?.baseline);
  const recallTreat = sum(r => r.recall?.treatment);
  const recallTreatGated = sum(r => r.recall?.treatmentGated);

  console.log('\n=== AGGREGATE ===');
  console.log(`queries ok            : ${ok.length}/${results.length}`);
  console.log(`new papers surfaced   : ${sum(r => r.newSurfaced)} (${sum(r => r.newOnTopic)} on-topic ≥${REL_COS} cosine)`);
  console.log(`named-work resolution : ${namedVerified}/${namedProposed} verified to real rows` + (namedProposed ? ` (${(100 * namedVerified / namedProposed).toFixed(1)}% — hallucination-safety)` : ''));
  console.log(`gold recall (ungated) : baseline ${recallBase}/${goldTotal} → treatment ${recallTreat}/${goldTotal}  (+${recallTreat - recallBase})`);
  console.log(`gold recall (GATED ≥${REL_COS}) : baseline ${recallBase}/${goldTotal} → treatment ${recallTreatGated}/${goldTotal}  (+${recallTreatGated - recallBase})  ← production realizes this`);

  // ---- GATE SWEEP: absolute floors vs base-anchored relative gates ----
  let sweepMd = null;
  if (GATE_SWEEP) {
    const percentile = (arr, p) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
      return s[idx];
    };
    // gate(addCos, baseCosArray) -> boolean. Relative gates floor a per-query
    // percentile of the base-table cosine distribution by an absolute safety net.
    const STRATEGIES = [
      { name: 'abs_0.50 (current)', gate: (c) => c >= 0.50 },
      { name: 'abs_0.45',          gate: (c) => c >= 0.45 },
      { name: 'abs_0.40',          gate: (c) => c >= 0.40 },
      { name: 'abs_0.35',          gate: (c) => c >= 0.35 },
      { name: 'rel_p25_floor0.40', gate: (c, B) => c >= Math.max(0.40, percentile(B, 25)) },
      { name: 'rel_p20_floor0.40', gate: (c, B) => c >= Math.max(0.40, percentile(B, 20)) },
      { name: 'rel_p20_floor0.35', gate: (c, B) => c >= Math.max(0.35, percentile(B, 20)) },
      { name: 'rel_p10_floor0.35', gate: (c, B) => c >= Math.max(0.35, percentile(B, 10)) },
    ];
    const withSweep = ok.filter(r => r.sweep);
    const goldT = withSweep.reduce((s, r) => s + (r.sweep.goldDois?.length || 0), 0);

    const rows = STRATEGIES.map(st => {
      let recall = 0, admitted = 0, lowCos = 0;
      for (const r of withSweep) {
        const sw = r.sweep;
        const passDois = new Set(sw.baseDois);
        for (const a of sw.adds) {
          if (a.cos == null) continue;
          if (st.gate(a.cos, sw.baseCos)) {
            admitted++;
            if (a.cos < 0.50) lowCos++;     // adds a flat 0.50 would have rejected
            if (a.doi) passDois.add(a.doi);
          }
        }
        recall += sw.goldDois.filter(d => passDois.has(d)).length;
      }
      return { name: st.name, recall, lift: recall - recallBase, admitted, lowCos };
    });

    console.log('\n=== GATE SWEEP (base recall ' + recallBase + '/' + goldT + ') ===');
    console.log('strategy             | gold recall | +lift | admitted | sub-0.50 admitted');
    console.log('---------------------|-------------|-------|----------|------------------');
    for (const r of rows) {
      console.log(
        `${r.name.padEnd(20)} | ${String(r.recall + '/' + goldT).padStart(11)} | ${String('+' + r.lift).padStart(5)} | ${String(r.admitted).padStart(8)} | ${String(r.lowCos).padStart(17)}`,
      );
    }

    // Pinpoint the gold paper(s) that sit BELOW the current 0.50 absolute gate —
    // the case-1/case-2 precondition: are they within their query's base-cosine
    // tail (relative gate can recover) or true outliers below it (nothing helps)?
    const belowFloor = [];
    for (const r of withSweep) {
      const sw = r.sweep;
      const baseSet = new Set(sw.baseDois);
      for (const a of sw.adds) {
        if (a.gold && a.cos < 0.50 && !baseSet.has(a.doi)) {
          belowFloor.push({ id: r.id, doi: a.doi, cos: +a.cos.toFixed(3), p20: +percentile(sw.baseCos, 20).toFixed(3), p10: +percentile(sw.baseCos, 10).toFixed(3), baseMin: +Math.min(...sw.baseCos).toFixed(3) });
        }
      }
    }
    if (belowFloor.length) {
      console.log('\n--- gold adds below the 0.50 floor (the deferred-recovery target) ---');
      for (const b of belowFloor) {
        const verdict = b.cos >= b.p20 ? 'RECOVERABLE (≥ base P20)' : b.cos >= b.p10 ? 'recoverable @ P10' : b.cos >= b.baseMin ? 'in base tail (loose rel)' : 'OUTLIER (< base min)';
        console.log(`  ${b.id}: cos=${b.cos} | base P20=${b.p20} P10=${b.p10} min=${b.baseMin} → ${verdict} | ${b.doi}`);
      }
    } else {
      console.log('\n--- no gold add sits below 0.50 in this run (planner nondeterminism — re-run or use cache) ---');
    }

    sweepMd = { recallBase, goldTotal: goldT, strategies: rows, belowFloor };
  }

  // Write report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = join(REPORTS_DIR, `creative-planner-${PLANNER}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify({ planner: PLANNER, model: modelName, embedModel: EMBED_MODEL, topK: TOP_K, relCos: REL_COS, aggregate: { newSurfaced: sum(r => r.newSurfaced), newOnTopic: sum(r => r.newOnTopic), namedProposed, namedVerified, goldTotal, recallBase, recallTreat, recallTreatGated }, gateSweep: sweepMd, results }, null, 2));

  const md = [];
  md.push(`# Creative-planner retrieval eval — \`${PLANNER}\` (${modelName})`);
  md.push(`\nEmbed: \`${EMBED_MODEL}\` · queries: ${ok.length} · topK: ${TOP_K} · on-topic cosine ≥ ${REL_COS}\n`);
  md.push(`**Named-work resolution (hallucination-safety):** ${namedVerified}/${namedProposed} proposals verified to real corpus rows` + (namedProposed ? ` (${(100 * namedVerified / namedProposed).toFixed(1)}%)` : '') + `. The rest evaporated — no fabricated paper entered the candidate set.`);
  md.push(`**New on-topic papers surfaced beyond current retrieval:** ${sum(r => r.newOnTopic)} across ${ok.length} queries.`);
  md.push(`**Gold recall (labeled queries):** baseline ${recallBase}/${goldTotal} → treatment ${recallTreat}/${goldTotal} (+${recallTreat - recallBase}).\n`);
  for (const r of ok) {
    md.push(`\n## ${r.id}\n\`${r.query}\``);
    md.push(`\nplan: ${r.plan.subQueries} sub-queries · ${r.plan.namedWorks} named works · ${r.plan.literatures} literatures · named verified ${r.resolution.namedVerified}/${r.resolution.namedProposed}` + (r.recall.gold ? ` · recall ${r.recall.baseline}→${r.recall.treatment}/${r.recall.gold}` : ''));
    if (r.topNew?.length) {
      md.push(`\n**New on-topic papers (not in current top-${TOP_K}), by true query cosine:**\n`);
      md.push('| cos | cites | via | title |');
      md.push('|----:|------:|-----|-------|');
      for (const x of r.topNew) md.push(`| ${x.cos} | ${x.cite ?? '—'} | ${x.via} | ${x.title} |`);
    }
    const evap = r.named.filter(n => !n.verified);
    if (evap.length) md.push(`\n_evaporated (no matching row): ${evap.map(n => `${n.proposal.author ?? '?'} ${n.proposal.year ?? ''}`.trim()).join('; ')}_`);
  }
  writeFileSync(`${base}.md`, md.join('\n'));
  console.log(`\nreport: ${base}.md`);
})();
