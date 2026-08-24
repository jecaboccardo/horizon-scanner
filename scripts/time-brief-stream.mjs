#!/usr/bin/env node
/**
 * Measure exactly where brief-generation latency goes by hitting the prod
 * SSE endpoint and timestamping each event.
 *
 * Outputs:
 *   T+Xs   event      (delta from previous event, total since start)
 *
 * Phases worth tracking:
 *   open       — fetch started, status OK
 *   phase1     — deterministic brief landed (retrieval done)
 *   chunk(N)   — Nth Gemini chunk arrived (typically 1 chunk for non-stream)
 *   done       — final brief persisted, SSE done event
 *   verified   — Qwen verifier post-done correction (if any)
 *   close      — stream closed
 *
 * Usage:
 *   node scripts/time-brief-stream.mjs <search_run_id>
 *   node scripts/time-brief-stream.mjs <search_run_id> --persona jel
 *
 * Tip: create a search run first via the UI or POST /api/search-runs,
 * then pass its ID here.
 */

import { config } from 'dotenv';
config();

const args = process.argv.slice(2);
const searchRunId = args[0];
const personaIdx = args.indexOf('--persona');
const persona = personaIdx >= 0 ? args[personaIdx + 1] : 'jel';

if (!searchRunId) {
  console.error('Usage: node scripts/time-brief-stream.mjs <search_run_id> [--persona X]');
  process.exit(1);
}

// Use production VPS endpoint (same path the UI hits).
const API_BASE = process.env.PROD_API_BASE || 'http://localhost:3002';
const TENANT = process.env.VITE_DEFAULT_TENANT_ID || 'iadb-demo';

const url = `${API_BASE}/api/briefs/stream?searchRunId=${encodeURIComponent(searchRunId)}&persona=${persona}`;

console.log(`Streaming: ${url}\n`);

const t0 = Date.now();
let tPrev = t0;

function ts(label, extra = '') {
  const now = Date.now();
  const total = ((now - t0) / 1000).toFixed(2);
  const delta = ((now - tPrev) / 1000).toFixed(2);
  tPrev = now;
  console.log(`T+${total.padStart(6)}s  (+${delta.padStart(5)}s)  ${label}  ${extra}`);
}

const response = await fetch(url, {
  headers: {
    'x-tenant-id': TENANT,
    Accept: 'text/event-stream',
  },
});

ts('open', `status=${response.status}`);

if (!response.ok) {
  console.error('  Response not OK:', await response.text());
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let chunkCount = 0;
let totalChunkChars = 0;

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
        const sections = data.sections || {};
        extra = `evidenceRows=${sections.evidenceRows?.length || 0}`;
      } else if (eventType === 'chunk') {
        chunkCount += 1;
        totalChunkChars += (data.text || '').length;
        extra = `len=${data.text?.length || 0} totalChars=${totalChunkChars}`;
      } else if (eventType === 'verified') {
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

console.log('\nSummary:');
console.log(`  Total wall time: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
console.log(`  Gemini chunks:   ${chunkCount}`);
console.log(`  Total chars:     ${totalChunkChars.toLocaleString()}`);
