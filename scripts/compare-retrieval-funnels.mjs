#!/usr/bin/env node
/**
 * Compare full retrieval funnels for the same query under foundational vs causal channels.
 * Requires the edge function to be deployed with includeSelectionPool support.
 *
 * Usage:  node scripts/compare-retrieval-funnels.mjs
 *
 * Set SUPABASE_URL / SUPABASE_ANON_KEY in env or .env.local, or it defaults
 * to the local self-hosted stack.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.txt if present
for (const name of ['.env.txt', '.env.local', '.env']) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch {}
}

const BASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:8000';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const QUERY = 'what is the impact of student learning outcomes';

async function search(channel) {
  console.log(`\nRunning ${channel} search...`);
  const res = await fetch(`${BASE_URL}/functions/v1/api/search-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify({
      query: QUERY,
      filters: {},
      channels: [channel],
      includeSelectionPool: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${channel} search failed ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

(async () => {
  let foundational, causal;
  try {
    [foundational, causal] = await Promise.all([
      search('foundational'),
      search('causal'),
    ]);
  } catch (err) {
    console.error('Search failed:', err.message);
    process.exit(1);
  }

  const fPool = foundational.selectionPool ?? [];
  const cPool = causal.selectionPool ?? [];

  if (!fPool.length || !cPool.length) {
    console.error('selectionPool missing — deploy the edge function first.');
    process.exit(1);
  }

  const fIds = new Set(fPool.map(p => p.id));
  const cIds = new Set(cPool.map(p => p.id));
  const fEvidenceIds = new Set(fPool.filter(p => p.inFinalEvidence).map(p => p.id));
  const cEvidenceIds = new Set(cPool.filter(p => p.inFinalEvidence).map(p => p.id));

  const overlap200 = fPool.filter(p => cIds.has(p.id));
  const fOnly200   = fPool.filter(p => !cIds.has(p.id));
  const cOnly200   = cPool.filter(p => !fIds.has(p.id));

  console.log('\n========== SELECTION POOL (top-200) ==========');
  console.log(`Foundational pool size: ${fPool.length}`);
  console.log(`Causal pool size:       ${cPool.length}`);
  console.log(`Overlap in pool:        ${overlap200.length}`);
  console.log(`Foundational-only:      ${fOnly200.length}`);
  console.log(`Causal-only:            ${cOnly200.length}`);

  // Final evidence overlap
  const fEv = [...fEvidenceIds];
  const cEv = [...cEvidenceIds];
  const overlapEv = fEv.filter(id => cEvidenceIds.has(id));
  console.log('\n========== FINAL EVIDENCE (top-100) ==========');
  console.log(`Overlap in final 100:   ${overlapEv.length}`);
  console.log(`Foundational-only:      ${fEv.filter(id => !cEvidenceIds.has(id)).length}`);
  console.log(`Causal-only:            ${cEv.filter(id => !fEvidenceIds.has(id)).length}`);

  // Papers in foundational pool but not causal pool — show with scores
  console.log('\n========== FOUNDATIONAL POOL ONLY (not in causal top-200) ==========');
  for (const p of fOnly200.sort((a, b) => (b._compositeScore ?? 0) - (a._compositeScore ?? 0))) {
    const inEv = fEvidenceIds.has(p.id) ? '✓EV' : '    ';
    console.log(`  ${inEv} [${String(p.sms_level ?? '?').padStart(1)}] score=${String(p._compositeScore ?? '?').padEnd(7)} src=${String(p._retrievalSource ?? '?').padEnd(22)} ${p.year} ${p.methodology_design?.padEnd(22) ?? '?'.padEnd(22)} ${p.title?.slice(0, 70)}`);
  }

  console.log('\n========== CAUSAL POOL ONLY (not in foundational top-200) ==========');
  for (const p of cOnly200.sort((a, b) => (b._compositeScore ?? 0) - (a._compositeScore ?? 0))) {
    const inEv = cEvidenceIds.has(p.id) ? '✓EV' : '    ';
    console.log(`  ${inEv} [${String(p.sms_level ?? '?').padStart(1)}] score=${String(p._compositeScore ?? '?').padEnd(7)} src=${String(p._retrievalSource ?? '?').padEnd(22)} ${p.year} ${p.methodology_design?.padEnd(22) ?? '?'.padEnd(22)} ${p.title?.slice(0, 70)}`);
  }

  // Papers in both pools but different final-evidence fate
  console.log('\n========== IN BOTH POOLS BUT DIFFERENT FINAL-100 OUTCOME ==========');
  for (const p of overlap200) {
    const inF = fEvidenceIds.has(p.id);
    const inC = cEvidenceIds.has(p.id);
    if (inF === inC) continue;
    const cp = cPool.find(x => x.id === p.id);
    console.log(`  F:${inF ? '✓' : '✗'} C:${inC ? '✓' : '✗'}  SMS=${p.sms_level} fScore=${p._compositeScore} cScore=${cp?._compositeScore}  ${p.title?.slice(0, 80)}`);
  }

  // Save full pools to JSON for deeper analysis
  const out = {
    query: QUERY,
    foundationalPool: fPool,
    causalPool: cPool,
  };
  const outPath = path.join(__dirname, '..', 'reports', 'funnel-comparison.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nFull pools saved to reports/funnel-comparison.json`);
})();
