#!/usr/bin/env node
// Test custom year input in LinkedFilterBuilder modal
import { chromium } from 'playwright-core';
import { config } from 'dotenv';
config();

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// Log all keydown events on document to see what's intercepting
await page.addInitScript(() => {
  document.addEventListener('keydown', (e) => {
    console.log('[KEYDOWN on doc]', e.key, 'target:', e.target.tagName, e.target.className?.slice(0,30), 'propagation stopped:', e.cancelBubble);
  }, true); // capture phase
});

console.log('Navigating to app...');
await page.goto('https://v0-horizon-scanner-iadb.vercel.app/', { waitUntil: 'networkidle' });

// Login
const emailInput = page.locator('input[type="email"]');
if (await emailInput.isVisible()) {
  await emailInput.fill('process.env.SMOKE_EMAIL');
  await page.fill('input[type="password"]', 'process.env.SMOKE_PASSWORD');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
}

// Find "Edit all" button or YEARS chip
const editBtn = page.locator('button:has-text("Edit all")').first();
if (await editBtn.isVisible()) {
  console.log('Clicking "Edit all"...');
  await editBtn.click();
  await page.waitForTimeout(1000);

  // Click "Custom" year option
  const customBtn = page.locator('button:has-text("Custom")').first();
  if (await customBtn.isVisible()) {
    console.log('Clicking "Custom"...');
    await customBtn.click();
    await page.waitForTimeout(500);

    // Find the From input
    const fromInput = page.locator('input[placeholder*="From"]').first();
    console.log('From input visible:', await fromInput.isVisible());

    if (await fromInput.isVisible()) {
      console.log('Clicking on From input...');
      await fromInput.click();
      await page.waitForTimeout(300);

      console.log('Typing "2"...');
      await fromInput.type('2');
      await page.waitForTimeout(500);

      // Check if modal is still open
      const modalOpen = await page.locator('button:has-text("Apply")').isVisible();
      const inputVisible = await fromInput.isVisible();
      console.log('Modal still open (Apply visible):', modalOpen);
      console.log('Input still visible:', inputVisible);

      if (inputVisible) {
        const currentVal = await fromInput.inputValue();
        console.log('Input value after typing "2":', currentVal);

        console.log('Typing rest of year: "010"...');
        await fromInput.type('010');
        await page.waitForTimeout(500);
        console.log('Input value after typing "2010":', await fromInput.inputValue());
        console.log('Modal still open:', await page.locator('button:has-text("Apply")').isVisible());
      }
    } else {
      console.log('ERROR: From input not visible after clicking Custom!');
      await page.screenshot({ path: 'reports/test-custom-year-debug.png' });
    }
  }
}

console.log('\nConsole errors:', consoleErrors.slice(0,5));
await page.screenshot({ path: 'reports/test-custom-year-final.png' });
await browser.close();
