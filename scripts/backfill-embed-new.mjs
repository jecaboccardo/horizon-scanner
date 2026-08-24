#!/usr/bin/env node
/**
 * Embed NEW rows that landed with embedding=NULL (the WB/CGD/IDB/etc. ingests),
 * noise-safe. Unlike backfill-fast.mjs (which has NO noise guard and would
 * re-embed the 48k deliberately-nulled noise rows), this filters to
 * canonical_work_id IS NULL AND is_noise IS NOT TRUE. Gap-only: writes embedding
 * only where it is still NULL. Document task-type (matches corpus vectors).
 *
 * Usage: node --env-file=.env scripts/backfill-embed-new.mjs [--batch 32] [--max 0]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com';
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BATCH = parseInt(flag('--batch', '32'), 10);
const MAX = parseInt(flag('--max', '0'), 10) || Infinity;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function embedBatch(texts) {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts.map(t => 'search_document: ' + t), dimensions: 768 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).data.map(d => d.embedding);
}

let done = 0, errors = 0;
const { count: total } = await sb.from('works').select('*', { count: 'exact', head: true })
  .is('embedding', null).is('canonical_work_id', null).not('is_noise', 'is', true);
console.log(`Embedding ${Math.min(total, MAX)} of ${total} null-embedding non-noise rows (batch ${BATCH})...`);

while (done < MAX) {
  const { data: rows, error } = await sb.from('works').select('id, title, abstract')
    .is('embedding', null).is('canonical_work_id', null).not('is_noise', 'is', true)
    .order('id', { ascending: true }).limit(BATCH);
  if (error) { console.error('fetch:', error.message); break; }
  if (!rows?.length) break;
  const texts = rows.map(r => (r.title + ' ' + (r.abstract || '')).slice(0, 2000));
  let vecs;
  try { vecs = await embedBatch(texts); }
  catch (e) { console.error('\nembed err:', e.message, '— retry in 3s'); await sleep(3000); try { vecs = await embedBatch(texts); } catch (e2) { console.error('retry failed, skipping batch'); errors++; await sleep(1000); continue; } }
  for (let i = 0; i < rows.length; i++) {
    if (!vecs[i]) continue;
    const { error: uErr } = await sb.from('works').update({ embedding: vecs[i] }).eq('id', rows[i].id).is('embedding', null);
    if (uErr) { errors++; } else { done++; }
  }
  process.stdout.write(`\r  embedded ${done}  errors ${errors}`);
  await sleep(300);
}
console.log(`\nDone. embedded=${done} errors=${errors}`);
