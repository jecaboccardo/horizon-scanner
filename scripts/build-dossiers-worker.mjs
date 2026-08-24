#!/usr/bin/env node
/**
 * build-dossiers-worker.mjs — populates the `work_dossiers` cache (Tier-2).
 *
 * The Node populator for Tyler Tier-A. For each work id: fetch its OA PDF →
 * pdf-parse extract (the PROVEN Node path — pdf-parse 2.x class API) → LLM-compress
 * into a magnitude-rich brief → UPSERT into work_dossiers. The Deno side
 * (`_shared/dossiers.ts`) only READS this cache; PDF extraction can't run in the
 * Deno request path (see that module's header). Tier-1 (index_entry) is built
 * fresh on the Deno read side from the works row, so this worker leaves it null
 * and owns only the expensive Tier-2 `full_text`.
 *
 * 🔒 GOLDEN RULE: reads `works`, writes `work_dossiers` ONLY — never `works`.
 * Resumable: skips ids already at status ok/no_fulltext. status fetch_failed is
 * retried (transient). Bounded concurrency (gentle on the GPU + PDF hosts).
 *
 * Inputs (one of):
 *   --ids id1,id2,...                 explicit work ids
 *   --ids-file path.json              JSON array of ids, or {ids:[...]}
 *   --run <searchRunId>               a run's evidence_work_ids
 * Flags: --concurrency 2  --model <llm>  --max-chars 22000  --dry-run  --redo
 *
 * Usage:
 *   node scripts/build-dossiers-worker.mjs --run <searchRunId> --concurrency 2
 *   node scripts/build-dossiers-worker.mjs --ids wb:10309274,10.1016/x --dry-run
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse'); // v2 class-based API (node_modules 2.x)
config();

const argv = process.argv;
const argStr = (flag, def = null) => { const i = argv.indexOf(flag); return i > 0 ? argv[i + 1] : def; };
const argNum = (flag, def) => { const v = argStr(flag); return v != null ? Number(v) : def; };
const DRY = argv.includes('--dry-run');
const REDO = argv.includes('--redo'); // rebuild even if already ok/no_fulltext
const CONCURRENCY = argNum('--concurrency', 2);
const MAX_CHARS = argNum('--max-chars', 22000);
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com';
const LLM_MODEL = argStr('--model', process.env.LLM_MODEL || process.env.QWEN_MODEL || 'qwen2.5:14b-synthesis');
// Verified web fallback (APP path = Gemini + Google Search grounding). The PLUGIN
// path does the equivalent with Claude web_search on the user's own sub.
const WEB = argv.includes('--web');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = argStr('--gemini-model', 'gemini-2.5-flash');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---- resolve target ids ----------------------------------------------------
async function resolveIds() {
  const ids = argStr('--ids');
  if (ids) return ids.split(',').map((s) => s.trim()).filter(Boolean);
  const file = argStr('--ids-file');
  if (file) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : (j.ids ?? []); }
  const run = argStr('--run');
  if (run) {
    const { data, error } = await sb.from('search_runs').select('evidence_work_ids').eq('id', run).single();
    if (error) throw new Error(`run fetch failed: ${error.message}`);
    return data?.evidence_work_ids ?? [];
  }
  // Pre-warm: evidence ids from the most recent N search_runs (for a cron/poller).
  const recent = argStr('--recent');
  if (recent) {
    const { data, error } = await sb.from('search_runs').select('evidence_work_ids').order('created_at', { ascending: false }).limit(Number(recent));
    if (error) throw new Error(`recent fetch failed: ${error.message}`);
    const out = [];
    for (const r of data ?? []) for (const id of (r.evidence_work_ids ?? [])) out.push(id);
    return out;
  }
  console.error('Provide --ids, --ids-file, --run, or --recent N'); process.exit(1);
}

// ---- PDF fetch + extract (proven path, ported from build-dossiers.mjs) ------
async function fetchPdfText(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
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

// ---- LLM compression (magnitude-rich brief) --------------------------------
async function llm(system, user, maxTokens = 800, timeoutMs = 120_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0.2, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() ?? '';
  } finally { clearTimeout(t); }
}

function briefPrompt(p, text) {
  const system = [
    'You compress one academic paper into a compact, factual markdown brief for an economics literature survey.',
    'Extract ONLY what the text states. Do NOT invent. If a field is not in the text, write "not stated".',
    'OUTPUT exactly this markdown (no preamble, no fences):',
    '- **Research question:** ...',
    '- **Data & sample:** ... (dataset, period, sample size, country/setting)',
    '- **Identification strategy:** ... (design + how causal identification is argued, if any)',
    '- **Main results:** ... (each key effect with MAGNITUDE and SIGN, e.g. "+0.18 SD on test scores"; quote numbers verbatim)',
    '- **Limitations / caveats:** ...',
    '- **Setting / geography:** ...',
    'Keep under ~350 words. Prioritise magnitudes and identification.',
  ].join('\n');
  const user = [
    `TITLE: ${p.title}`,
    `YEAR: ${p.year ?? 'n/a'} | DESIGN: ${p.methodology_design ?? 'n/a'}`,
    '', 'PAPER TEXT (truncated):', text.slice(0, MAX_CHARS), '',
    'Produce the compact brief now.',
  ].join('\n');
  return { system, user };
}

// ---- verified web fallback (Gemini + Google Search grounding) --------------
// For a CITED paper with no OA full text: search the web for THIS paper's
// magnitudes, accept ONLY if a source explicitly names it, and HEDGE every number
// (source: web). The extended claim-audit re-verifies at generation.
async function geminiGrounded(prompt, maxTokens = 700, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text || '').join('').trim();
  } finally { clearTimeout(t); }
}

function webBriefPrompt(p) {
  const auth = (p.authors || []).slice(0, 4).join(', ');
  return [
    'Find published effect sizes, main findings, sample, and caveats for THIS SPECIFIC paper:',
    `  "${p.title}" — ${auth || 'unknown authors'} (${p.year ?? 'n.d.'})`,
    '',
    'HARD RULES (citation integrity — a wrong attribution poisons a literature survey):',
    '- Use ONLY a source that EXPLICITLY names THIS paper (its title, OR its authors AND year).',
    '  Prefer the paper itself (working-paper or published version) or a review/replication citing it by name.',
    '- Do NOT report a number from a different-but-similar study. If unsure the number is from THIS exact',
    '  paper, do not report it.',
    '- If you cannot find a source clearly naming this exact paper, output EXACTLY: NOT_FOUND',
    '- HEDGE every magnitude (web-sourced, not read from the full text): "the study reports approximately ...".',
    '',
    'If found, OUTPUT this markdown (no preamble, no fences); "not stated" where unknown:',
    '- **Research question:** ...',
    '- **Data & sample:** ...',
    '- **Identification strategy:** ...',
    '- **Main results:** ... (hedged magnitudes, e.g. "the study reports approximately +0.2 SD on ...")',
    '- **Limitations / caveats:** ...',
    '- **Setting / geography:** ...',
  ].join('\n');
}

async function webBrief(p) {
  const out = await geminiGrounded(webBriefPrompt(p), 700);
  if (!out || out.length < 120 || /NOT_FOUND/i.test(out)) return null;
  return out;
}

// ---- concurrency pool ------------------------------------------------------
async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length || 1) }, async () => {
    while (q.length) { const item = q.shift(); await fn(item); }
  }));
}

// ---- main ------------------------------------------------------------------
const ids = [...new Set((await resolveIds()).filter(Boolean))];
const webStatus = WEB ? (GEMINI_API_KEY ? ` | WEB(gemini:${GEMINI_MODEL})` : ' | WEB-REQUESTED-BUT-NO-GEMINI_API_KEY') : '';
console.log(`dossier-worker: ${ids.length} ids | model=${LLM_MODEL} | concurrency=${CONCURRENCY}${webStatus}${DRY ? ' | DRY-RUN' : ''}`);

// Skip already-built (resumable) unless --redo.
let existing = new Set();
if (!REDO) {
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('work_dossiers').select('work_id,status').in('work_id', ids.slice(i, i + 200));
    for (const r of data ?? []) if (r.status === 'ok' || r.status === 'no_fulltext') existing.add(r.work_id);
  }
}
const todo = ids.filter((id) => !existing.has(id));
console.log(`  ${existing.size} already built, ${todo.length} to do`);

const works = [];
for (let i = 0; i < todo.length; i += 80) {
  const { data } = await sb.from('works')
    .select('id, title, authors, year, venue, abstract, methodology_design, open_access_pdf_url')
    .in('id', todo.slice(i, i + 80));
  if (data) works.push(...data);
}

const stats = { ok: 0, no_fulltext: 0, fetch_failed: 0, error: 0 };
await pool(works, CONCURRENCY, async (w) => {
  let full_text = null, status = 'no_fulltext', source = 'abstract_only';
  const url = w.open_access_pdf_url;
  if (url) {
    try {
      const raw = await fetchPdfText(url);
      const { system, user } = briefPrompt(w, raw);
      const brief = await llm(system, user, 800);
      if (brief && brief.length > 120) { full_text = brief; status = 'ok'; source = 'oa_pdf'; }
      else status = 'no_fulltext'; // extracted but compression empty → terminal
    } catch (e) {
      status = /HTTP|abort|fetch/i.test(e.message) ? 'fetch_failed' : 'no_fulltext';
      console.log(`  ✗ ${w.id}: ${e.message}`);
    }
  }
  // Verified web fallback (Gemini grounding) when no OA full text — hedged, name-gated.
  if (!full_text && WEB && GEMINI_API_KEY) {
    try {
      const wb = await webBrief(w);
      if (wb) { full_text = wb; status = 'ok'; source = 'web'; stats.web = (stats.web ?? 0) + 1; console.log(`  🌐 ${w.id} web brief (${wb.length} chars)`); }
    } catch (e) { console.log(`  web ✗ ${w.id}: ${e.message}`); }
  }
  stats[status] = (stats[status] ?? 0) + 1;
  const nowIso = new Date().toISOString();
  if (!DRY) {
    const { error } = await sb.from('work_dossiers').upsert({
      work_id: w.id, index_entry: null, full_text, token_count: full_text ? Math.ceil(full_text.length / 4) : 0,
      source, source_url: url ?? null, status, fetched_at: nowIso, updated_at: nowIso,
    }, { onConflict: 'work_id' });
    if (error) { stats.error++; console.log(`  write error ${w.id}: ${error.message}`); }
  }
  if (status === 'ok') console.log(`  ✓ ${w.id} (${full_text.length} chars)`);
});

console.log(JSON.stringify({ ids: ids.length, attempted: works.length, ...stats }, null, 2));
