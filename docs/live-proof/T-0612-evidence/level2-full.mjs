// LIVE_PROOF T-0612 — LEVEL 2 (combined, corrected candidateGroups="tenant-owner"
// so e-owner is a genuinely eligible claimant): publish fixed model, start
// instance, claim+complete task-fin BEFORE PT2M fires, verify termination.
import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-T0612-owner!';
const EVDIR = 'docs/live-proof/T-0612-evidence';
const FIXED_XML = path.resolve('/Users/shoxy/Code/choros-wt/T-0612/docs/live-proof/T-0612-evidence/T-0612-liveproof-fixed.bpmn20.xml');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console:err]', msg.text()); });
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/process-defs') || url.includes('/api/processes') || url.includes('/api/inbox')) {
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

// 1) Publish fixed model (candidateGroups=tenant-owner).
await page.goto(`${BASE}/processes/new/edit`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const loadBtn = page.getByRole('button', { name: /загрузить/i });
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  loadBtn.first().click(),
]);
await fileChooser.setFiles(FIXED_XML);
await page.waitForTimeout(1200);

const publishBtn = page.getByRole('button', { name: /опубликовать/i });
await publishBtn.first().click();
await page.waitForTimeout(500);
const confirmBtn = page.getByRole('dialog').getByRole('button', { name: /^опубликовать$/i });
if (await confirmBtn.count() > 0) await confirmBtn.first().click();
else await publishBtn.last().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${EVDIR}/30-fixed-v2-publish-result.png` });

const bannerText = await page.locator('.chs-banner').allTextContents().catch(() => []);
console.log('PUBLISH BANNER:', JSON.stringify(bannerText));

const url = page.url();
const keyMatch = url.match(/\/processes\/([^/]+)\/edit/);
const processKey = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
console.log('ASSIGNED PROCESS KEY:', processKey);
if (!processKey) { console.log('FATAL: no process key'); await browser.close(); process.exit(1); }

// 2) Start instance.
const startResult = await page.evaluate(async (key) => {
  let headers = { 'Content-Type': 'application/json' };
  try {
    const sess = JSON.parse(localStorage.getItem('chs-kc-session') || '{}');
    if (sess.accessToken) headers['Authorization'] = `Bearer ${sess.accessToken}`;
  } catch {}
  const res = await fetch('/api/processes/start', {
    method: 'POST', headers, body: JSON.stringify({ processKey: key, variables: {} }),
  });
  return { status: res.status, body: await res.text() };
}, processKey);
console.log('START RESULT:', JSON.stringify(startResult));
const instanceId = JSON.parse(startResult.body).instanceId;
console.log('INSTANCE ID:', instanceId);

await page.waitForTimeout(1500);

// 3) Inbox: find task-fin row for this instance, claim + complete.
await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const shortId = instanceId.split('-')[0];
console.log('Searching inbox for short id:', shortId);

// Give the projection a moment / try a few reloads if not found yet.
let rowLocator = page.locator('tr', { hasText: shortId });
for (let i = 0; i < 5 && (await rowLocator.count()) === 0; i++) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'networkidle' });
  rowLocator = page.locator('tr', { hasText: shortId });
}
console.log('Rows found for our instance:', await rowLocator.count());
await page.screenshot({ path: `${EVDIR}/31-inbox-with-task.png` });

if ((await rowLocator.count()) === 0) {
  console.log('TASK ROW NOT FOUND IN INBOX — aborting completion step.');
  await browser.close();
  process.exit(2);
}

await rowLocator.first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${EVDIR}/32-task-detail-opened.png` });
console.log('After row click, URL:', page.url());

// The row click may only select/expand rather than navigate — look for a
// detail panel / "Открыть" action too.
const openBtn = page.getByRole('button', { name: /^открыть$/i }).or(page.getByRole('link', { name: /^открыть$/i }));
if (page.url().endsWith('/inbox') && (await openBtn.count()) > 0) {
  await openBtn.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${EVDIR}/32b-task-detail-via-open.png` });
  console.log('After Открыть click, URL:', page.url());
}

const takeBtn = page.getByRole('button', { name: /взять в работу|взять/i });
console.log('Take-button candidates:', await takeBtn.count());
if (await takeBtn.count() > 0) {
  await takeBtn.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${EVDIR}/33-task-claimed.png` });
}

const completeBtn = page.getByRole('button', { name: /завершить|готово|согласовать|выполнено|подтвердить/i });
console.log('Complete-button candidates:', await completeBtn.count());
const completeTexts = [];
for (let i = 0; i < await completeBtn.count(); i++) completeTexts.push(await completeBtn.nth(i).textContent());
console.log('Complete-button texts:', JSON.stringify(completeTexts));
if (await completeBtn.count() > 0) {
  await completeBtn.first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${EVDIR}/34-task-completed.png` });
  console.log('After completion, URL:', page.url());
}

console.log('FINAL_INSTANCE_ID=' + instanceId);
console.log('FINAL_PROCESS_KEY=' + processKey);

await browser.close();
