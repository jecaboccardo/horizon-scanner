#!/usr/bin/env node
/**
 * Re-embed the corpus into the qwen vector(768) `embedding` column using
 * qwen3-embedding:8b at dimensions=768 (Matryoshka native output).
 *
 * COLUMN (post-cutover 2026-06-12): writes the LIVE `embedding` column — the
 * rename-swap made `embedding` = qwen and preserved the old nomic vectors in
 * `embedding_nomic_old`. (Originally written against the pre-rename
 * `embedding_qwen` column; updated so it can be re-run.)
 *
 * Why qwen-768: free (local GPU), and qwen-768 MRL beat nomic on the canonical
 * canary (Jensen 2010 query-cosine 0.795 vs nomic 0.78 / stale-stored 0.72),
 * with same 768 dim → reuses existing HNSW index structure, no dim migration.
 *
 * Targets ALL canonical non-noise rows (title-only when abstract is null, so the
 * whole corpus lives in one consistent qwen space). Resumable + idempotent:
 * processes rows where `embedding IS NULL`, so re-running continues where it
 * stopped (incremental re-embedder for newly-ingested / null-embedding rows).
 * Document task-type prefix ('search_document: ') matches how the corpus was built.
 *
 * Usage:
 *   node --env-file=.env scripts/reembed-qwen768.mjs [--batch 32] [--max 0] [--sleep 300]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BASE = process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com';
const KEY = process.env.LLM_API_KEY;
const MODEL = 'qwen3-embedding:8b';
const DIMS = 768;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BATCH = parseInt(flag('--batch', '32'), 10);
const MAX = parseInt(flag('--max', '0'), 10) || Infinity;
const SLEEP = parseInt(flag('--sleep', '300'), 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function embedBatch(texts) {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, dimensions: DIMS, input: texts.map(t => 'search_document: ' + t) }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()).data;
  return data.map(d => d.embedding);
}

// POST-CUTOVER (2026-06-12 rename-swap): the live qwen column is now `embedding`
// (the preserved nomic vectors live in `embedding_nomic_old`). This script was
// originally written against the pre-rename `embedding_qwen` column — updated to
// `embedding` so it can be re-run as an incremental re-embedder (fills canonical
// non-noise rows whose `embedding IS NULL`; the `.is('embedding', null)` write
// guard means it never overwrites an existing vector).
const baseFilter = (q) => q.is('embedding', null).is('canonical_work_id', null).not('is_noise', 'is', true);

let done = 0, errors = 0;
const { count: total } = await baseFilter(sb.from('works').select('*', { count: 'exact', head: true }));
console.log(`qwen-768 re-embed: ${Math.min(total ?? 0, MAX)} of ${total} remaining rows (model=${MODEL} dims=${DIMS} batch=${BATCH})`);
const t0 = Date.now();

while (done < MAX) {
  const { data: rows, error } = await baseFilter(
    sb.from('works').select('id, title, abstract').order('id', { ascending: true }).limit(BATCH),
  );
  if (error) { console.error('\nfetch:', error.message); break; }
  if (!rows?.length) break;

  // Embed the WHOLE abstract. qwen3-embedding handles 32k tokens, so the old
  // 2000-char nomic-era cap (which truncated ~5% of abstracts — the long
  // structured/review ones) is unnecessary. Cap at 8000 chars (~2000 tokens)
  // only to drop pathological outliers (full-text dumps, max seen 20k) that
  // would dilute the vector; this fully captures p99 (~3.2k chars) and below.
  const texts = rows.map(r => ((r.title || '') + ' ' + (r.abstract || '')).slice(0, 8000).trim() || 'untitled');
  let vecs;
  try {
    vecs = await embedBatch(texts);
  } catch (e) {
    console.error('\nembed err:', e.message, '— retry in 5s');
    await sleep(5000);
    try { vecs = await embedBatch(texts); }
    catch (e2) { console.error('retry failed, skipping batch'); errors += rows.length; await sleep(1000); continue; }
  }

  // Parallelize the per-row UPDATEs — sequential awaits were the throughput
  // bottleneck (~32 × 100ms RTT per batch dwarfed the embed call). Promise.all
  // collapses the write phase to ~one RTT.
  const writes = await Promise.all(rows.map((r, i) => {
    if (!vecs[i] || vecs[i].length !== DIMS) return Promise.resolve({ ok: false });
    return sb.from('works').update({ embedding: vecs[i] }).eq('id', r.id).is('embedding', null)
      .then(({ error }) => ({ ok: !error }));
  }));
  for (const w of writes) { if (w.ok) done++; else errors++; }

  const rate = done / ((Date.now() - t0) / 1000);
  const etaMin = rate > 0 ? Math.round(((total ?? 0) - done) / rate / 60) : '?';
  process.stdout.write(`\r  embedded ${done}  errors ${errors}  (${rate.toFixed(0)}/s, ~${etaMin}m left)   `);
  await sleep(SLEEP);
}
console.log(`\nDone. embedded=${done} errors=${errors} in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
