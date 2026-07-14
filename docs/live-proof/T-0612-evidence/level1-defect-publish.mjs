// LIVE_PROOF T-0612 — LEVEL 1: prove checkTimerEscalationConvergence is wired
// into the publish path such that the human sees the warning. Loads the
// defect-shape BPMN (non-interrupting boundary timer, disconnected escalation
// branch) into the modeler via "Загрузить BPMN-файл с диска", clicks
// "Опубликовать", and captures whatever banner/message the UI renders.
import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-T0612-owner!';
const EVDIR = 'docs/live-proof/T-0612-evidence';
const DEFECT_XML = path.resolve('/Users/shoxy/Code/choros-wt/T-0612/docs/live-proof/T-0612-evidence/T-0612-liveproof-defect.bpmn20.xml');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
page.on('response', async (res) => {
  if (res.url().includes('/api/process-defs') && res.url().includes('publish')) {
    console.log('[publish response]', res.status(), res.url());
    try { console.log('[publish body]', await res.text()); } catch {}
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

// Navigate straight to a new process modeler.
await page.goto(`${BASE}/processes/new/edit`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${EVDIR}/10-modeler-blank.png` });

// Click "Загрузить" then handle the dynamically-created native file chooser
// (openXmlFilePicker() in bpmn-save-load.js creates a fresh <input type=file>
// on each click and .click()s it — must arm the filechooser listener first).
const loadBtn = page.getByRole('button', { name: /загрузить/i });
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  loadBtn.first().click(),
]);
await fileChooser.setFiles(DEFECT_XML);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${EVDIR}/11-modeler-defect-loaded.png` });

// Click "Опубликовать" (toolbar) — opens a confirm dialog; confirm it too.
const publishBtn = page.getByRole('button', { name: /опубликовать/i });
await publishBtn.first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${EVDIR}/12a-modeler-defect-publish-confirm-dialog.png` });
const confirmBtn = page.getByRole('dialog').getByRole('button', { name: /^опубликовать$/i });
if (await confirmBtn.count() > 0) {
  await confirmBtn.first().click();
} else {
  // fallback: last "Опубликовать" button on the page (inside the modal)
  await publishBtn.last().click();
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${EVDIR}/12-modeler-defect-publish-result.png` });

// Capture any banner text.
const bannerText = await page.locator('.chs-banner').allTextContents().catch(() => []);
console.log('BANNER TEXT:', JSON.stringify(bannerText, null, 2));

const bodyText = await page.locator('body').innerText();
console.log('BODY SNIPPET (first 2000 chars around лint/violation):');
const idx = bodyText.toLowerCase().indexOf('таймер');
console.log(bodyText.slice(Math.max(0, idx - 200), idx + 1500));

await browser.close();
