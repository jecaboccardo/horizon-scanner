#!/usr/bin/env node
/**
 * Qwen-based metadata recall sweep for missing AUTHORS and GEOGRAPHY.
 *
 * ⚠️ GOLDEN RULE (2026-07-15, recalled-abstracts incident): ABSTRACTS ARE
 * RETRIEVED TEXT, NEVER GENERATED. This script previously also "recalled"
 * abstracts from training data — verification showed ~99% of checkable
 * LLM-recalled abstracts were fabrications (see
 * scripts/verify-recalled-abstracts.mjs + reports/recalled-abstracts-*).
 * The abstract-recall path was REMOVED. Do not reintroduce it — abstracts may
 * only be written by retrieval-based backfills (publisher APIs, scrapers,
 * OpenAlex/S2/Crossref, xlsx imports).
 * Recalled AUTHORS are also unreliable — verify against OpenAlex before
 * trusting them (raw_data.author_source='qwen_recall' marks them).
 *
 * Uses the LiteLLM proxy (qwen2.5:14b-synthesis) which is free and already
 * running. Concurrency kept LOW (default 2) to avoid impacting production
 * searches — Qwen runs on a shared GPU.
 *
 * Modes (can combine flags):
 *   --mode authors    : papers with authors = '[]'  AND citation_count >= min-cites
 *   --mode geography  : papers with geography IS NULL or geography = '{}'
 *   --mode both       : papers missing EITHER authors OR geography
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-metadata-qwen.mjs --mode authors --min-cites 50
 *   node --env-file=.env scripts/backfill-metadata-qwen.mjs --mode geography --min-cites 0
 *   node --env-file=.env scripts/backfill-metadata-qwen.mjs --mode both --min-cites 20 --limit 2000
 *   node --env-file=.env scripts/backfill-metadata-qwen.mjs --mode authors --dry-run
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i+1] ? args[i+1] : fallback; };
const DRY_RUN    = args.includes('--dry-run');
const MODE       = flag('--mode', 'both');          // authors | geography | geography-infer | both
const MIN_CITES  = parseInt(flag('--min-cites', '0'));
const LIMIT      = parseInt(flag('--limit', '0')) || Infinity;
const CONCURRENCY = parseInt(flag('--concurrency', '2')); // keep low for shared GPU
const SLEEP_MS   = parseInt(flag('--sleep-ms', '1500'));   // ~0.7 Qwen req/s per slot
const MODEL      = 'qwen2.5:14b-synthesis';
const PROGRESS   = 'reports/qwen-metadata-progress.json';

const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY  = process.env.LLM_API_KEY;
if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function writeProgress(data) {
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(PROGRESS, JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2));
}

async function callQwen(prompt) {
  const res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Qwen ${res.status}: ${await res.text().slice(0,100)}`);
  const d = await res.json();
  const text = (d.choices?.[0]?.message?.content || '').trim();
  // Extract JSON from response (may have markdown fences)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response: ' + text.slice(0,100));
  return JSON.parse(match[0]);
}

async function recallMetadata(paper, needsAuthors, needsGeo) {
  const needsAbstract = !paper.abstract;
  const parts = [];
  if (needsAuthors)  parts.push('1. AUTHORS: Full author names (["Last, First", ...]) — null if uncertain');
  if (needsAbstract) parts.push('2. ABSTRACT: The paper\'s real abstract text — null if not certain');
  if (needsGeo)      parts.push('3. GEOGRAPHY: Countries/regions this paper studies (["Mexico", "Brazil"]) — [] if global/theoretical');

  const prompt = `You have knowledge of academic papers from your training data.

Paper:
Title: ${paper.title}
Year: ${paper.year || 'unknown'}
Venue: ${paper.venue || 'unknown'}
DOI: ${paper.id}
${paper.abstract ? 'Abstract: ' + paper.abstract.slice(0, 300) : ''}

Recall from your training data:
${parts.join('\n')}

RULES:
- Only return what you are CERTAIN about
- For authors: list all if you know the paper; null if even slightly uncertain
- For geography: countries/regions the STUDY covers, not author affiliations; [] for global
- confidence: "high" only if you clearly recognise this paper

JSON response only (no markdown):
{
  "authors": [...] or null,
  ${needsAbstract ? '"abstract": "..." or null,' : ''}
  "geography": [...],
  "confidence": "high" or "low" or "unknown"
}`;

  try { return await callQwen(prompt); }
  catch (e) { return { authors: null, geography: [], confidence: 'unknown', error: e.message }; }
}

async function inferGeography(paper) {
  // Infer geography from the paper's OWN text (title + abstract + venue).
  // Does NOT require training-data recall — Qwen reads the provided text.
  // Always returns confidence="high" since it's reading real text, not guessing.
  const prompt = `Extract the geographic focus of this academic paper from its title and abstract.

Title: ${paper.title}
Year: ${paper.year || 'unknown'}
Venue: ${paper.venue || 'unknown'}
${paper.abstract ? 'Abstract: ' + paper.abstract.slice(0, 800) : ''}

Identify countries, regions, or cities that this paper STUDIES (not where the authors are from).
Examples: ["Brazil"], ["Mexico", "Colombia"], ["Latin America"], ["Sub-Saharan Africa"], ["United States"]
If the paper is global/cross-country/theoretical with no specific geographic focus, return [].

JSON only (no markdown):
{ "geography": ["Country1", "Region1"] or [] }`;

  try {
    const result = await callQwen(prompt);
    return { geography: result.geography || [], confidence: 'high' };
  } catch (e) {
    return { geography: [], confidence: 'unknown', error: e.message };
  }
}

async function loadTargets() {
  const rows = [];
  let from = 0;
  const needsAuthors = MODE === 'authors' || MODE === 'both';
  const needsGeo     = MODE === 'geography' || MODE === 'both' || MODE === 'geography-infer';
  const geoInferOnly = MODE === 'geography-infer';

  while (rows.length < LIMIT) {
    let q = sb.from('works')
      .select('id, title, year, venue, abstract, geography, citation_count, raw_data')
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .order('citation_count', { ascending: false, nullsFirst: false })
      .range(from, from + 999);

    if (MIN_CITES > 0) q = q.gte('citation_count', MIN_CITES);

    if (geoInferOnly) {
      // Geography inference from abstract — requires abstract to be present
      q = q.is('geography', null).not('abstract', 'is', null);
    } else if (needsAuthors && needsGeo) {
      q = q.or('authors.eq.[],geography.is.null');
    } else if (needsAuthors) {
      q = q.filter('authors', 'eq', '[]');
    } else {
      q = q.is('geography', null);
    }

    const { data, error } = await q;
    if (error || !data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
    process.stdout.write(`\r  loading ${rows.length}...`);
  }
  return rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
}

async function main() {
  console.log(`\n=== Qwen metadata recall ===`);
  console.log(`Model: ${MODEL} | Mode: ${MODE} | Min cites: ${MIN_CITES} | Concurrency: ${CONCURRENCY} | Sleep: ${SLEEP_MS}ms | DryRun: ${DRY_RUN}\n`);

  const targets = await loadTargets();
  process.stdout.write('\n');
  console.log(`Targets: ${targets.length} papers`);
  if (DRY_RUN || targets.length === 0) {
    if (DRY_RUN) console.log('Dry run — no writes.');
    return;
  }

  const needsAuthors = MODE === 'authors' || MODE === 'both';
  const needsGeo     = MODE === 'geography' || MODE === 'both' || MODE === 'geography-infer';
  const geoInferOnly = MODE === 'geography-infer';

  let authFilled = 0, absFilled = 0, geoFilled = 0, skipped = 0, errors = 0;
  const start = Date.now();
  writeProgress({ phase: 'running', total: targets.length, authFilled: 0, geoFilled: 0 });

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (paper) => {
      const paperNeedsAuthors = needsAuthors && (!paper.authors || paper.authors.length === 0 || JSON.stringify(paper.authors) === '[]');
      const paperNeedsGeo     = needsGeo && (!paper.geography || paper.geography.length === 0);
      if (!paperNeedsAuthors && !paperNeedsGeo) { skipped++; return; }

      try {
        // Geography-infer mode: read from paper's own text (no recall needed)
        // Other modes: recall from training data
        const result = geoInferOnly
          ? await inferGeography(paper)
          : await recallMetadata(paper, paperNeedsAuthors, paperNeedsGeo);
        if (result.confidence !== 'high') { skipped++; return; }

        const patch = {};
        if (paperNeedsAuthors && Array.isArray(result.authors) && result.authors.length >= 1) {
          patch.authors = result.authors;
        }
        // NOTE: abstract recall REMOVED 2026-07-15 — abstracts are retrieved
        // text, never generated (see header). result.abstract is ignored.
        if (paperNeedsGeo && Array.isArray(result.geography)) {
          patch.geography = result.geography; // save even if empty — means "global"
        }

        if (Object.keys(patch).length === 0) { skipped++; return; }

        const existingRaw = paper.raw_data || {};
        if (patch.authors)   existingRaw.author_source   = 'qwen_recall';
        if (patch.geography !== undefined) existingRaw.geography_source = 'qwen_recall';
        patch.raw_data = existingRaw;

        const { error } = await sb.from('works').update(patch).eq('id', paper.id);
        if (error) { errors++; return; }

        if (patch.authors)             authFilled++;
        if (patch.geography !== undefined) geoFilled++;
      } catch (e) {
        errors++;
      }
    }));

    await sleep(SLEEP_MS);

    const elapsed = (Date.now() - start) / 60000;
    const rate = Math.round((i + batch.length) / Math.max(elapsed, 0.01));
    process.stdout.write(
      `\r  ${i+batch.length}/${targets.length} | authors ${authFilled} | abstracts ${absFilled} | geo ${geoFilled} | skip ${skipped} | err ${errors} | ${rate}/min`
    );
    if ((i + CONCURRENCY) % 50 < CONCURRENCY) {
      writeProgress({ phase: 'running', processed: i+batch.length, total: targets.length,
        authFilled, absFilled, geoFilled, skipped, errors, rate_per_min: rate });
    }
  }

  process.stdout.write('\n');
  const summary = { authFilled, absFilled, geoFilled, skipped, errors,
    total: targets.length, mode: MODE, min_cites: MIN_CITES,
    elapsed_min: Math.round((Date.now()-start)/60000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  writeProgress({ phase: 'complete', ...summary });
  const today = new Date().toISOString().slice(0,10);
  fs.writeFileSync(`reports/qwen-metadata-${today}.json`, JSON.stringify({ summary }, null, 2));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
