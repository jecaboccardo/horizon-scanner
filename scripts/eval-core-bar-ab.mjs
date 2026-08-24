#!/usr/bin/env node
/**
 * A/B the CORE bar (Strict vs Loose) for the topicality segmenter. Single-variable:
 * extractor + OFF rule frozen; only the Core/Context boundary instruction changes.
 * Decision lives in the DELTA (papers that flip Context->Core under Loose); a Gemini
 * referee adjudicates ONLY the delta ("is this DIRECT evidence? yes/no"). READ-ONLY.
 *   node --env-file=.env scripts/eval-core-bar-ab.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = (process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b-app';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const QUERIES = [
  { runId: 'f10f24d1-48ec-4742-a312-c1f47a79c02a', query: 'What works to reduce maternal mortality in Latin America?' },
  { runId: 'f64bc122-ca27-4892-836e-c2e546b717c2', query: 'returns to schooling information' },
  { runId: '9d51c27f-041a-4a16-b7df-d8da46bae073', query: 'does informality reduce firm and aggregate productivity or do low-productivity firms select into informality' },
  { runId: '0a0a2f32-1bc5-4c1e-8172-e08d6745ef06', query: 'through what mechanisms do cash transfers reduce poverty' },
];

async function chat(sys, user) {
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
  if (!r.ok) return '';
  return (await r.json()).choices?.[0]?.message?.content || '';
}
async function embed(text) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: EMBED_MODEL, input: [text], dimensions: 768 }) });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).data[0].embedding;
}
async function cosForIds(vec, ids) { const out = new Map(); for (let i = 0; i < ids.length; i += 200) { const { data } = await SB.rpc('cosine_for_ids', { p_query: vec, p_ids: ids.slice(i, i + 200) }); for (const r of data || []) out.set(String(r.id), Number(r.cosine)); } return out; }
const parseJson = t => { const m = (t || '').match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };

const EXTRACT_SYS = `Extract the KEY CONCEPTS of a research query as a short list.
Include: (1) the primary OUTCOME, (2) the INTERVENTION or MECHANISM, (3) any other defining concept (e.g. "information provision", "informality", "selection").
🔴 Do NOT drop the intervention/mechanism. STRIP OUT only geography/country/region, time period, and population qualifiers.
Output 2-4 short concepts separated by " | ", no preamble.`;

// shared frame; only CORE_DEF changes between arms
const judgeSys = CORE_DEF => `You assign a paper to CORE, CONTEXT, or OFF for a topic given as KEY CONCEPTS.
- ${CORE_DEF}
- CONTEXT: relates to AT LEAST ONE key concept, or an adjacent outcome/mechanism. Useful background.
- OFF: unrelated to EVERY key concept.
🔴 (1) GEOGRAPHY AND TIME PERIOD ARE IRRELEVANT — never a reason to downgrade. (2) Be GENEROUS: partial concept coverage is CONTEXT, never OFF; only OFF if unrelated to ALL concepts.
Return ONLY JSON: {"label":"CORE|CONTEXT|OFF","reason":"<=12 words"}`;
const STRICT = judgeSys('CORE: the paper directly studies the topic\'s MAIN RELATIONSHIP — its OUTCOME together with the INTERVENTION/MECHANISM concept.');
const LOOSE = judgeSys('CORE: the paper directly studies the topic\'s primary OUTCOME (the intervention/mechanism may be implicit or any). (A paper that only touches a mechanism/input WITHOUT studying the outcome is CONTEXT.)');

async function judge(sys, core, title, abstract) {
  const j = parseJson(await chat(sys, `Key concepts: ${core}\n\nPaper title: ${title}\nAbstract: ${(abstract || '(no abstract)').slice(0, 1100)}\n\nClassify (geography & time irrelevant; partial match = CONTEXT not OFF).`));
  const l = (j?.label || '').toUpperCase().trim();
  return ['CORE', 'CONTEXT', 'OFF'].includes(l) ? l : 'ERR';
}

async function referee(core, title, abstract) {
  const prompt = `Topic key concepts (geography & time period are IRRELEVANT): ${core}\n\nPaper title: ${title}\nAbstract: ${(abstract || '(no abstract)').slice(0, 1100)}\n\nIs this paper DIRECT evidence whose PRIMARY subject is this topic's outcome studied together with its intervention/mechanism — as opposed to merely adjacent/contextual? Return ONLY JSON {"direct":"yes"|"no","reason":"<=12 words"}.`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } } }) });
  if (!r.ok) return { direct: 'ERR', reason: `http ${r.status}` };
  const j = parseJson(r ? (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text : '');
  return { direct: (j?.direct || 'ERR').toLowerCase(), reason: j?.reason || '' };
}

const mean = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null;
const report = [];
for (const { runId, query } of QUERIES) {
  const { data: run } = await SB.from('search_runs').select('evidence_work_ids').eq('id', runId).single();
  const ids = run?.evidence_work_ids || [];
  const { data: works } = await SB.from('works').select('id,title,abstract').in('id', ids);
  const byId = {}; (works || []).forEach(w => byId[w.id] = w);
  const core = (await chat(EXTRACT_SYS, `Query: ${query}`)).trim().replace(/^["']|["']$/g, '');
  const qv = await embed(query); const cmap = await cosForIds(qv, ids);

  const rows = [];
  for (const id of ids) {
    const w = byId[id]; if (!w) continue;
    const s = await judge(STRICT, core, w.title, w.abstract); await sleep(400);
    const l = await judge(LOOSE, core, w.title, w.abstract); await sleep(400);
    rows.push({ cos: cmap.get(String(id)) ?? 0, s, l, title: w.title, abstract: w.abstract });
  }
  const coreS = rows.filter(r => r.s === 'CORE');
  const coreL = rows.filter(r => r.l === 'CORE');
  const delta = rows.filter(r => r.s !== 'CORE' && r.l === 'CORE');
  // referee adjudicates only the delta
  let yes = 0, no = 0;
  for (const d of delta) { const ref = await referee(core, d.title, d.abstract); d.ref = ref.direct; d.refReason = ref.reason; if (ref.direct === 'yes') yes++; else if (ref.direct === 'no') no++; await sleep(300); }

  console.log(`\n══════ "${query.slice(0, 60)}"`);
  console.log(`core: "${core}"`);
  console.log(`  |Core_strict|=${coreS.length}  |Core_loose|=${coreL.length}  flips(Context->Core)=${delta.length}`);
  console.log(`  Core mean-cos: strict=${mean(coreS.map(r => r.cos))}  loose=${mean(coreL.map(r => r.cos))}`);
  console.log(`  REFEREE on flips: direct=${yes}  adjacent=${no}  (loosening precision=${delta.length ? (100 * yes / delta.length).toFixed(0) + '%' : 'n/a'})`);
  delta.forEach(d => console.log(`     [${d.ref === 'yes' ? 'DIRECT ' : d.ref === 'no' ? 'adjacent' : '   ?   '}] cos${d.cos.toFixed(2)} ${d.title.slice(0, 52)}  (ref: ${d.refReason})`));
  report.push({ query, core, coreStrict: coreS.length, coreLoose: coreL.length, flips: delta.length, refDirect: yes, refAdjacent: no, coreMeanCosS: mean(coreS.map(r => r.cos)), coreMeanCosL: mean(coreL.map(r => r.cos)), delta: delta.map(d => ({ cos: +d.cos.toFixed(3), title: d.title, ref: d.ref, reason: d.refReason })) });
}
// verdict
const tot = report.reduce((a, r) => ({ flips: a.flips + r.flips, yes: a.yes + r.refDirect, no: a.no + r.refAdjacent }), { flips: 0, yes: 0, no: 0 });
console.log(`\n===== AGGREGATE =====`);
console.log(`total flips (Context->Core under Loose): ${tot.flips} | referee DIRECT: ${tot.yes} | adjacent: ${tot.no}`);
console.log(`loosening precision = ${tot.flips ? (100 * tot.yes / tot.flips).toFixed(0) + '%' : 'n/a'}  -> ${tot.flips && tot.yes / tot.flips >= 0.7 ? 'ADOPT LOOSE (recovers real evidence)' : tot.flips && tot.yes / tot.flips <= 0.4 ? 'KEEP STRICT (loose pollutes Core)' : 'MIXED — middle bar / per-query'}`);
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/core-bar-ab-eval.json', JSON.stringify(report, null, 2));
console.log('-> reports/core-bar-ab-eval.json');
