#!/usr/bin/env node
/**
 * Backfill embeddings — supports LiteLLM proxy or Nomic API.
 * MODE=ollama (default) → LiteLLM at LLM_BASE_URL (qwen3-embedding:8b), ascending IDs (low end)
 * MODE=nomic            → Nomic cloud API, descending IDs (high end, legacy)
 *
 * Env (LiteLLM mode):
 *   LLM_BASE_URL  (default: https://llm.iotaimpact.com)
 *   LLM_API_KEY   (required — Bearer token)
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { filterDeniedVenues, loadVenueDenylist } from './lib/venue-denylist.mjs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const MODE = process.env.MODE || 'ollama';
const IS_NOMIC = MODE === 'nomic';
const VENUE_DENYLIST = loadVenueDenylist();

const NOMIC_URL = 'https://api-atlas.nomic.ai/v1/embedding/text';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const EMBEDDINGS_URL = `${LLM_BASE_URL}/v1/embeddings`;

if (!IS_NOMIC && !LLM_API_KEY) {
  console.error('Missing LLM_API_KEY (LiteLLM proxy requires Bearer auth)');
  process.exit(1);
}

const PAGE = IS_NOMIC ? 100 : 5;
const ORDER_ASC = IS_NOMIC;
const TIMEOUT = IS_NOMIC ? 60000 : 1800000;

// Cost guard — stop before exceeding this amount on Nomic API
const MAX_COST_USD = parseFloat(process.env.MAX_COST_USD || '20');
const NOMIC_COST_PER_TOKEN = 1.0 / 10_000_000;  // $1 per 10M tokens
const CHARS_PER_TOKEN = 4;  // rough estimate

let totalCharsEmbedded = 0;

function estimatedCostUSD() {
  return (totalCharsEmbedded / CHARS_PER_TOKEN) * NOMIC_COST_PER_TOKEN;
}

function checkCostLimit(texts) {
  if (!IS_NOMIC) return false;
  const batchChars = texts.reduce((sum, t) => sum + t.length, 0);
  const projectedCost = ((totalCharsEmbedded + batchChars) / CHARS_PER_TOKEN) * NOMIC_COST_PER_TOKEN;
  if (projectedCost > MAX_COST_USD) {
    console.log(`\n⚠ Cost limit reached: ~$${estimatedCostUSD().toFixed(2)} spent (limit $${MAX_COST_USD}). Stopping.`);
    return true;
  }
  return false;
}

async function embedBatch(texts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const inputs = texts.map(t => t.slice(0, 4000));

      const response = IS_NOMIC
        ? await fetch(NOMIC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.NOMIC_API_KEY}` },
            body: JSON.stringify({ model: 'nomic-embed-text-v1.5', texts: inputs, task_type: 'search_document' }),
            signal: AbortSignal.timeout(TIMEOUT),
          })
        : await fetch(EMBEDDINGS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${LLM_API_KEY}`,
            },
            body: JSON.stringify({ model: 'qwen3-embedding:8b', input: inputs }),
            signal: AbortSignal.timeout(TIMEOUT),
          });

      if (!response.ok) {
        const body = await response.text();
        process.stderr.write(`H${response.status}:${body.slice(0, 80)} `);
        await sleep(attempt * 2000);
        continue;
      }

      const data = await response.json();
      // Nomic returns { embeddings: [...] }; LiteLLM/OpenAI returns { data: [{index, embedding}] }
      if (IS_NOMIC) {
        if (Array.isArray(data.embeddings) && data.embeddings.length === inputs.length) {
          return data.embeddings;
        }
      } else {
        if (Array.isArray(data.data) && data.data.length === inputs.length) {
          const sorted = [...data.data].sort((a, b) => a.index - b.index);
          return sorted.map((item) => item.embedding);
        }
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
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
    + '/rest/v1/works?select=id&embedding=is.null&limit=1';
  const res = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'count=exact',
      'Range-Unit': 'items',
      'Range': '0-0',
    }
  });
  return parseInt(res.headers.get('content-range')?.split('/')[1] ?? '0');
}

async function main() {
  console.log(`=== Backfill [${MODE.toUpperCase()}] (${ORDER_ASC ? 'ascending' : 'descending'} IDs) ===\n`);
  console.log(`Venue denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})\n`);

  const count = await getMissingCount();
  console.log(`Missing embeddings: ${count}\n`);
  if (!count) { console.log('All papers embedded!'); process.exit(0); }

  let processed = 0;
  let updated = 0;
  let errors = 0;

  while (processed < count) {
    console.log(`Fetching batch (${processed}/${count})...`);
    const { data: rows, error } = await supabase
      .from('works').select('id, title, abstract, source, venue')
      .is('embedding', null)
      .order('id', { ascending: ORDER_ASC })
      .limit(PAGE);

    if (error) { console.error(`Fetch error: ${error.message}`); break; }
    const allowedRows = filterDeniedVenues(rows || [], VENUE_DENYLIST);
    if (!allowedRows.length) {
      if (!rows || rows.length === 0) break;
      processed += rows.length;
      console.log(`Skipped ${rows.length} denied-venue papers`);
      continue;
    }
    console.log(`Got ${allowedRows.length} papers`);

    const texts = allowedRows.map(r => `${r.title || ''} ${r.abstract || ''}`.trim());

    if (checkCostLimit(texts)) { process.exit(0); }

    const embeddings = await embedBatch(texts);
    totalCharsEmbedded += texts.reduce((sum, t) => sum + t.length, 0);

    const updates = [];
    for (let j = 0; j < allowedRows.length; j++) {
      const emb = embeddings[j];
      if (!emb) { errors++; process.stderr.write('x'); continue; }
      updates.push({
        id: allowedRows[j].id,
        title: allowedRows[j].title || '[No title]',
        embedding: `[${emb.join(',')}]`,
        source: allowedRows[j].source,
        updated_at: new Date().toISOString(),
      });
      process.stderr.write('.');
    }

    if (updates.length > 0) {
      const { error: upErr } = await supabase.from('works').upsert(updates, { onConflict: 'id' });
      if (upErr) {
        console.error(`\nUpsert error: ${upErr.message}`);
        errors += updates.length;
      } else {
        updated += updates.length;
      }
    }

    processed += allowedRows.length;
    const costStr = IS_NOMIC ? ` | ~$${estimatedCostUSD().toFixed(3)} spent` : '';
    console.log(`\nProcessed: ${processed}/${count}, updated: ${updated}, errors: ${errors}${costStr}`);
    await sleep(200);
  }

  const remaining = await getMissingCount();
  console.log(`\nDone: ${updated} embedded, ${errors} errors, ${remaining} still missing`);
  process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err); process.exit(1); });
