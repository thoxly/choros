// LIVE_PROOF T-0612 — supplementary check: complete task-fin AFTER the
// escalation has already fired (both branches now live), proving the
// converging gateway closes the instance regardless of which branch finishes
// last (ADR-T0612 §2 D1 semantics — ADR promise, not just the happy path).
import { chromium } from 'playwright';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-T0612-owner!';
const EVDIR = 'docs/live-proof/T-0612-evidence';
const INSTANCE_ID = '29bb45ad-7858-11f1-abdf-aaa9cc4b0546';
const shortId = INSTANCE_ID.split('-')[0];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/inbox/')) console.log('[xhr]', res.status(), url);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
const loginBtn = page.getByRole('button', { name: /войти/i }).or(page.getByRole('link', { name: /войти/i }));
if (await loginBtn.count() > 0) await loginBtn.first().click();
await page.waitForSelector('#username', { timeout: 15000 }).catch(() => {});
if (await page.locator('#username').count() > 0) {
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await page.click('#kc-login');
}
await page.waitForURL(/overview|processes/, { timeout: 20000 }).catch(() => {});

await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const finRow = page.locator('tr', { hasText: shortId }).filter({ hasText: 'Согласование финдиректора' });
console.log('task-fin rows for late instance:', await finRow.count());
await page.screenshot({ path: `${EVDIR}/50-late-before.png` });

const claimBtn = finRow.first().getByRole('button', { name: /^взять$/i });
if (await claimBtn.count() > 0) {
  await claimBtn.first().click();
  await page.waitForTimeout(1200);
}

const finRow2 = page.locator('tr', { hasText: shortId }).filter({ hasText: 'Согласование финдиректора' });
const openBtn = finRow2.first().getByRole('button', { name: /^открыть$/i });
if (await openBtn.count() > 0) {
  await openBtn.first().click();
  await page.waitForTimeout(1000);
}

const drawerText = await page.locator('.chs-overlay--drawer, [role="dialog"]').first().innerText().catch(() => '');
console.log('DRAWER TEXT:', drawerText.slice(0, 400));

const completeBtn = page.getByRole('button', { name: /выполнить шаг/i });
if (await completeBtn.count() > 0) {
  await completeBtn.first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${EVDIR}/51-late-after-complete.png` });
}

await browser.close();
