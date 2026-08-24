#!/usr/bin/env node
// E2E verification: search intent card (Q1/Q2/Q3), auto-synthesis, channel column
import { chromium } from 'playwright-core';

const URL = 'https://v0-horizon-scanner-iadb.vercel.app/';
const EMAIL = 'process.env.SMOKE_EMAIL';
const PASS = 'process.env.SMOKE_PASSWORD';
const SCREENSHOTS = [];
let passed = 0, failed = 0, warned = 0;

function step(icon, label, detail = '') {
  console.log(`${icon} ${label}${detail ? ' → ' + detail : ''}`);
  if (icon === '✅') passed++;
  if (icon === '❌') failed++;
  if (icon === '⚠️') warned++;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  // ── Setup: login ──────────────────────────────────────────────────────────
  console.log('\n=== Setup: navigating + login ===');
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible({ timeout: 3000 })) {
    await emailInput.fill(EMAIL);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    console.log('Logged in');
  } else {
    console.log('Already logged in');
  }

  await page.screenshot({ path: 'reports/verify-intent-01-loaded.png' });
  SCREENSHOTS.push('reports/verify-intent-01-loaded.png');

  // ── Step 1: Q1 — "What are you building?" section exists ─────────────────
  console.log('\n=== Step 1: Q1 purpose picker ===');
  const q1Label = await page.locator('text=What are you building?').isVisible({ timeout: 5000 });
  step(q1Label ? '✅' : '❌', 'Q1 label "What are you building?" visible', q1Label);

  const briefBtn = page.locator('button', { hasText: 'Policy brief' });
  const litBtn   = page.locator('button', { hasText: 'Literature review' });
  const scanBtn  = page.locator('button', { hasText: 'Quick scan' });

  step(await briefBtn.isVisible() ? '✅' : '❌', 'Policy brief option visible');
  step(await litBtn.isVisible()   ? '✅' : '❌', 'Literature review option visible');
  step(await scanBtn.isVisible()  ? '✅' : '❌', 'Quick scan option visible');

  // ── Step 2: Q2 — channel checkboxes ──────────────────────────────────────
  console.log('\n=== Step 2: Q2 channel checkboxes ===');
  const q2Label = await page.locator('text=What should the search include?').isVisible({ timeout: 3000 });
  step(q2Label ? '✅' : '❌', 'Q2 label visible');

  const causalCb    = page.locator('label', { hasText: 'Causal evidence' });
  const foundCb     = page.locator('label', { hasText: 'Foundational / macro' });
  const recentCb    = page.locator('label', { hasText: 'Recent frontier' });
  const lacCb       = page.locator('label', { hasText: 'LAC-focused' });

  step(await causalCb.isVisible()    ? '✅' : '❌', 'Causal evidence checkbox visible');
  step(await foundCb.isVisible()     ? '✅' : '❌', 'Foundational / macro checkbox visible');
  step(await recentCb.isVisible()    ? '✅' : '❌', 'Recent frontier checkbox visible');
  step(await lacCb.isVisible()       ? '✅' : '❌', 'LAC-focused checkbox visible');

  // Verify default checked state — causal, foundational, recent should be checked; lac unchecked
  const causalChecked = await page.locator('label:has-text("Causal evidence") input[type="checkbox"]').isChecked();
  const foundChecked  = await page.locator('label:has-text("Foundational / macro") input[type="checkbox"]').isChecked();
  const recentChecked = await page.locator('label:has-text("Recent frontier") input[type="checkbox"]').isChecked();
  const lacChecked    = await page.locator('label:has-text("LAC-focused") input[type="checkbox"]').isChecked();

  step(causalChecked ? '✅' : '❌', 'Causal checked by default', String(causalChecked));
  step(foundChecked  ? '✅' : '❌', 'Foundational checked by default', String(foundChecked));
  step(recentChecked ? '✅' : '❌', 'Recent checked by default', String(recentChecked));
  step(!lacChecked   ? '✅' : '⚠️', 'LAC unchecked by default', String(lacChecked));

  // ── Step 3: Q3 — sources toggle ───────────────────────────────────────────
  console.log('\n=== Step 3: Q3 sources toggle ===');
  const q3Label = await page.locator('text=Specific sources you care about?').isVisible({ timeout: 3000 });
  step(q3Label ? '✅' : '❌', 'Q3 label visible');

  const noDefault = page.locator('button', { hasText: 'No — use defaults' });
  const yesCustom = page.locator('button', { hasText: 'Yes — let me choose' });
  step(await noDefault.isVisible() ? '✅' : '❌', '"No — use defaults" button visible');
  step(await yesCustom.isVisible() ? '✅' : '❌', '"Yes — let me choose" button visible');

  // Click Yes and check source picker appears
  await yesCustom.click();
  await page.waitForTimeout(500);
  const sourcePicker = await page.locator('.rounded-xl.border.border-slate-200.bg-white.p-3').isVisible();
  step(sourcePicker ? '✅' : '❌', 'Source picker appears when Yes clicked');

  // Click back to No
  await noDefault.click();
  await page.waitForTimeout(300);
  const sourcePickerGone = !(await page.locator('.rounded-xl.border.border-slate-200.bg-white.p-3').isVisible());
  step(sourcePickerGone ? '✅' : '❌', 'Source picker hides when No clicked');

  // ── Step 4: Language selector in Box 1 ───────────────────────────────────
  console.log('\n=== Step 4: Language selector in Box 1 ===');
  const langLabel = await page.locator('text=Output language:').isVisible({ timeout: 3000 });
  step(langLabel ? '✅' : '❌', 'Language selector present in Box 1');

  // ── Step 5: Step 2 is GONE ────────────────────────────────────────────────
  console.log('\n=== Step 5: Step 2 removed ===');
  const step2Gone = !(await page.locator('text=How should the brief read?').isVisible({ timeout: 1000 }).catch(() => false));
  const step2HintGone = !(await page.locator('text=Step 2').isVisible({ timeout: 1000 }).catch(() => false));
  step(step2Gone     ? '✅' : '❌', '"How should the brief read?" text not visible');
  step(step2HintGone ? '✅' : '❌', '"Step 2" hint text not visible');

  await page.screenshot({ path: 'reports/verify-intent-02-box1.png' });
  SCREENSHOTS.push('reports/verify-intent-02-box1.png');

  // ── Step 6: Submit a search and verify auto-synthesis fires ──────────────
  console.log('\n=== Step 6: Submit search + auto-synthesis ===');
  const textarea = page.locator('textarea').first();
  await textarea.fill('What is the impact of conditional cash transfers on education?');
  await page.waitForTimeout(300);

  const submitBtn = page.locator('button:has-text("Search corpus")');
  step(await submitBtn.isVisible() ? '✅' : '❌', 'Submit button visible');
  await submitBtn.click();

  // Wait for retrieval to start
  await page.waitForTimeout(2000);
  const retrieving = await page.locator('text=Searching corpus').isVisible({ timeout: 5000 }).catch(() => false);
  step(retrieving ? '✅' : '⚠️', 'Retrieval started (spinner visible)', String(retrieving));

  // Verify Step 2 card did NOT appear
  const step2Appeared = await page.locator('text=How should the brief read?').isVisible({ timeout: 3000 }).catch(() => false);
  step(!step2Appeared ? '✅' : '❌', 'Step 2 card did NOT appear after submit (auto-synthesis)', step2Appeared ? 'APPEARED - WRONG' : 'correct');

  await page.screenshot({ path: 'reports/verify-intent-03-retrieving.png' });
  SCREENSHOTS.push('reports/verify-intent-03-retrieving.png');

  // Wait for table to appear (up to 60s for retrieval + partial brief)
  console.log('Waiting for evidence table (up to 60s)...');
  const tableAppeared = await page.locator('table').isVisible({ timeout: 60000 }).catch(() => false);
  step(tableAppeared ? '✅' : '❌', 'Evidence table appeared');

  if (tableAppeared) {
    // ── Step 7: Channel column in table ──────────────────────────────────
    console.log('\n=== Step 7: Evidence table structure ===');
    await page.waitForTimeout(1000);

    const channelHeader = await page.locator('th:has-text("Channel")').isVisible();
    step(channelHeader ? '✅' : '❌', 'Channel column header visible');

    const authorsHeader = await page.locator('th:has-text("Authors")').isVisible().catch(() => false);
    step(!authorsHeader ? '✅' : '❌', 'Authors standalone column REMOVED');

    // Check channel chips exist (Causal/Found./Recent/LAC/General)
    const chips = page.locator('span.text-\\[9px\\]');
    const chipCount = await chips.count();
    step(chipCount > 0 ? '✅' : '❌', `Channel chips rendered (${chipCount} found)`);

    // Sample a few chip labels
    if (chipCount > 0) {
      const firstChip = await chips.first().textContent();
      step(['Causal', 'Found.', 'Recent', 'LAC', 'General'].includes(firstChip?.trim() ?? '') ? '✅' : '⚠️',
        `First chip label: "${firstChip?.trim()}"`, 'valid channel name');
    }

    // Check authors appear below title (small text in title cell)
    const authorBelowTitle = await page.locator('td .text-\\[10px\\].text-slate-500').count();
    step(authorBelowTitle > 0 ? '✅' : '⚠️', `Authors below title: ${authorBelowTitle} rows with author subtitle`);

    await page.screenshot({ path: 'reports/verify-intent-04-table.png' });
    SCREENSHOTS.push('reports/verify-intent-04-table.png');

    // Wait for synthesis to start
    console.log('Waiting for synthesis to start...');
    const synthesising = await page.locator('text=Drafting brief').isVisible({ timeout: 30000 }).catch(() => false);
    step(synthesising ? '✅' : '⚠️', 'Synthesis auto-started (no manual confirm needed)', synthesising ? 'yes' : 'may have finished already');

    // Wait for full brief
    const briefReady = await page.locator('text=Methodology').isVisible({ timeout: 90000 }).catch(() => false);
    step(briefReady ? '✅' : '⚠️', 'Brief synthesis completed', briefReady ? 'brief rendered' : 'timed out');

    await page.screenshot({ path: 'reports/verify-intent-05-brief.png' });
    SCREENSHOTS.push('reports/verify-intent-05-brief.png');
  }

  // ── Probe: switch to Literature review before search ─────────────────────
  console.log('\n=== Probe: Literature review mode ===');
  // Go back to fresh search
  const newSearchBtn = page.locator('button[title="New search"], button[aria-label="New search"]').first();
  if (await newSearchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await newSearchBtn.click();
    await page.waitForTimeout(500);
  } else {
    // Try the + button in the collapsed sidebar
    const plusBtn = page.locator('button[title="New search"]').first();
    if (await plusBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await plusBtn.click();
      await page.waitForTimeout(500);
    }
  }

  const litBtnNow = page.locator('button', { hasText: 'Literature review' });
  if (await litBtnNow.isVisible({ timeout: 3000 }).catch(() => false)) {
    await litBtnNow.click();
    await page.waitForTimeout(300);
    // Check it looks selected (teal border)
    const litBtnClass = await litBtnNow.getAttribute('class');
    const isSelected = litBtnClass?.includes('border-teal-600') || litBtnClass?.includes('bg-teal-50');
    step(isSelected ? '✅' : '⚠️', '🔍 Literature review button visually selected on click', isSelected ? 'teal border/bg visible' : 'class: ' + litBtnClass?.slice(0,80));
  } else {
    step('⚠️', '🔍 Could not reach fresh search state to test Literature review mode');
  }

  // ── Probe: toggle Foundational off ───────────────────────────────────────
  console.log('\n=== Probe: toggle channel off ===');
  const foundCbInput = page.locator('label:has-text("Foundational / macro") input[type="checkbox"]');
  if (await foundCbInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    const wasCked = await foundCbInput.isChecked();
    await foundCbInput.click({ force: true });
    await page.waitForTimeout(200);
    const nowCked = await foundCbInput.isChecked();
    step(wasCked !== nowCked ? '✅' : '❌', '🔍 Foundational checkbox toggles on click', `${wasCked} → ${nowCked}`);
    // Toggle back
    await foundCbInput.click({ force: true });
  } else {
    step('⚠️', '🔍 Foundational checkbox not found for toggle probe');
  }

  await page.screenshot({ path: 'reports/verify-intent-06-probe.png' });
  SCREENSHOTS.push('reports/verify-intent-06-probe.png');

} catch (err) {
  console.error('Verification error:', err.message);
  await page.screenshot({ path: 'reports/verify-intent-error.png' });
  SCREENSHOTS.push('reports/verify-intent-error.png');
  failed++;
} finally {
  await browser.close();
}

// Report
console.log('\n' + '='.repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${warned} warned`);
console.log('Screenshots:', SCREENSHOTS.join(', '));
if (consoleErrors.length > 0) {
  console.log('Console errors:', consoleErrors.slice(0, 5).join('\n'));
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
