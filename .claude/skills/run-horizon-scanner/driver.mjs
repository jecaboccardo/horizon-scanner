#!/usr/bin/env node
/**
 * run-horizon-scanner driver.
 *
 * Horizon Scanner is a Vite React frontend (:3000) that proxies /api to a self-hosted
 * Deno backend (:3002, supabase/functions/api/index.ts via server-deno/server.ts). The
 * backend talks to the production VPS Supabase + LLM proxy — local dev has no local DB.
 *
 * This driver covers BOTH layers a PR might touch:
 *   - API (where most logic lives — retrieval/synthesis): `health`, `version`, `search`.
 *   - Frontend GUI: `screenshot` (Playwright + chromium, headless).
 *
 * Prereq: backend + frontend already running (see SKILL.md), and for `screenshot`:
 *   npm i playwright --no-save && npx playwright install chromium
 *
 * Usage:
 *   node .claude/skills/run-horizon-scanner/driver.mjs health
 *   node .claude/skills/run-horizon-scanner/driver.mjs version
 *   node .claude/skills/run-horizon-scanner/driver.mjs screenshot [url] [outfile]
 *   node .claude/skills/run-horizon-scanner/driver.mjs search "your query"   # hits the LLM/GPU — use sparingly
 */
const API = process.env.HS_API || 'http://127.0.0.1:3002';
const WEB = process.env.HS_WEB || 'http://127.0.0.1:3000';
const TENANT = process.env.HS_TENANT || 'iadb-demo';
const cmd = process.argv[2];

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 400) }; }
}

if (cmd === 'health') {
  const r = await getJson(`${API}/api/_health`);
  console.log(JSON.stringify(r.json ?? r, null, 2));
  process.exit(r.json?.status === 'ok' ? 0 : 1);

} else if (cmd === 'version') {
  const r = await getJson(`${API}/api/_version`);
  console.log(JSON.stringify(r.json ?? r, null, 2));

} else if (cmd === 'screenshot') {
  const url = process.argv[3] || WEB;
  const out = process.argv[4] || 'reports/horizon-screenshot.png';
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.error('goto:', e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out, fullPage: false });
  const title = await page.title();
  // surface the main search textarea presence as a liveness check
  const hasSearch = await page.locator('textarea, input[type=text]').first().count().catch(() => 0);
  console.log(JSON.stringify({ url, out, title, hasInput: !!hasSearch, consoleErrors: errors.slice(0, 5) }, null, 2));
  await browser.close();

} else if (cmd === 'search') {
  const query = process.argv[3];
  if (!query) { console.error('usage: search "<query>" — NOTE: hits the LLM/GPU on the VPS'); process.exit(1); }
  const r = await getJson(`${API}/api/search-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ query, filters: {} }),
  });
  const run = r.json || {};
  console.log(JSON.stringify({ status: r.status, evidenceCount: run.evidenceWorkIds?.length ?? run.coverage?.evidenceCount, id: run.id }, null, 2));

} else {
  console.error('commands: health | version | screenshot [url] [out] | search "<q>"');
  process.exit(1);
}
