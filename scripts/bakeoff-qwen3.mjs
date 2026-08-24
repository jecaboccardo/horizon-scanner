/**
 * Embedding bakeoff: qwen3-embedding:8b (4096 dims) vs nomic-embed-text (768 dims)
 *
 * Phase 1 — Embed: samples 20k papers, embeds with qwen3, stores in works_bakeoff_qwen3.
 * Phase 2 — Eval:  for each gold query, runs exact cosine search with BOTH models
 *                  on the same 20k paper slice, scores against evals/queries.json.
 *
 * Usage:
 *   node scripts/bakeoff-qwen3.mjs embed          # Phase 1: embed papers
 *   node scripts/bakeoff-qwen3.mjs eval           # Phase 2: compare on gold queries
 *   node scripts/bakeoff-qwen3.mjs embed --limit=5000   # smaller test run
 *
 * Prereq: apply migration 20260513000004_bakeoff_qwen3_table.sql first.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const EVALS_PATH = join(__dir, '../evals/queries.json');
const PROGRESS_PATH = join(__dir, '../reports/bakeoff-qwen3-progress.json');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;

const QWEN3_MODEL = 'qwen3-embedding:8b';
const NOMIC_MODEL = 'nomic-embed-text-vllm';

const BATCH_SIZE   = 8;     // qwen3 is heavy — keep batches small
const PAPER_LIMIT  = 20000;
const EVAL_MATCH_COUNT  = 50;
const EVAL_THRESHOLD    = 0.25;  // low threshold — qwen3 distributes differently

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

async function embedBatch(texts, model) {
  const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}) },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embed ${model} HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`embed ${model}: ${json.error.message}`);
  return json.data.map(d => d.embedding);
}

async function embedSingle(text, model) {
  const vecs = await embedBatch([text], model);
  return vecs[0];
}

function buildText(paper) {
  return [paper.title, paper.abstract].filter(Boolean).join(' ').slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Phase 1: Embed
// ---------------------------------------------------------------------------

async function runEmbed(limit) {
  console.log(`\n=== PHASE 1: Embed ${limit} papers with ${QWEN3_MODEL} ===\n`);

  // Already embedded?
  const { count: doneCount } = await sb
    .from('works_bakeoff_qwen3')
    .select('id', { count: 'exact', head: true });
  console.log(`Already embedded: ${doneCount ?? 0}`);

  const doneIds = new Set();
  if (doneCount > 0) {
    let off = 0;
    while (true) {
      const { data: done } = await sb.from('works_bakeoff_qwen3').select('id').range(off, off + 999);
      if (!done?.length) break;
      done.forEach(r => doneIds.add(r.id));
      if (done.length < 1000) break;
      off += 1000;
    }
  }

  // Sample papers — prioritise high quality + gold query canaries
  const evals = JSON.parse(readFileSync(EVALS_PATH, 'utf8'));
  const canaryDois = evals.queries.flatMap(q =>
    (q.canary_papers ?? []).filter(c => c.doi_hint).map(c => c.doi_hint)
  );
  const labeledDois = evals.queries.flatMap(q =>
    Object.values(q.labels ?? {}).filter(e => e.doi).map(e => e.doi)
  );
  const priorityDois = [...new Set([...canaryDois, ...labeledDois])];

  // First: priority papers from gold queries
  let priorityRows = [];
  if (priorityDois.length > 0) {
    const { data } = await sb.from('works')
      .select('id, title, abstract, canonical_doi')
      .in('canonical_doi', priorityDois)
      .not('embedding', 'is', null);
    priorityRows = data ?? [];
    console.log(`Priority papers (gold query labeled/canary): ${priorityRows.length}`);
  }

  // Then: high-quality fill to reach limit — paginate past PostgREST 1000-row cap
  const PAGE = 1000;
  const fillRows = [];
  const fillTarget = limit + priorityRows.length;
  let offset = 0;
  while (fillRows.length < fillTarget) {
    const { data: page } = await sb.from('works')
      .select('id, title, abstract')
      .not('embedding', 'is', null)
      .gte('year', 2010)
      .or('sms_level.gte.2,sms_level.is.null')
      .order('citation_count', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (!page?.length) break;
    fillRows.push(...page);
    offset += PAGE;
    if (page.length < PAGE) break;
  }

  const priorityIds = new Set(priorityRows.map(r => r.id));
  const papers = [
    ...priorityRows,
    ...(fillRows ?? []).filter(r => !priorityIds.has(r.id)),
  ].slice(0, limit);

  console.log(`Total to embed: ${papers.length} (${papers.filter(p => !doneIds.has(p.id)).length} new)\n`);

  const todo = papers.filter(p => !doneIds.has(p.id));
  let done = 0, errors = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const texts = batch.map(buildText);
    try {
      const t0 = Date.now();
      const vecs = await embedBatch(texts, QWEN3_MODEL);
      const ms = Date.now() - t0;

      const rows = batch.map((p, j) => ({ id: p.id, embedding: vecs[j] }));
      const { error } = await sb.from('works_bakeoff_qwen3').upsert(rows, { onConflict: 'id' });
      if (error) { console.error(`  qwen3 insert error batch ${i}: ${error.message}`); errors++; continue; }

      // Also store nomic embeddings (fetch from works.embedding for same papers)
      const { data: nomicRows } = await sb.from('works').select('id, embedding').in('id', batch.map(p=>p.id));
      if (nomicRows?.length) {
        const nomicInsert = nomicRows.filter(r => r.embedding).map(r => ({ id: r.id, embedding: r.embedding }));
        if (nomicInsert.length) {
          await sb.from('works_bakeoff_nomic').upsert(nomicInsert, { onConflict: 'id' });
        }
      }

      done += batch.length;
      if (done % 200 === 0 || i === 0) {
        const pct = ((done / todo.length) * 100).toFixed(1);
        const eta = Math.round(((todo.length - done) / batch.length) * ms / 1000);
        process.stdout.write(`  ${done}/${todo.length} (${pct}%) — ${ms}ms/batch — ETA ${eta}s\r`);
      }
    } catch (err) {
      console.error(`\n  embed error batch ${i}: ${err.message}`);
      errors++;
      if (errors > 10) { console.error('Too many errors, stopping.'); break; }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`\n\nDone. Embedded: ${done}, Errors: ${errors}`);

  // Save bakeoff paper ID list for eval phase
  const { data: allEmbedded } = await sb.from('works_bakeoff_qwen3').select('id');
  const ids = (allEmbedded ?? []).map(r => r.id);
  writeFileSync(PROGRESS_PATH, JSON.stringify({ ids, embeddedAt: new Date().toISOString() }));
  console.log(`Saved ${ids.length} bakeoff IDs to ${PROGRESS_PATH}`);
}

// ---------------------------------------------------------------------------
// Phase 2: Eval
// ---------------------------------------------------------------------------

function normalizeDoi(doi) {
  if (!doi) return null;
  return doi.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}
function normalizeTitle(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}

function scoreResults(papers, goldQuery) {
  const labels = goldQuery.labels ?? {};
  const canaries = goldQuery.canary_papers ?? [];
  const doiToLabel = {};
  for (const e of Object.values(labels)) {
    if (e.doi) doiToLabel[normalizeDoi(e.doi)] = e.label;
  }
  const canaryByDoi   = new Map(canaries.filter(c=>c.doi_hint).map(c=>[normalizeDoi(c.doi_hint),c]));
  const canaryByTitle = new Map(canaries.filter(c=>c.title).map(c=>[normalizeTitle(c.title),c]));

  const top20 = papers.slice(0, 20);
  const dist = { relevant: 0, partial: 0, irrelevant: 0, unlabeled: 0 };
  for (const p of top20) {
    const key = normalizeDoi(p.canonical_doi);
    const label = key ? doiToLabel[key] : undefined;
    if      (label === 'relevant')   dist.relevant++;
    else if (label === 'partial')    dist.partial++;
    else if (label === 'irrelevant') dist.irrelevant++;
    else                             dist.unlabeled++;
  }

  const top50 = papers.slice(0, 50);
  const canaryHitIds = new Set();
  for (const p of top50) {
    const doi = normalizeDoi(p.canonical_doi);
    const ttl = normalizeTitle(p.title);
    if (doi && canaryByDoi.has(doi))   canaryHitIds.add(canaryByDoi.get(doi).id);
    if (ttl && canaryByTitle.has(ttl)) canaryHitIds.add(canaryByTitle.get(ttl).id);
  }

  return {
    dist,
    precision20: dist.relevant / 20,
    recall20:    (dist.relevant + dist.partial) / 20,
    canaryHits:  canaryHitIds.size,
    canaryTotal: canaries.length,
  };
}

function pctile(arr, p) {
  const sorted = [...arr].sort((a,b)=>a-b);
  return sorted[Math.floor((p/100)*(sorted.length-1))] ?? sorted[sorted.length-1];
}

async function runEval() {
  console.log('\n=== PHASE 2: Eval — qwen3 vs nomic on 20k bakeoff slice ===\n');

  if (!existsSync(PROGRESS_PATH)) {
    console.error('Run embed phase first: node scripts/bakeoff-qwen3.mjs embed');
    process.exit(1);
  }
  const { ids: bakeoffIds } = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  console.log(`Bakeoff slice: ${bakeoffIds.length} papers\n`);

  const evals = JSON.parse(readFileSync(EVALS_PATH, 'utf8'));
  const RUNS = 3;

  const results = {};

  for (const query of evals.queries) {
    console.log(`▸ Query: ${query.id}`);
    console.log(`  "${query.query}"`);

    // Embed query with both models in parallel
    process.stdout.write('  Embedding... ');
    const [qwenVec, nomicVec] = await Promise.all([
      embedSingle(query.query, QWEN3_MODEL),
      embedSingle(`search_query: ${query.query}`, NOMIC_MODEL),
    ]);
    console.log(`done (qwen3=${qwenVec.length}d nomic=${nomicVec.length}d)`);

    const qResults = {};

    // qwen3 search
    const qwenLatencies = [];
    let qwenPapers;
    for (let r = 0; r < RUNS; r++) {
      const t0 = Date.now();
      const { data, error } = await sb.rpc('search_bakeoff_qwen3', {
        query_embedding: qwenVec,
        match_threshold: EVAL_THRESHOLD,
        match_count: EVAL_MATCH_COUNT,
        restrict_ids: bakeoffIds,
      });
      qwenLatencies.push(Date.now() - t0);
      if (error) { console.error('  qwen3 error:', error.message); break; }
      qwenPapers = data ?? [];
    }

    // nomic search (restricted to same bakeoff IDs)
    const nomicLatencies = [];
    let nomicPapers;
    for (let r = 0; r < RUNS; r++) {
      const t0 = Date.now();
      const { data, error } = await sb.rpc('search_bakeoff_nomic', {
        query_embedding: nomicVec,
        match_threshold: EVAL_THRESHOLD,
        match_count: EVAL_MATCH_COUNT,
        restrict_ids: bakeoffIds,
      });
      nomicLatencies.push(Date.now() - t0);
      if (error) { console.error('  nomic error:', error.message); break; }
      nomicPapers = data ?? [];
    }

    const qwenScore  = scoreResults(qwenPapers  ?? [], query);
    const nomicScore = scoreResults(nomicPapers ?? [], query);

    results[query.id] = {
      qwen3: { score: qwenScore,  p50: pctile(qwenLatencies, 50),  p95: pctile(qwenLatencies, 95),  returned: (qwenPapers ?? []).length },
      nomic: { score: nomicScore, p50: pctile(nomicLatencies, 50), p95: pctile(nomicLatencies, 95), returned: (nomicPapers ?? []).length },
    };

    console.log(`  qwen3: Rel=${qwenScore.dist.relevant} Part=${qwenScore.dist.partial} Irr=${qwenScore.dist.irrelevant} Canary=${qwenScore.canaryHits}/${qwenScore.canaryTotal} p50=${results[query.id].qwen3.p50}ms returned=${results[query.id].qwen3.returned}`);
    console.log(`  nomic: Rel=${nomicScore.dist.relevant} Part=${nomicScore.dist.partial} Irr=${nomicScore.dist.irrelevant} Canary=${nomicScore.canaryHits}/${nomicScore.canaryTotal} p50=${results[query.id].nomic.p50}ms returned=${results[query.id].nomic.returned}`);
    console.log();
  }

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  console.log('='.repeat(90));
  console.log('BAKEOFF RESULTS: qwen3-embedding:8b vs nomic-embed-text (same 20k paper slice)');
  console.log('='.repeat(90));

  const header = ['Query', 'Model', 'Rel@20', 'Part@20', 'Irr@20', 'Prec@20', 'Recall@20', 'Canary@50', 'p50ms', 'Returned'];
  const rows = [];
  let qTotRel=0,qTotPart=0,qTotIrr=0,qTotCan=0,qTotCanMax=0,qLatencies=[];
  let nTotRel=0,nTotPart=0,nTotIrr=0,nTotCan=0,nTotCanMax=0,nLatencies=[];

  for (const q of evals.queries) {
    const r = results[q.id];
    if (!r) continue;
    for (const [model, key] of [['qwen3', 'qwen3'], ['nomic', 'nomic']]) {
      const d = r[key];
      rows.push([
        key === 'qwen3' ? q.id.slice(0,30) : '',
        model,
        d.score.dist.relevant,
        d.score.dist.partial,
        d.score.dist.irrelevant,
        `${(d.score.precision20*100).toFixed(0)}%`,
        `${(d.score.recall20*100).toFixed(0)}%`,
        `${d.score.canaryHits}/${d.score.canaryTotal}`,
        d.p50,
        d.returned,
      ]);
    }
    qTotRel+=r.qwen3.score.dist.relevant; qTotPart+=r.qwen3.score.dist.partial; qTotIrr+=r.qwen3.score.dist.irrelevant;
    qTotCan+=r.qwen3.score.canaryHits; qTotCanMax+=r.qwen3.score.canaryTotal; qLatencies.push(r.qwen3.p50);
    nTotRel+=r.nomic.score.dist.relevant; nTotPart+=r.nomic.score.dist.partial; nTotIrr+=r.nomic.score.dist.irrelevant;
    nTotCan+=r.nomic.score.canaryHits; nTotCanMax+=r.nomic.score.canaryTotal; nLatencies.push(r.nomic.p50);
  }

  const widths = header.map((h,i)=>Math.max(h.length,...rows.map(r=>String(r[i]??'').length))+2);
  const fmt = row => row.map((v,i)=>String(v??'').padEnd(widths[i])).join('| ');
  console.log(fmt(header));
  console.log(widths.map(w=>'-'.repeat(w)).join('+-'));
  for (const row of rows) console.log(fmt(row));

  console.log('\nSUMMARY ACROSS ALL QUERIES:');
  console.log(`  qwen3: Rel=${qTotRel} Part=${qTotPart} Irr=${qTotIrr} Canary=${qTotCan}/${qTotCanMax} AvgP50=${Math.round(qLatencies.reduce((a,b)=>a+b)/qLatencies.length)}ms`);
  console.log(`  nomic: Rel=${nTotRel} Part=${nTotPart} Irr=${nTotIrr} Canary=${nTotCan}/${nTotCanMax} AvgP50=${Math.round(nLatencies.reduce((a,b)=>a+b)/nLatencies.length)}ms`);

  const winner = qTotRel + qTotPart >= nTotRel + nTotPart ? 'qwen3' : 'nomic';
  const margin = Math.abs((qTotRel+qTotPart) - (nTotRel+nTotPart));
  console.log(`\nWinner (Rel+Part): ${winner} (margin: ${margin} papers in top-20 across 3 queries)`);

  if (winner === 'qwen3') {
    console.log('\n→ If qwen3 wins materially (margin >= 4), plan full corpus re-embed:');
    console.log('   1. Schema migration: ALTER TABLE works ADD COLUMN embedding_qwen3 vector(4096)');
    console.log('   2. Backfill all 622k papers (estimate ~2 days at current throughput)');
    console.log('   3. Update embeddingClient.ts to use QWEN3_MODEL + 4096 dims');
    console.log('   4. Update match_works / match_works_v2 function signatures');
  }

  // Save results
  const outPath = join(__dir, '../reports/bakeoff-qwen3-results.json');
  writeFileSync(outPath, JSON.stringify({ results, summary: { qwen3: {totRel:qTotRel,totPart:qTotPart,totIrr:qTotIrr,canary:`${qTotCan}/${qTotCanMax}`}, nomic: {totRel:nTotRel,totPart:nTotPart,totIrr:nTotIrr,canary:`${nTotCan}/${nTotCanMax}`} }, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const phase = process.argv[2] ?? 'embed';
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : PAPER_LIMIT;

if (phase === 'embed') {
  runEmbed(limit).catch(e => { console.error(e); process.exit(1); });
} else if (phase === 'eval') {
  runEval().catch(e => { console.error(e); process.exit(1); });
} else {
  console.error('Usage: node scripts/bakeoff-qwen3.mjs [embed|eval] [--limit=N]');
  process.exit(1);
}
