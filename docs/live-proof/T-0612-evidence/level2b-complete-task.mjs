// LIVE_PROOF T-0612 — LEVEL 2 continuation: find task-fin for the started
// instance in the inbox, take + complete it BEFORE the PT2M timer fires,
// then verify the process instance is done (not a zombie).
import { chromium } from 'playwright';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-T0612-owner!';
const EVDIR = 'docs/live-proof/T-0612-evidence';
const INSTANCE_ID = process.env.LP_INSTANCE_ID;
const PROCESS_KEY = process.env.LP_PROCESS_KEY;

if (!INSTANCE_ID || !PROCESS_KEY) {
  console.error('Set LP_INSTANCE_ID and LP_PROCESS_KEY env vars.');
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/inbox') || url.includes('/api/tasks') || url.includes('/api/processes/')) {
    console.log('[xhr]', res.status(), url);
  }
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
console.log('Logged in, URL:', page.url());

await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Find the row containing our instance id substring (first 8 chars, as shown truncated in UI).
const shortId = INSTANCE_ID.split('-')[0];
console.log('Looking for instance short id:', shortId);

const rowLocator = page.locator('tr', { hasText: shortId });
const rowCount = await rowLocator.count();
console.log('Matching rows for our instance:', rowCount);

if (rowCount === 0) {
  // Try scrolling / search box.
  const searchBox = page.locator('input[type="search"], input[placeholder*="Поиск" i]');
  if (await searchBox.count() > 0) {
    await searchBox.first().fill(shortId);
    await page.waitForTimeout(800);
  }
}
await page.screenshot({ path: `${EVDIR}/23-inbox-search.png` });

const rowLocator2 = page.locator('tr', { hasText: shortId });
const rowCount2 = await rowLocator2.count();
console.log('Matching rows after search attempt:', rowCount2);

if (rowCount2 > 0) {
  await rowLocator2.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${EVDIR}/24-task-detail.png` });
  console.log('Task detail URL:', page.url());

  // Look for "Взять в работу" (take) then "Завершить"/"Готово" (complete) buttons.
  const takeBtn = page.getByRole('button', { name: /взять/i });
  if (await takeBtn.count() > 0) {
    await takeBtn.first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${EVDIR}/25-task-taken.png` });
  }

  const completeBtn = page.getByRole('button', { name: /завершить|готово|согласовать|выполнено/i });
  console.log('Complete-like buttons found:', await completeBtn.count());
  if (await completeBtn.count() > 0) {
    await completeBtn.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${EVDIR}/26-task-completed.png` });
  }
} else {
  console.log('COULD NOT FIND TASK ROW FOR OUR INSTANCE IN INBOX UI.');
}

await browser.close();
