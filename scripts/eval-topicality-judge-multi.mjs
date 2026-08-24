#!/usr/bin/env node
/**
 * Generality eval for the topicality judge over multiple queries (judge-only, no gold).
 * Auto-extracts a de-regionalized CORE topic (how prod would), then classifies each
 * evidence paper Direct/Related/Off. Reports the distribution + the OFF (drop) list
 * per query so false-drops of core evidence + region/time confusion can be inspected.
 * READ-ONLY. node --env-file=.env scripts/eval-topicality-judge-multi.mjs
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
async function cosForIds(vec, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await SB.rpc('cosine_for_ids', { p_query: vec, p_ids: ids.slice(i, i + 200) });
    for (const r of data || []) out.set(String(r.id), Number(r.cosine));
  }
  return out;
}

// Extract the KEY CONCEPTS without over-compressing — list the outcome, the
// intervention/mechanism, AND any other defining concept (e.g. "information provision").
// Strip ONLY geography/time/population. Losing a concept here is what caused the
// false-drops in the prior eval ("returns to schooling INFORMATION" -> "returns to education").
const EXTRACT_SYS = `Extract the KEY CONCEPTS of a research query as a short bullet list.
Include: (1) the primary OUTCOME, (2) the INTERVENTION or MECHANISM, (3) any other defining concept (e.g. "information provision", "informality", "selection").
🔴 Do NOT drop the intervention/mechanism — it is as important as the outcome.
STRIP OUT only geography/country/region, time period, and population qualifiers.
Output 2-4 short concepts separated by " | ", no preamble.`;

// Segment into CORE vs CONTEXT (recall-safe: nothing is dropped). OFF is only the truly
// unrelated tail (shown but flagged). GENEROUS bar — partial concept coverage = CONTEXT,
// never OFF — to avoid the over-dropping seen with narrow/conjunctive cores.
const JUDGE_SYS = `You assign a paper to CORE, CONTEXT, or OFF for a topic given as KEY CONCEPTS.
- CORE: the paper directly studies the topic's main relationship — its OUTCOME together with the INTERVENTION/MECHANISM concept.
- CONTEXT: the paper relates to AT LEAST ONE key concept, or studies an adjacent outcome/mechanism. Useful background.
- OFF: unrelated to EVERY key concept.
🔴 Rules: (1) GEOGRAPHY AND TIME PERIOD ARE IRRELEVANT — never a reason to downgrade. (2) Be GENEROUS: if the paper touches ANY key concept, it is CONTEXT (or CORE), NOT OFF. Only use OFF when the paper is unrelated to ALL concepts. Partial coverage is CONTEXT, never OFF.
Return ONLY JSON: {"label":"CORE|CONTEXT|OFF","reason":"<=12 words"}`;

async function judge(core, title, abstract) {
  const txt = await chat(JUDGE_SYS, `Key concepts: ${core}\n\nPaper title: ${title}\nAbstract: ${(abstract || '(no abstract)').slice(0, 1100)}\n\nClassify (geography & time irrelevant; be generous — partial match = CONTEXT not OFF).`);
  const m = txt.match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : txt); const l = (j.label || '').toUpperCase().trim(); return { label: ['CORE', 'CONTEXT', 'OFF'].includes(l) ? l : 'ERR', reason: j.reason || '' }; }
  catch { return { label: 'ERR', reason: '' }; }
}

const report = [];
for (const { runId, query } of QUERIES) {
  const { data: run } = await SB.from('search_runs').select('evidence_work_ids').eq('id', runId).single();
  const ids = run?.evidence_work_ids || [];
  const { data: works } = await SB.from('works').select('id,title,abstract').in('id', ids);
  const byId = {}; (works || []).forEach(w => byId[w.id] = w);
  const core = (await chat(EXTRACT_SYS, `Query: ${query}`)).trim().replace(/^["']|["']$/g, '');
  const qv = await embed(query);
  const cmap = await cosForIds(qv, ids);

  console.log(`\n══════ "${query}"`);
  console.log(`core (region/time stripped): "${core}"  | ${(works || []).length} papers\n`);
  const rows = [];
  for (const id of ids) {
    const w = byId[id]; if (!w) continue;
    const j = await judge(core, w.title, w.abstract);
    rows.push({ cos: cmap.get(String(id)) ?? 0, ...j, title: w.title });
    await sleep(650);
  }
  rows.sort((a, b) => b.cos - a.cos);
  const cnt = { CORE: 0, CONTEXT: 0, OFF: 0, ERR: 0 };
  rows.forEach(r => { cnt[r.label] = (cnt[r.label] || 0) + 1; });
  console.log(`  CORE ${cnt.CORE} | CONTEXT ${cnt.CONTEXT} | OFF ${cnt.OFF} | err ${cnt.ERR || 0}`);
  console.log(`  --- CORE (top of brief) — should be the genuinely on-topic papers: ---`);
  rows.filter(r => r.label === 'CORE').slice(0, 10).forEach(r => console.log(`     cos${r.cos.toFixed(2)} ${r.title.slice(0, 58)}`));
  console.log(`  --- OFF (truly unrelated tail — should be SMALL + genuinely off): ---`);
  rows.filter(r => r.label === 'OFF').forEach(r => console.log(`     cos${r.cos.toFixed(2)} ${r.title.slice(0, 58)}  [${r.reason}]`));
  report.push({ query, core, counts: cnt, core_titles: rows.filter(r => r.label === 'CORE').map(r => r.title), off: rows.filter(r => r.label === 'OFF').map(r => ({ cos: +r.cos.toFixed(3), title: r.title, reason: r.reason })) });
}
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/topicality-judge-multi-eval.json', JSON.stringify(report, null, 2));
console.log('\n-> reports/topicality-judge-multi-eval.json');
