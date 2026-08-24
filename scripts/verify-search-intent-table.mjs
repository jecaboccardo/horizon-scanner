#!/usr/bin/env node
// Focused check: table structure after retrieval completes
import { chromium } from 'playwright-core';

const URL = 'https://v0-horizon-scanner-iadb.vercel.app/';
const EMAIL = 'process.env.SMOKE_EMAIL';
const PASS = 'process.env.SMOKE_PASSWORD';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await emailInput.fill(EMAIL);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
  }

  // Submit a search and wait longer
  const textarea = page.locator('textarea').first();
  await textarea.fill('conditional cash transfers and education');
  await page.locator('button:has-text("Search corpus")').click();

  console.log('Waiting up to 90s for evidence table...');
  const tableShown = await page.locator('table').waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
  console.log('Table appeared:', tableShown);

  if (tableShown) {
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'reports/verify-table-appeared.png' });

    // Check Channel header
    const channelTh = await page.locator('th:has-text("Channel")').isVisible();
    console.log('Channel header:', channelTh);

    // Authors header gone
    const authorsTh = await page.locator('th:has-text("Authors")').isVisible().catch(() => false);
    console.log('Authors header (should be false):', authorsTh);

    // Channel chips
    const chips = await page.locator('span.text-\\[9px\\]').allTextContents();
    console.log('Channel chips found:', chips.slice(0,10));

    // Authors below title
    const authorSubtitles = await page.locator('td .text-\\[10px\\].text-slate-500').count();
    console.log('Author subtitles below title:', authorSubtitles);

    // Wait for synthesis
    console.log('Waiting for synthesis (up to 60s)...');
    const synthStarted = await page.locator('text=Drafting brief').isVisible({ timeout: 60000 }).catch(() => false);
    console.log('Synthesis started (auto, no Step 2):', synthStarted);

    await page.screenshot({ path: 'reports/verify-table-synthesis.png' });

    // Check Step 2 never appeared
    const step2 = await page.locator('text=How should the brief read?').isVisible().catch(() => false);
    console.log('Step 2 appeared (should be false):', step2);
  }

} finally {
  await browser.close();
}
