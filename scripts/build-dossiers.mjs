#!/usr/bin/env node
/**
 * build-dossiers.mjs — Evidence Dossier pre-step (Phase 1 spike).
 *
 * For a given search_run's evidence set, builds a cache of per-paper enrichment:
 *   - context_note: short, UNCITED, non-empirical framing for EVERY paper
 *   - fulltext_md:  Tyler-style compact markdown for the top-N OA papers (fixed schema)
 *
 * Writes reports/dossier-cache.json keyed by workId. Resumable (skips cached).
 * Cache-and-grow stand-in for the work_dossiers table (no DDL access from laptop).
 *
 * Usage: node scripts/build-dossiers.mjs <searchRunId> [--topn 15] [--concurrency 2]
 *
 * GOLDEN RULE: reads works; never writes works. Output is prompt-input only.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');   // v2 class-based API
config();

const SEARCH_RUN_ID = process.argv[2];
if (!SEARCH_RUN_ID) { console.error('usage: build-dossiers.mjs <searchRunId> [--topn N] [--concurrency N]'); process.exit(1); }
const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i > 0 ? Number(process.argv[i + 1]) : def; };
const TOPN = arg('--topn', 15);
const CONCURRENCY = arg('--concurrency', 2);
const CACHE_PATH = process.env.DOSSIER_CACHE_PATH || 'reports/dossier-cache.json';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com';
const LLM_MODEL = process.env.LLM_MODEL || process.env.QWEN_MODEL || 'qwen2.5:14b-synthesis';
const FULLTEXT_SCHEMA_VERSION = 1;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- cache -----------------------------------------------------------------
let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
}
const saveCache = () => fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

// ---- LLM (OpenAI-shape on LiteLLM) -----------------------------------------
async function qwen(system, user, maxTokens = 900, timeoutMs = 120_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL, temperature: 0.2, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() ?? '';
  } finally { clearTimeout(t); }
}

// ---- PDF fetch + extract ----------------------------------------------------
async function fetchPdfText(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HorizonScanner/1.0; +research)' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!ct.includes('pdf') && buf.slice(0, 5).toString() !== '%PDF-') throw new Error(`not a pdf (${ct})`);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    let parsed;
    try { parsed = await parser.getText(); } finally { await parser.destroy?.().catch(() => {}); }
    const text = (parsed.text || '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (text.length < 800) throw new Error(`extracted only ${text.length} chars`);
    return text;
  } finally { clearTimeout(t); }
}

// ---- prompts ----------------------------------------------------------------
function contextNotePrompt(p) {
  const system = [
    'You write a SHORT, NON-EMPIRICAL framing note about one research paper for use as background context in a literature survey.',
    'STRICT RULES:',
    '- 50-90 words. One short paragraph.',
    '- Frame the paper in its literature: what question it engages, what tradition/approach it belongs to, why it matters to the topic.',
    '- Do NOT state empirical findings, effect sizes, or numbers as facts. Do NOT invent anything. Do NOT cite other works.',
    '- This is context, not a result claim. Neutral, encyclopedic register.',
    'OUTPUT: the note text only, no preamble, no JSON.',
  ].join('\n');
  const user = [
    `TITLE: ${p.title}`,
    `AUTHORS: ${(p.authors || []).slice(0, 5).join(', ')}`,
    `YEAR: ${p.year ?? 'n/a'} | DESIGN: ${p.methodology_design ?? 'n/a'} | SMS: ${p.sms_level ?? 'n/a'}`,
    p.abstract ? `ABSTRACT: ${p.abstract.slice(0, 1200)}` : 'ABSTRACT: (none available)',
    '',
    'Write the framing note now.',
  ].join('\n');
  return { system, user };
}

function fulltextPrompt(p, text) {
  const system = [
    'You compress one academic paper into a compact, factual markdown brief for an economics literature survey.',
    'Extract ONLY what the text states. Do NOT invent. If a field is not in the text, write "not stated".',
    'OUTPUT exactly this markdown (no preamble, no fences):',
    '- **Research question:** ...',
    '- **Data & sample:** ... (dataset, period, sample size, country/setting)',
    '- **Identification strategy:** ... (design + how causal identification is argued, if any)',
    '- **Main results:** ... (each key effect with MAGNITUDE and SIGN, e.g. "+0.18 SD on test scores"; quote numbers verbatim from the text)',
    '- **Limitations:** ...',
    '- **Setting / geography:** ...',
    'Keep under ~350 words total. Prioritise magnitudes and identification.',
  ].join('\n');
  const user = [
    `TITLE: ${p.title}`,
    `YEAR: ${p.year ?? 'n/a'} | DESIGN: ${p.methodology_design ?? 'n/a'}`,
    '',
    'PAPER TEXT (truncated):',
    text.slice(0, 22_000),
    '',
    'Produce the compact brief now.',
  ].join('\n');
  return { system, user };
}

// ---- concurrency pool -------------------------------------------------------
async function pool(items, n, fn) {
  const q = [...items.entries()];
  const workers = Array.from({ length: n }, async () => {
    while (q.length) { const [i, item] = q.shift(); await fn(item, i); }
  });
  await Promise.all(workers);
}

// ---- main -------------------------------------------------------------------
const { data: run, error: runErr } = await sb
  .from('search_runs').select('id, query, evidence_work_ids').eq('id', SEARCH_RUN_ID).single();
if (runErr || !run) throw new Error(`run fetch failed: ${runErr?.message}`);
const ids = run.evidence_work_ids ?? [];
console.log(`run ${SEARCH_RUN_ID} — "${run.query}" — ${ids.length} evidence papers`);

const works = [];
for (let i = 0; i < ids.length; i += 80) {
  const { data } = await sb.from('works')
    .select('id, title, authors, year, sms_level, methodology_design, abstract, citation_count, open_access_pdf_url')
    .in('id', ids.slice(i, i + 80));
  if (data) works.push(...data);
}
console.log(`fetched ${works.length} works`);

// Pick top-N "leaned-on" papers WITH an OA pdf for full-text ingestion.
const oa = works.filter((w) => w.open_access_pdf_url);
const leanScore = (w) => (w.sms_level ?? 0) * 5 + Math.log10((w.citation_count ?? 0) + 1) * 3 + (w.abstract ? 1 : 0);
const topFulltext = oa.sort((a, b) => leanScore(b) - leanScore(a)).slice(0, TOPN);
console.log(`OA papers: ${oa.length}/${works.length} | full-text targets (top ${TOPN}): ${topFulltext.length}`);

// 1) Context notes for ALL papers (cheap, universal).
let notesDone = 0, notesSkip = 0;
await pool(works, CONCURRENCY, async (w) => {
  cache[w.id] = cache[w.id] || {};
  if (cache[w.id].context_note) { notesSkip++; return; }
  try {
    const { system, user } = contextNotePrompt(w);
    const note = await qwen(system, user, 220);
    cache[w.id].context_note = note;
    cache[w.id].title = w.title;
    notesDone++;
    if (notesDone % 5 === 0) { saveCache(); console.log(`  context notes: ${notesDone} built, ${notesSkip} cached`); }
  } catch (e) { console.log(`  note FAIL ${w.id}: ${e.message}`); }
});
saveCache();
console.log(`context notes: ${notesDone} built, ${notesSkip} already cached`);

// 2) Full text for top-N OA papers.
let ftOk = 0, ftFail = 0, ftSkip = 0;
await pool(topFulltext, CONCURRENCY, async (w) => {
  cache[w.id] = cache[w.id] || {};
  if (cache[w.id].fulltext_md && cache[w.id].fulltext_schema_version === FULLTEXT_SCHEMA_VERSION) { ftSkip++; return; }
  try {
    const text = await fetchPdfText(w.open_access_pdf_url);
    const { system, user } = fulltextPrompt(w, text);
    const md = await qwen(system, user, 800);
    if (md && md.length > 120) {
      cache[w.id].fulltext_md = md;
      cache[w.id].fulltext_source = 'oa_pdf';
      cache[w.id].fulltext_schema_version = FULLTEXT_SCHEMA_VERSION;
      ftOk++;
      console.log(`  ✓ full text ${w.id} (${text.length} chars → ${md.length})`);
    } else throw new Error('compression too short');
    saveCache();
  } catch (e) { ftFail++; cache[w.id].fulltext_source = null; console.log(`  ✗ full text ${w.id}: ${e.message}`); }
});
saveCache();

console.log(JSON.stringify({
  run: SEARCH_RUN_ID, papers: works.length, oa: oa.length,
  context_notes: Object.values(cache).filter((d) => d.context_note).length,
  fulltext_built: Object.values(cache).filter((d) => d.fulltext_md).length,
  fulltext_ok_this_run: ftOk, fulltext_fail_this_run: ftFail, fulltext_skipped: ftSkip,
  cache_path: CACHE_PATH,
}, null, 2));
