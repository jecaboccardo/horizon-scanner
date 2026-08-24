#!/usr/bin/env node
/**
 * OFFLINE EVAL — topicality judge (Direct / Related / Off-topic).
 * Tests whether a cheap LLM judge can separate on-topic evidence from
 * semantically-adjacent-but-off-topic papers (which cosine cannot — see the
 * maternal-mortality cosine audit). Gold = hand labels below. Judge = Qwen.
 * NON-DESTRUCTIVE: read-only, writes a report. No retrieval changes.
 *
 *   node --env-file=.env scripts/eval-topicality-judge.mjs [runId] [--model qwen|gemini]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = (process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY;
const CHAT_MODEL = process.env.LLM_MODEL ?? 'qwen2.5:14b-synthesis';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b-app';
const RUN_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'f10f24d1-48ec-4742-a312-c1f47a79c02a';
const QUERY = 'What works to reduce maternal mortality in Latin America?';
// Region is a SEPARATE ranking signal (boost/floor) — the topicality judge must judge
// OUTCOME/INTERVENTION only, never geography, or it false-drops transferable RCTs.
const CORE = 'what works to reduce maternal mortality (interventions / health-system measures; ANY country)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- GOLD hand-labels (by title substring). DIRECT=core outcome (maternal mortality/
// maternal-perinatal health care). RELATED=adjacent outcome same pop/region (child mortality,
// maternal-ed, GBV, broad health). OFF=not a maternal/mortality health outcome (labor/wages/gender).
function gold(t) {
  const s = t.toLowerCase();
  if (/gender pay|women at work|women in the .*labor|labor market|evolution of gender gap|gender parit|who cares\?|caregiv|motherhood on wage|labor force particip|nudging latin|palabras de|primera dama|first lady|job displacement|unemployment benefit/.test(s)) return 'OFF';
  if (/child mortality|maternal education|education.*mortality|gender-based violence|piped water|adult literacy|infection control|millennium development|health of women|covid-19 pandemic|mortality transition/.test(s)) return 'RELATED';
  return 'DIRECT';
}

async function embed(text) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: EMBED_MODEL, input: [text], dimensions: 768 }) });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).data[0].embedding;
}
async function cosForIds(vec, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await SB.rpc('cosine_for_ids', { p_query: vec, p_ids: ids.slice(i, i + 200) });
    if (error) { console.error(error.message); continue; }
    for (const r of data || []) out.set(String(r.id), Number(r.cosine));
  }
  return out;
}

const SYS = `You classify whether a research paper is DIRECT evidence, RELATED context, or OFF_TOPIC for a research TOPIC (an outcome + intervention).
- DIRECT: the paper's primary outcome/intervention IS that topic.
- RELATED: a DIFFERENT but adjacent outcome (useful as context, not core evidence).
- OFF_TOPIC: not about that outcome or intervention at all.
🔴 GEOGRAPHY IS IRRELEVANT. The country/region of a study is NEVER a reason to mark it RELATED or OFF_TOPIC — a study of the topic in ANY country (Tanzania, India, Zambia, anywhere) is DIRECT. Judge only the outcome + intervention.
Return ONLY JSON: {"label":"DIRECT|RELATED|OFF_TOPIC","reason":"<=15 words"}`;

async function judge(title, abstract) {
  const user = `Topic: ${CORE}\n\nPaper title: ${title}\nAbstract: ${(abstract || '(no abstract)').slice(0, 1200)}\n\nClassify (geography is irrelevant).`;
  const r = await fetch(`${LLM_BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify({ model: CHAT_MODEL, temperature: 0, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }) });
  if (!r.ok) return { label: 'ERR', reason: `http ${r.status}` };
  const txt = (await r.json()).choices?.[0]?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : txt); return { label: (j.label || '').toUpperCase().replace('OFF-TOPIC', 'OFF_TOPIC'), reason: j.reason || '' }; }
  catch { return { label: 'PARSE_ERR', reason: txt.slice(0, 40) }; }
}

const { data: run } = await SB.from('search_runs').select('evidence_work_ids').eq('id', RUN_ID).single();
const ids = run.evidence_work_ids || [];
const { data: works } = await SB.from('works').select('id,title,abstract').in('id', ids);
const byId = {}; works.forEach(w => byId[w.id] = w);
const qv = await embed(QUERY);
const cmap = await cosForIds(qv, ids);

console.log(`Eval: topicality judge | model=${CHAT_MODEL} | query="${QUERY}" | ${works.length} papers\n`);
const results = [];
for (const id of ids) {
  const w = byId[id]; if (!w) continue;
  const g = gold(w.title);
  const j = await judge(w.title, w.abstract);
  const norm = j.label === 'OFF_TOPIC' ? 'OFF' : j.label;
  results.push({ id, title: w.title, cos: cmap.get(String(id)) ?? null, gold: g, judge: norm, reason: j.reason });
  await sleep(700); // gentle on shared Qwen GPU
}
results.sort((a, b) => (b.cos ?? 0) - (a.cos ?? 0));

console.log('cosine  GOLD     JUDGE    ok  title');
for (const r of results) console.log(`${(r.cos ?? 0).toFixed(3)}  ${r.gold.padEnd(7)} ${r.judge.padEnd(7)} ${r.gold === r.judge ? ' ✓' : ' ✗'}  ${r.title.slice(0, 52)}`);

// confusion matrix + metrics
const L = ['DIRECT', 'RELATED', 'OFF'];
const cm = {}; L.forEach(a => { cm[a] = { DIRECT: 0, RELATED: 0, OFF: 0 }; });
let agree = 0; const offGold = [], offHit = [], directDropped = [];
for (const r of results) {
  if (cm[r.gold] && cm[r.gold][r.judge] != null) cm[r.gold][r.judge]++;
  if (r.gold === r.judge) agree++;
  if (r.gold === 'OFF') { offGold.push(r); if (r.judge === 'OFF') offHit.push(r); }
  if (r.gold === 'DIRECT' && r.judge === 'OFF') directDropped.push(r);
}
console.log('\nConfusion (rows=gold, cols=judge):');
console.log('          DIRECT RELATED OFF');
L.forEach(g => console.log(`  ${g.padEnd(7)} ${String(cm[g].DIRECT).padStart(6)} ${String(cm[g].RELATED).padStart(7)} ${String(cm[g].OFF).padStart(3)}`));
console.log(`\n3-way agreement: ${agree}/${results.length} (${(100 * agree / results.length).toFixed(0)}%)`);
console.log(`OFF-topic recall (caught/total off): ${offHit.length}/${offGold.length}`);
console.log(`⚠ DIRECT wrongly dropped as OFF (false drops): ${directDropped.length}`);
directDropped.forEach(r => console.log(`     • ${r.title.slice(0, 60)}  [judge reason: ${r.reason}]`));
const offMissed = offGold.filter(r => r.judge !== 'OFF');
console.log(`OFF-topic MISSED (judge kept): ${offMissed.length}`);
offMissed.forEach(r => console.log(`     • ${r.title.slice(0, 60)} -> ${r.judge}`));

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/topicality-judge-eval.json', JSON.stringify({ query: QUERY, model: CHAT_MODEL, results, confusion: cm, agree, total: results.length, offRecall: `${offHit.length}/${offGold.length}`, falseDrops: directDropped.length }, null, 2));
console.log('\n-> reports/topicality-judge-eval.json');
