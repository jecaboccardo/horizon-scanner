#!/usr/bin/env node
/**
 * Re-embed papers that now have abstracts but still have a title-only embedding.
 *
 * Since there is no last_embedded_at timestamp, this script accepts a list of
 * work IDs (from the OA sweep sidecar file) and re-embeds those specifically.
 * It can also be run in --all mode to re-embed every canonical paper that has
 * an abstract (useful after a large bulk backfill, but slow — ~8h for 400k).
 *
 * Embedding (post-cutover 2026-06-12): qwen3-embedding:8b at dimensions=768,
 * 'search_document: ' prefix, title + abstract — matches reembed-qwen768.mjs (how
 * the corpus `embedding` column was built). MUST send dimensions=768 for qwen or it
 * returns native 4096-dim vectors that mismatch the vector(768) column. Writes the
 * live `embedding` column. (nomic rollback path: set OLLAMA_EMBEDDING_MODEL=nomic-*,
 * which is natively 768 and skips the dimensions param.)
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-reembed-with-abstract.mjs \
 *     --ids-file reports/oa-sweep-updated-ids-YYYY-MM-DD.json
 *
 *   node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --all [--limit N]
 *
 *   node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --dry-run \
 *     --ids-file reports/oa-sweep-updated-ids-YYYY-MM-DD.json
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALL_MODE = args.includes('--all');
// --stale: re-embed rows flagged raw_data.embedding_stale=true (2026-07-15
// recalled-abstracts remediation: embedding was computed off fabricated text).
// Null abstracts are ALLOWED here — quarantined rows re-embed title-only.
// Clears the flag (embedding_stale=false + reembedded_at) after a good write.
const STALE_MODE = args.includes('--stale');
const IDS_FILE = (() => { const i = args.indexOf('--ids-file'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();

const BATCH_SIZE = 20;      // nomic handles up to 50 but smaller = fewer lost on error
const SLEEP_MS = 200;
const PROGRESS_FILE = 'reports/backfill-agent-progress.json';

if (!ALL_MODE && !IDS_FILE && !STALE_MODE) {
  console.error('Provide --ids-file <path>, --all, or --stale');
  process.exit(1);
}

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY || '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b';
// qwen3-embedding is Matryoshka — it MUST be asked for dimensions=768 or it returns
// its native 4096-dim vector, which mismatches the vector(768) `embedding` column
// and corrupts the write. nomic (rollback) is natively 768 and does NOT accept
// `dimensions`, so only send it for qwen/MRL models. (Was missing → stale post-cutover.)
const MODEL_DIMS = /qwen3?-?embedding|qwen.*embed/i.test(EMBED_MODEL) ? 768 : undefined;

if (!LLM_KEY) { console.error('LLM_API_KEY missing'); process.exit(1); }

function buildText(title, abstract) {
  // Matches reembed-qwen768.mjs (how the corpus was built): 'search_document: '
  // prefix over title + abstract, 8000-char cap (qwen handles 32k tokens; the old
  // 2000 nomic-era cap truncated long abstracts and diverged from the corpus).
  const body = [title, abstract].filter(Boolean).join(' ').slice(0, 8000);
  return `search_document: ${body}`;
}

async function embedBatch(texts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, ...(MODEL_DIMS ? { dimensions: MODEL_DIMS } : {}), input: texts, keep_alive: '60m' }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
      }
      const data = await res.json();
      if (!Array.isArray(data.data)) throw new Error('Unexpected response shape');
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function writeProgress(data) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2));
}

async function getTargetRows(ids) {
  if (ids) {
    // Fetch in pages of 100 (work IDs are long DOI/repo strings — 500 per
    // .in() overflows the PostgREST request URI → "URI too long").
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data, error } = await sb.from('works')
        .select('id, title, abstract')
        .in('id', chunk)
        .not('abstract', 'is', null);
      if (error) { console.error('DB error:', error); continue; }
      rows.push(...(data || []));
    }
    return rows;
  } else if (STALE_MODE) {
    // Rows whose embedding was built from a fabricated (LLM-recalled) abstract.
    // abstract may be NULL (quarantined) — buildText degrades to title-only.
    const rows = [];
    let cursor = null;
    while (rows.length < LIMIT) {
      let q = sb.from('works')
        .select('id, title, abstract, raw_data')
        .filter('raw_data->>embedding_stale', 'eq', 'true')
        .order('id')
        .limit(1000);
      if (cursor) q = q.gt('id', cursor);
      const { data, error } = await q;
      if (error || !data?.length) break;
      rows.push(...data);
      cursor = data[data.length - 1].id;
      if (data.length < 1000) break;
      process.stdout.write(`\r  loading stale targets… ${rows.length}`);
    }
    process.stdout.write('\n');
    return rows.slice(0, LIMIT);
  } else {
    // --all mode: cursor-paginated
    const rows = [];
    let cursor = null;
    while (rows.length < LIMIT) {
      let q = sb.from('works')
        .select('id, title, abstract')
        .not('abstract', 'is', null)
        .is('canonical_work_id', null)
        .not('is_noise', 'is', true)
        .order('id')
        .limit(2000);
      if (cursor) q = q.gt('id', cursor);
      const { data, error } = await q;
      if (error || !data?.length) break;
      rows.push(...data);
      cursor = data[data.length - 1].id;
      if (data.length < 2000) break;
      process.stdout.write(`\r  loading targets… ${rows.length}`);
    }
    process.stdout.write('\n');
    return rows.slice(0, LIMIT);
  }
}

async function main() {
  let ids = null;
  if (IDS_FILE) {
    const raw = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    ids = raw.ids || raw;
    console.log(`IDs file: ${IDS_FILE} — ${ids.length} IDs`);
    if (raw.partial) console.warn('  WARNING: IDs file is marked partial (OA sweep still running?)');
  }

  console.log(`\n=== Re-embed with abstract (${ALL_MODE ? 'ALL mode' : 'IDs file mode'}) ===`);
  console.log(`Model: ${EMBED_MODEL} | DryRun: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);

  process.stdout.write('Loading target rows...\n');
  const rows = await getTargetRows(ids);
  console.log(`Targets: ${rows.length} papers with abstracts to re-embed`);

  if (DRY_RUN) { console.log('Dry run — no writes.'); return; }
  if (rows.length === 0) { console.log('Nothing to do.'); return; }

  let done = 0, errors = 0;
  const start = Date.now();
  writeProgress({ phase: 're_embed_starting', total: rows.length });

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => buildText(r.title, r.abstract));
    let vectors;
    try {
      vectors = await embedBatch(texts);
    } catch (e) {
      console.error(`\nEmbed error at batch ${i}:`, e.message);
      errors += batch.length;
      await sleep(2000);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      // Guard: never write a wrong-dimension vector to the vector(768) column.
      if (!Array.isArray(vec) || !vec.length || (MODEL_DIMS && vec.length !== MODEL_DIMS)) { errors++; continue; }
      const patch = { embedding: `[${vec.join(',')}]` };
      if (STALE_MODE) {
        patch.raw_data = {
          ...(batch[j].raw_data || {}),
          embedding_stale: false,
          reembedded_at: new Date().toISOString(),
        };
      }
      const { error } = await sb.from('works')
        .update(patch)
        .eq('id', batch[j].id);
      if (error) errors++;
      else done++;
    }

    const elapsed = (Date.now() - start) / 60000;
    const rate = Math.round(done / elapsed) || 0;
    process.stdout.write(`\r  ${i + batch.length}/${rows.length} | re-embedded ${done} | errors ${errors} | ${rate}/min`);

    if (done % 500 < BATCH_SIZE) {
      writeProgress({ phase: 're_embed_running', done, total: rows.length, errors, rate_per_min: rate });
    }

    await sleep(SLEEP_MS);
  }

  process.stdout.write('\n');
  const summary = { done, errors, total: rows.length, elapsed_min: Math.round((Date.now() - start) / 60000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  writeProgress({ phase: 're_embed_complete', ...summary });
  fs.writeFileSync(`reports/reembed-with-abstract-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ summary }, null, 2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
