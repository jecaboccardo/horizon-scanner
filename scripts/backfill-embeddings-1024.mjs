#!/usr/bin/env node
/**
 * Backfill the works.embedding_1024 column with qwen3-embedding:8b vectors.
 *
 * Targets the NEW 1024-dim column added in 20260429000001_embedding_1024.sql.
 * Leaves the existing 768-dim `embedding` column untouched — production
 * retrieval keeps using it until the A3 cutover.
 *
 * Resume-safe: re-running picks up the next batch where embedding_1024 IS NULL.
 *
 * Usage:
 *   node scripts/backfill-embeddings-1024.mjs
 *
 * Recommended on the VPS for long runs:
 *   nohup node scripts/backfill-embeddings-1024.mjs > logs/backfill-1024.log 2>&1 &
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (required)
 *   LLM_BASE_URL            (default: https://llm.iotaimpact.com)
 *   LLM_API_KEY             (required — Bearer token for LiteLLM proxy)
 *   OLLAMA_EMBEDDING_MODEL  (default: qwen3-embedding:8b)
 *   PAGE_SIZE               (default: 5)   — papers per call
 *   SLEEP_MS                (default: 250) — pause between batches
 *   BATCH_TIMEOUT_MS        (default: 1800000) — 30 min per call
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const EMBEDDINGS_URL = `${LLM_BASE_URL}/v1/embeddings`;
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b';
const PAGE = parseInt(process.env.PAGE_SIZE || '5', 10);
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '250', 10);
const TIMEOUT = parseInt(process.env.BATCH_TIMEOUT_MS || '1800000', 10);
const EXPECTED_DIMS = 1024;

if (!LLM_API_KEY) {
  console.error('Missing LLM_API_KEY (LiteLLM proxy requires Bearer auth)');
  process.exit(1);
}

async function embedBatch(texts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const inputs = texts.map((t) => t.slice(0, 4000));
      const response = await fetch(EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, input: inputs }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!response.ok) {
        const body = await response.text();
        process.stderr.write(`H${response.status}:${body.slice(0, 80)} `);
        await sleep(attempt * 2000);
        continue;
      }
      const data = await response.json();
      if (Array.isArray(data.data) && data.data.length === inputs.length) {
        const sorted = [...data.data].sort((a, b) => a.index - b.index);
        const embeddings = sorted.map((item) => item.embedding);
        const dims = embeddings[0]?.length;
        if (dims !== EXPECTED_DIMS) {
          console.error(`\nFATAL: model returned ${dims} dims, expected ${EXPECTED_DIMS}. Check OLLAMA_EMBEDDING_MODEL.`);
          process.exit(2);
        }
        return embeddings;
      }
      process.stderr.write('E');
      await sleep(2000);
    } catch (err) {
      process.stderr.write(`!(${err.message?.slice(0, 30)}) `);
      await sleep(attempt * 3000);
    }
  }
  return Array(texts.length).fill(null);
}

async function getMissingCount() {
  const url = `${SUPABASE_URL}/rest/v1/works?select=id&embedding_1024=is.null&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      'Range-Unit': 'items',
      Range: '0-0',
    },
  });
  return parseInt(res.headers.get('content-range')?.split('/')[1] ?? '0', 10);
}

async function main() {
  console.log(`=== Backfill embedding_1024 [${MODEL}] ===`);
  console.log(`LLM: ${EMBEDDINGS_URL} | page=${PAGE} | sleep=${SLEEP_MS}ms\n`);

  const count = await getMissingCount();
  console.log(`Papers missing embedding_1024: ${count}`);
  if (!count) {
    console.log('All papers have embedding_1024.');
    process.exit(0);
  }

  let processed = 0;
  let updated = 0;
  let errors = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('works')
      .select('id, title, abstract')
      .is('embedding_1024', null)
      .order('id', { ascending: true })
      .limit(PAGE);

    if (error) {
      console.error(`\nFetch error: ${error.message}`);
      break;
    }
    if (!rows || rows.length === 0) break;

    const texts = rows.map((r) => `${r.title || ''} ${r.abstract || ''}`.trim());
    const embeddings = await embedBatch(texts);

    const updates = [];
    for (let j = 0; j < rows.length; j++) {
      const emb = embeddings[j];
      if (!emb) {
        errors++;
        process.stderr.write('x');
        continue;
      }
      updates.push({
        id: rows[j].id,
        embedding_1024: `[${emb.join(',')}]`,
        updated_at: new Date().toISOString(),
      });
      process.stderr.write('.');
    }

    if (updates.length > 0) {
      const { error: upErr } = await supabase
        .from('works')
        .upsert(updates, { onConflict: 'id' });
      if (upErr) {
        console.error(`\nUpsert error: ${upErr.message}`);
        errors += updates.length;
      } else {
        updated += updates.length;
      }
    }

    processed += rows.length;
    if (processed % 50 === 0) {
      console.log(`\nProcessed: ${processed} | updated: ${updated} | errors: ${errors}`);
    }
    await sleep(SLEEP_MS);
  }

  const remaining = await getMissingCount();
  console.log(`\nDone: ${updated} embedded this run, ${errors} errors, ${remaining} still missing`);
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
