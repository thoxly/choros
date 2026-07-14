// LIVE_PROOF T-0612 — LEVEL 2: publish the FIXED model (converging gateway),
// start an instance, complete task-fin BEFORE the PT2M timer fires, and prove
// the instance reaches a terminal state (not a zombie).
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
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/process-defs') || url.includes('/api/processes')) {
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

// 1) New process, load FIXED xml, save, publish.
await page.goto(`${BASE}/processes/new/edit`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const loadBtn = page.getByRole('button', { name: /загрузить/i });
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  loadBtn.first().click(),
]);
await fileChooser.setFiles(FIXED_XML);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${EVDIR}/20-fixed-loaded.png` });

const publishBtn = page.getByRole('button', { name: /опубликовать/i });
await publishBtn.first().click();
await page.waitForTimeout(500);
const confirmBtn = page.getByRole('dialog').getByRole('button', { name: /^опубликовать$/i });
if (await confirmBtn.count() > 0) {
  await confirmBtn.first().click();
} else {
  await publishBtn.last().click();
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${EVDIR}/21-fixed-publish-result.png` });

const bannerText = await page.locator('.chs-banner').allTextContents().catch(() => []);
console.log('PUBLISH BANNER:', JSON.stringify(bannerText));

// Read the assigned process key from the URL/toolbar.
const url = page.url();
console.log('URL after publish:', url);
const keyMatch = url.match(/\/processes\/([^/]+)\/edit/);
const processKey = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
console.log('ASSIGNED PROCESS KEY:', processKey);

if (!processKey) {
  console.log('FATAL: could not determine assigned process key from URL, aborting start step.');
  await browser.close();
  process.exit(1);
}

// 2) Start an instance via POST /api/processes/start, using the SAME
// authenticated browser session (page.evaluate → fetch uses the page's own
// cookies/localStorage token — this is the exact call the product's own
// frontend would issue from a launcher; T-0374 removed the generic UI launcher
// button but the route is still the product's real start path).
const startResult = await page.evaluate(async (key) => {
  const authMod = await import('/src/app-shell/dev-auth.js').catch(() => null);
  let headers = { 'Content-Type': 'application/json' };
  if (authMod && authMod.authHeaders) {
    headers = { ...headers, ...authMod.authHeaders() };
  } else {
    // Fallback: read token directly from localStorage (chs-kc-session).
    try {
      const sess = JSON.parse(localStorage.getItem('chs-kc-session') || '{}');
      if (sess.accessToken) headers['Authorization'] = `Bearer ${sess.accessToken}`;
    } catch {}
  }
  const res = await fetch('/api/processes/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({ processKey: key, variables: {} }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}, processKey);
console.log('START RESULT:', JSON.stringify(startResult, null, 2));

await page.waitForTimeout(1000);

// 3) Navigate to "Мои задачи" (inbox) to find task-fin and complete it.
await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: `${EVDIR}/22-my-tasks.png` });
console.log('My-tasks URL:', page.url());

await browser.close();
