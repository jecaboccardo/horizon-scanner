#!/usr/bin/env node
/**
 * End-to-end brief-generation latency bench.
 *
 * 1. POST /api/search-runs to create a fresh run with the given query.
 * 2. Open SSE stream at /api/briefs/stream and timestamp every event.
 * 3. Print phase-by-phase deltas + total wall time.
 *
 * Usage:
 *   node scripts/perf-bench-brief.mjs "What does high-quality evidence say about AI and labor in Latin America?"
 *   node scripts/perf-bench-brief.mjs "<query>" --persona jel --tenant iadb-demo
 *
 * Hits prod by default. Override with PROD_API_BASE env var.
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
config();

// Quality-drift baseline: persist evidence work IDs per query+config and
// compare each run against the saved baseline.
const _scriptDir = decodeURIComponent(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]:)/, '$1');
const BASELINE_DIR = join(_scriptDir, '..', 'evals', 'baselines');

function baselinePath(query, bodyOverrides) {
  const key = createHash('sha1').update(JSON.stringify({ query, bodyOverrides })).digest('hex').slice(0, 12);
  return join(BASELINE_DIR, `${key}.json`);
}

function loadBaseline(query, bodyOverrides) {
  const p = baselinePath(query, bodyOverrides);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function saveBaseline(query, bodyOverrides, run) {
  const p = baselinePath(query, bodyOverrides);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    query,
    bodyOverrides,
    savedAt: new Date().toISOString(),
    candidateCount: run.candidateWorkIds?.length || 0,
    evidenceCount: run.evidenceWorkIds?.length || 0,
    evidenceTop20: (run.evidenceWorkIds || []).slice(0, 20),
    evidenceTop100: (run.evidenceWorkIds || []).slice(0, 100),
  }, null, 2));
  return p;
}

function compareToBaseline(baseline, run) {
  const currentTop20 = new Set((run.evidenceWorkIds || []).slice(0, 20));
  const baselineTop20 = new Set(baseline.evidenceTop20 || []);
  const overlap20 = [...currentTop20].filter((id) => baselineTop20.has(id)).length;
  const added20 = [...currentTop20].filter((id) => !baselineTop20.has(id));
  const dropped20 = [...baselineTop20].filter((id) => !currentTop20.has(id));

  const currentTop100 = new Set((run.evidenceWorkIds || []).slice(0, 100));
  const baselineTop100 = new Set(baseline.evidenceTop100 || []);
  const overlap100 = [...currentTop100].filter((id) => baselineTop100.has(id)).length;

  // Rank shift on top-20 papers present in both
  const currentRanks = new Map((run.evidenceWorkIds || []).slice(0, 100).map((id, i) => [id, i + 1]));
  const baselineRanks = new Map((baseline.evidenceTop100 || []).map((id, i) => [id, i + 1]));
  const shifts = [];
  for (const id of baselineTop20) {
    const newRank = currentRanks.get(id);
    if (newRank != null) shifts.push(Math.abs(newRank - baselineRanks.get(id)));
  }
  const avgShift = shifts.length ? (shifts.reduce((a, b) => a + b, 0) / shifts.length).toFixed(1) : 'n/a';

  return {
    candidateCountDelta: (run.candidateWorkIds?.length || 0) - (baseline.candidateCount || 0),
    overlap20, added20, dropped20,
    overlap100,
    avgShift,
  };
}


async function mintAccessToken() {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'horizon-scanner@iadb.org',
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(`generateLink failed: ${linkErr?.message || 'no hashed_token'}`);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: verify, error: verifyErr } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr || !verify?.session?.access_token) {
    throw new Error(`verifyOtp failed: ${verifyErr?.message || 'no access_token'}`);
  }
  return verify.session.access_token;
}

const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--'));
if (!query) {
  console.error('Usage: node scripts/perf-bench-brief.mjs "<query>" [--persona jel] [--tenant iadb-demo]');
  process.exit(1);
}

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const persona = argValue('--persona', 'jel');
const tenant = argValue('--tenant', process.env.VITE_DEFAULT_TENANT_ID || 'iadb-demo');
const API_BASE = process.env.PROD_API_BASE || 'https://v0-horizon-scanner-iadb.vercel.app';

// Retrieval-pipeline differential overrides. Pass --hyde=false to test HyDE
// cost, --cross-encoder=true to add CE, etc.
const bodyOverrides = {};
if (args.includes('--hyde=false')) bodyOverrides.hyde = false;
if (args.includes('--hyde=true')) bodyOverrides.hyde = true;
if (args.includes('--cross-encoder=true')) bodyOverrides.crossEncoder = true;
if (args.includes('--cross-encoder=false')) bodyOverrides.crossEncoder = false;
if (args.includes('--facet-retrieval=true')) bodyOverrides.facetRetrieval = true;
if (args.includes('--facet-retrieval=false')) bodyOverrides.facetRetrieval = false;
const hydeLimitArg = argValue('--hyde-limit', null);
if (hydeLimitArg) bodyOverrides.hydeLimit = Number(hydeLimitArg);
const ceTopNArg = argValue('--ce-top-n', null);
if (ceTopNArg) bodyOverrides.crossEncoderTopN = Number(ceTopNArg);

console.log(`API base: ${API_BASE}`);
console.log(`Tenant:   ${tenant}`);
console.log(`Persona:  ${persona}`);
console.log(`Query:    "${query}"`);
console.log(`Overrides: ${JSON.stringify(bodyOverrides)}\n`);

const accessToken = await mintAccessToken();
const authHeaders = {
  'x-tenant-id': tenant,
  Authorization: `Bearer ${accessToken}`,
};

// ----- Step 1: create search run -----
const t0 = Date.now();
const runRes = await fetch(`${API_BASE}/api/search-runs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({ query, ...bodyOverrides }),
});

const tRunCreated = Date.now();
if (!runRes.ok) {
  console.error(`search-runs failed: ${runRes.status}`);
  console.error(await runRes.text());
  process.exit(1);
}
const run = await runRes.json();
console.log(`T+${((tRunCreated - t0) / 1000).toFixed(2).padStart(6)}s  search-run created  id=${run.id}  candidates=${run.candidateWorkIds?.length || 0}  evidence=${run.evidenceWorkIds?.length || 0}\n`);

if (Array.isArray(run.perfLog) && run.perfLog.length > 0) {
  console.log('Retrieval phase breakdown:');
  for (const p of run.perfLog) {
    console.log(`  ${p.phase.padEnd(26)} dt=${String(p.dt).padStart(6)}ms  total=${String(p.total).padStart(6)}ms  ${p.extra}`);
  }
  console.log();
}

// Quality-drift comparison (vs. baseline).
const saveBaselineFlag = args.includes('--save-baseline');
const baseline = loadBaseline(query, bodyOverrides);
if (saveBaselineFlag) {
  const path = saveBaseline(query, bodyOverrides, run);
  console.log(`Quality baseline SAVED -> ${path}\n`);
} else if (baseline) {
  const diff = compareToBaseline(baseline, run);
  console.log(`Quality drift vs. baseline (saved ${baseline.savedAt}):`);
  console.log(`  Candidate count:  ${baseline.candidateCount} → ${run.candidateWorkIds?.length || 0} (Δ${diff.candidateCountDelta >= 0 ? '+' : ''}${diff.candidateCountDelta})`);
  console.log(`  Top-20 overlap:   ${diff.overlap20}/20  (added: ${diff.added20.length}, dropped: ${diff.dropped20.length})`);
  console.log(`  Top-100 overlap:  ${diff.overlap100}/100`);
  console.log(`  Avg rank shift on shared top-20: ${diff.avgShift} positions`);
  if (diff.added20.length > 0 || diff.dropped20.length > 0) {
    console.log(`  Verdict: ${diff.overlap20 >= 17 ? 'STABLE' : diff.overlap20 >= 14 ? 'MINOR DRIFT' : 'SIGNIFICANT DRIFT'}`);
  } else {
    console.log(`  Verdict: IDENTICAL top-20`);
  }
  console.log();
} else {
  console.log(`No baseline yet for this query+config. Run with --save-baseline to capture one.\n`);
}

// ----- Step 2: stream brief -----
const streamUrl = `${API_BASE}/api/briefs/stream?searchRunId=${encodeURIComponent(run.id)}&persona=${persona}`;
const tStreamStart = Date.now();
let tPrev = tStreamStart;

function ts(label, extra = '') {
  const now = Date.now();
  const total = ((now - tStreamStart) / 1000).toFixed(2);
  const delta = ((now - tPrev) / 1000).toFixed(2);
  tPrev = now;
  console.log(`T+${total.padStart(6)}s  (+${delta.padStart(5)}s)  ${label.padEnd(10)} ${extra}`);
}

const response = await fetch(streamUrl, {
  headers: { ...authHeaders, Accept: 'text/event-stream' },
});
ts('open', `status=${response.status}`);
if (!response.ok) {
  console.error('stream failed:', await response.text());
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let chunkCount = 0;
let totalChunkChars = 0;
let phase1At = null;
let doneAt = null;
let verifiedAt = null;

while (true) {
  const { done, value } = await reader.read();
  if (done) {
    ts('close');
    break;
  }
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split('\n\n');
  buffer = parts.pop() || '';
  for (const part of parts) {
    const eventMatch = part.match(/^event:\s*(.+)$/m);
    const dataMatch = part.match(/^data:\s*(.+)$/m);
    if (!eventMatch || !dataMatch) continue;
    const eventType = eventMatch[1].trim();
    let extra = '';
    try {
      const data = JSON.parse(dataMatch[1]);
      if (eventType === 'phase1') {
        phase1At = Date.now();
        const sections = data.sections || {};
        extra = `evidenceRows=${sections.evidenceRows?.length || 0}`;
      } else if (eventType === 'chunk') {
        chunkCount += 1;
        totalChunkChars += (data.text || '').length;
        extra = `len=${data.text?.length || 0} total=${totalChunkChars}`;
      } else if (eventType === 'done') {
        doneAt = Date.now();
      } else if (eventType === 'verified') {
        verifiedAt = Date.now();
        extra = `meth=${!!data.methodologyNote} gap=${!!data.gapSummary}`;
      } else if (eventType === 'error') {
        extra = data.error || '';
      }
    } catch {
      extra = '(parse-err)';
    }
    ts(eventType, extra);
  }
}

// ----- Summary -----
const totalWall = (Date.now() - t0) / 1000;
const runTime = (tRunCreated - t0) / 1000;
const streamTime = (Date.now() - tStreamStart) / 1000;
const phase1Time = phase1At ? (phase1At - tStreamStart) / 1000 : null;
const doneTime = doneAt ? (doneAt - tStreamStart) / 1000 : null;
const verifiedTime = verifiedAt ? (verifiedAt - tStreamStart) / 1000 : null;

console.log('\n========== Summary ==========');
console.log(`Total wall time:       ${totalWall.toFixed(2)}s`);
console.log(`  search-run create:   ${runTime.toFixed(2)}s`);
console.log(`  stream total:        ${streamTime.toFixed(2)}s`);
if (phase1Time != null) console.log(`    phase1 (table):    ${phase1Time.toFixed(2)}s`);
if (doneTime != null)   console.log(`    done (Gemini):     ${doneTime.toFixed(2)}s`);
if (verifiedTime != null) console.log(`    verified (Qwen):   ${verifiedTime.toFixed(2)}s`);
console.log(`Gemini chunks:         ${chunkCount}`);
console.log(`Total response chars:  ${totalChunkChars.toLocaleString()}`);
