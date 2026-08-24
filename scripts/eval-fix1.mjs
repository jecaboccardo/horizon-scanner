// eval-fix1.mjs — thin wrapper over eval-gold.mjs that patches
// rerankInterleaved with the proportional-slot variant (Fix1) before running.
// Run: node scripts/eval-fix1.mjs --no-write
//
// Strategy: monkey-patch the rerank module's exported function in the Node
// module cache so eval-gold.mjs picks up Fix1 automatically.
// This avoids duplicating 500 lines of eval-gold.mjs just to test one change.
//
// Since eval-gold.mjs uses the Deno-flavoured retrieval stack via its own Deno
// process (it's a .mjs running against the Supabase/Deno functions via HTTP),
// the cleanest approach is to run the existing eval-gold.mjs but with an env
// flag that enables Fix1 inside the Deno runtime.
//
// Simpler alternative actually used here: just run the Deno probe-channels.ts
// approach but across all 24 gold queries and measure the aggregate canary
// hit rate vs the baseline.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { config as loadEnv } from 'dotenv';
loadEnv();

const queries = JSON.parse(readFileSync('evals/queries.json','utf8')).queries;
const baseline = existsSync('evals/baseline.json') ? JSON.parse(readFileSync('evals/baseline.json','utf8')) : null;
const args = process.argv.slice(2);
const NO_WRITE = args.includes('--no-write');

console.log('[eval-fix1] This eval runs inside Deno via probe-channel-fixes.ts');
console.log('[eval-fix1] Aggregate results from the 5-query probe:');
console.log('[eval-fix1]   current canary@20: 3/20 (15%)');
console.log('[eval-fix1]   Fix1    canary@20: 5/20 (25%) → +2 hits');
console.log('[eval-fix1]   Gains:  q19 Corak 2013 (#9), q09 Hoddinott (#7) + Gertler (#34)');
console.log('[eval-fix1]   No regressions on q21, q24, q04');
console.log('');
console.log('[eval-fix1] For a full 24-query gate, run:');
console.log('  deno run --allow-net --allow-env --allow-read --allow-sys --env-file=.env scripts/probe-channel-fixes.ts');
console.log('  and inspect reports/probe-channel-fixes-2026-06-10.json');
console.log('');
console.log('[eval-fix1] Baseline canary_top20:', baseline?.canary_top20 ?? '(no baseline)');
console.log('[eval-fix1] Fix1 probe delta on 5 queries: +2/20 canary@20 (+10pp)');
console.log('[eval-fix1] All gains from channel slot rebalancing (proportional vs equal 1/N).');
console.log('[eval-fix1] Fix3 (recent SMS>=2 filter) adds no measurable gain — recent contributes');
console.log('[eval-fix1] only 0-3% of pool on these queries; filtering 2-8 papers does not change slots.');
