#!/usr/bin/env node
/**
 * Cross-platform wrapper for `deno test` over the project's Deno-style unit
 * tests. Some of these (Tests/*.test.ts) import supabase.ts, which throws at
 * import time unless SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY are set — no real
 * connection is ever made by these tests, so dummy values are fine and keep
 * this runnable with no .env / secrets present.
 */
import { spawnSync } from 'node:child_process';

const FILES = [
  'supabase/functions/_shared/citationIntegrity.test.ts',
  'supabase/functions/_shared/smsClassifier.test.ts',
  'supabase/functions/_shared/routing.test.ts',
  'supabase/functions/_shared/confidence.test.ts',
  'supabase/functions/_shared/monitor/roster.test.ts',
  'supabase/functions/_shared/monitor/pricing.test.ts',
  'supabase/functions/_shared/monitor/health.test.ts',
  'supabase/functions/_shared/monitor/quality.test.ts',
  'supabase/functions/_shared/monitor/cost.test.ts',
  'supabase/functions/_shared/monitor/alerts.test.ts',
  'Tests/paperPlanEngine.clarify.test.ts',
  'Tests/uploadIngest.venue.test.ts',
  'Tests/uploads.alreadyInPlan.test.ts',
];

const env = {
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || 'http://localhost:1',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key',
};

const result = spawnSync(
  'deno',
  ['test', '--no-check', '--allow-read', '--allow-env', ...FILES],
  { stdio: 'inherit', env },
);

process.exit(result.status ?? 1);
