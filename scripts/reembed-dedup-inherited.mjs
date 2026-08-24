#!/usr/bin/env node
/**
 * Re-embed canonicals that inherited an abstract from a dedup shadow, so their
 * `embedding` reflects the new abstract (not the title-only vector).
 *
 * Matches the corpus convention from reembed-qwen768.mjs EXACTLY:
 *   model=qwen3-embedding:8b, dimensions=768, text='search_document: '+title+' '+abstract
 *   (8000-char cap). Writes the live `embedding` column (post-cutover = qwen).
 *
 * Usage: node --env-file=.env scripts/reembed-dedup-inherited.mjs --ids-file reports/dedup-reembed-ids.json [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com';
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b';
const DIMS = 768;
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const IDS_FILE = (() => { const i = args.indexOf('--ids-file'); return i >= 0 ? args[i + 1] : null; })();
if (!IDS_FILE) { console.error('Provide --ids-file'); process.exit(1); }
const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')).ids || [];
const BATCH = 32, SLEEP = 300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function embedBatch(texts) {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, dimensions: DIMS, input: texts.map(t => 'search_document: ' + t), keep_alive: '60m' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

console.log(`re-embed ${ids.length} dedup-inherited canonicals (model=${MODEL} dims=${DIMS}) dry=${DRY}`);
let done = 0, errors = 0;
const t0 = Date.now();
for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  const { data: rows, error } = await sb.from('works').select('id,title,abstract').in('id', chunk);
  if (error) { console.error('fetch:', error.message); errors++; continue; }
  const texts = rows.map(r => ((r.title || '') + ' ' + (r.abstract || '')).slice(0, 8000).trim() || 'untitled');
  let vecs;
  try { vecs = await embedBatch(texts); }
  catch (e) { console.error('embed err:', e.message, '— retry 5s'); await sleep(5000); try { vecs = await embedBatch(texts); } catch (e2) { console.error('  retry failed:', e2.message); errors += rows.length; continue; } }
  if (!DRY) {
    for (let k = 0; k < rows.length; k++) {
      const vec = vecs[k];
      if (!Array.isArray(vec) || vec.length !== DIMS) { errors++; continue; }
      const { error: ue } = await sb.from('works').update({ embedding: `[${vec.join(',')}]` }).eq('id', rows[k].id);
      if (ue) { errors++; } else { done++; }
    }
  } else { done += rows.length; }
  const rate = (done / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1);
  process.stdout.write(`\r  ${Math.min(i + BATCH, ids.length)}/${ids.length} | embedded ${done} | err ${errors} | ${rate}/s`);
  await sleep(SLEEP);
}
console.log(`\nDone: embedded ${done}, errors ${errors}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
