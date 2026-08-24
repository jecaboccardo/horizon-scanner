#!/usr/bin/env node
/**
 * Backfill embeddings using Ollama CLI directly (no HTTP API needed).
 * Calls: ollama run nomic-embed-text "text"
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const PAGE = 20;
const OLLAMA = 'C:/Users/JessicaBoccardo/AppData/Local/Programs/Ollama/ollama.exe';

function embedText(text) {
  try {
    const input = text.replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 500);
    const output = execSync(`"${OLLAMA}" run nomic-embed-text "${input}"`, {
      timeout: 120000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: true,
    }).trim();
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed) && parsed.length > 100) return parsed;
    return null;
  } catch {
    return null;
  }
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
  console.log('=== Backfill via Ollama CLI ===\n');

  const count = await getMissingCount();
  console.log(`Missing embeddings: ${count}\n`);
  if (!count) { console.log('All done!'); process.exit(0); }

  let processed = 0;
  let updated = 0;
  let errors = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('works').select('id, title, abstract, source')
      .is('embedding', null)
      .order('id', { ascending: true })
      .limit(PAGE);

    if (error) { console.error('Fetch error:', error.message); break; }
    if (!rows || rows.length === 0) break;

    console.log(`\nBatch of ${rows.length} (total updated: ${updated}, errors: ${errors})`);

    const updates = [];
    for (const row of rows) {
      const text = `${row.title || ''} ${row.abstract || ''}`.trim().slice(0, 1000);
      process.stdout.write('.');
      const emb = embedText(text);
      if (!emb) { errors++; process.stdout.write('x'); continue; }
      updates.push({
        id: row.id,
        title: row.title || '[No title]',
        embedding: `[${emb.join(',')}]`,
        source: row.source,
        updated_at: new Date().toISOString(),
      });
    }

    if (updates.length > 0) {
      const { error: upErr } = await supabase.from('works').upsert(updates, { onConflict: 'id' });
      if (upErr) {
        console.error('\nUpsert error:', upErr.message);
        errors += updates.length;
      } else {
        updated += updates.length;
      }
    }

    processed += rows.length;
    const remaining = await getMissingCount();
    console.log(`\nProcessed: ${processed} | Updated: ${updated} | Errors: ${errors} | Remaining: ${remaining}`);

    if (remaining === 0) break;
  }

  console.log(`\nDone: ${updated} embedded, ${errors} errors`);
}

main().catch(err => { console.error(err); process.exit(1); });
