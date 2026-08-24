#!/usr/bin/env node
/**
 * Playwright verification of the demo URL.
 * Captures every network request, console error, and page state.
 */
import { chromium } from 'playwright-core';

const DEMO_URL = 'https://horizon-scanner-iadb-demo.vercel.app';
const EMAIL = 'process.env.SMOKE_EMAIL';
const PASSWORD = process.argv[2]; // pass as first arg

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 14 Pro size
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});

const page = await context.newPage();

// Capture ALL network requests and responses
const networkLog = [];
page.on('request', req => {
  if (req.url().includes('/api/') || req.url().includes('/auth/')) {
    networkLog.push({ type: 'REQ', method: req.method(), url: req.url().replace('https://horizon-scanner-iadb-demo.vercel.app', ''), time: Date.now() });
  }
});
page.on('response', async res => {
  if (res.url().includes('/api/') || res.url().includes('/auth/') || res.url().includes('horizon-api') || res.url().includes('nextminder')) {
    const body = await res.text().catch(() => '');
    networkLog.push({ type: 'RES', status: res.status(), url: res.url().replace('https://horizon-scanner-iadb-demo.vercel.app', ''), body: body.slice(0, 300), time: Date.now() });
  }
});

// Capture console errors
const consoleErrors = [];
page.on('console', msg => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

// Capture page errors
const pageErrors = [];
page.on('pageerror', err => pageErrors.push(err.message));

console.log('=== STEP 1: Navigate to demo URL ===');
await page.goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 20000 }).catch(e => console.log('Navigation error:', e.message));
await page.screenshot({ path: 'reports/verify-step1-initial.png' });
const title = await page.title();
const bodyText = await page.locator('body').innerText().catch(() => '');
console.log('Page title:', title);
console.log('Body text (first 300):', bodyText.slice(0, 300));

// Check if we see AuthGate (Sign in button) or the main app
const hasSignIn = await page.locator('button:has-text("Sign in"), input[type="email"]').count();
const hasSearchBox = await page.locator('textarea, input[placeholder*="query" i], input[placeholder*="search" i]').count();
console.log('Has sign-in form:', hasSignIn > 0);
console.log('Has search box:', hasSearchBox > 0);

if (hasSignIn > 0) {
  console.log('\n=== STEP 2: Log in ===');
  if (!PASSWORD) {
    console.log('No password provided — cannot log in. Pass password as first argument.');
    console.log('Network log so far:', JSON.stringify(networkLog, null, 2));
    await browser.close();
    process.exit(0);
  }

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.screenshot({ path: 'reports/verify-step2-filled.png' });

  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'reports/verify-step3-after-login.png' });

  const afterLoginText = await page.locator('body').innerText().catch(() => '');
  console.log('After login body (300):', afterLoginText.slice(0, 300));
  const loginError = await page.locator('.text-red-700, [class*="error"]').innerText().catch(() => '');
  if (loginError) console.log('LOGIN ERROR:', loginError);
}

// Check network log up to this point
console.log('\n=== Network log ===');
networkLog.forEach(n => console.log(n.type, n.status || '', n.method || '', n.url, n.body ? '| ' + n.body.slice(0, 100) : ''));

// Now try a search if we're logged in
const hasSearchAfterLogin = await page.locator('textarea, input[placeholder*="query" i]').count();
if (hasSearchAfterLogin > 0) {
  console.log('\n=== STEP 3: Submit a search ===');
  const searchBox = page.locator('textarea').first();
  await searchBox.fill('cash transfers education LAC');
  await page.screenshot({ path: 'reports/verify-step4-query.png' });

  // Find and click submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Search"), button:has-text("Go")').first();
  const hasSubmit = await submitBtn.count();
  if (hasSubmit > 0) {
    await submitBtn.click();
  } else {
    await searchBox.press('Enter');
  }

  console.log('Search submitted, waiting for response...');
  await page.waitForTimeout(12000);
  await page.screenshot({ path: 'reports/verify-step5-after-search.png' });

  const searchResult = await page.locator('body').innerText().catch(() => '');
  console.log('After search body (500):', searchResult.slice(0, 500));

  const errorMsg = await page.locator('[class*="error"], [class*="rose"], .text-red-700').innerText().catch(() => '');
  if (errorMsg) console.log('ERROR ON PAGE:', errorMsg);

  const retryBtn = await page.locator('button:has-text("Retry"), button:has-text("retry")').count();
  console.log('Retry button visible:', retryBtn > 0);
}

console.log('\n=== Console errors ===');
consoleErrors.forEach(e => console.log('ERROR:', e));

console.log('\n=== Page errors ===');
pageErrors.forEach(e => console.log('PAGE ERROR:', e));

console.log('\n=== Full network log ===');
networkLog.forEach(n => console.log(JSON.stringify(n)));

await browser.close();
