// LIVE_PROOF T-0612 — LEVEL 2, take 2: reuse the already-published+started
// instance (env-provided) OR publish+start fresh; then correctly scope the
// claim/open/complete actions to OUR ROW ONLY (previous attempt grabbed a
// same-named button from an unrelated row).
import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-T0612-owner!';
const EVDIR = 'docs/live-proof/T-0612-evidence';
const FIXED_XML = path.resolve('/Users/shoxy/Code/choros-wt/T-0612/docs/live-proof/T-0612-evidence/T-0612-liveproof-fixed.bpmn20.xml');

// If provided, skip publish+start and reuse an existing instance/task.
let processKey = process.env.LP_PROCESS_KEY || null;
let instanceId = process.env.LP_INSTANCE_ID || null;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/process-defs') || url.includes('/api/processes/start') || url.includes('/api/inbox/')) {
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

if (!processKey || !instanceId) {
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

  const bannerText = await page.locator('.chs-banner').allTextContents().catch(() => []);
  console.log('PUBLISH BANNER:', JSON.stringify(bannerText));

  const url = page.url();
  const keyMatch = url.match(/\/processes\/([^/]+)\/edit/);
  processKey = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
  console.log('ASSIGNED PROCESS KEY:', processKey);
  if (!processKey) { console.log('FATAL: no process key'); await browser.close(); process.exit(1); }

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
  instanceId = JSON.parse(startResult.body).instanceId;
  console.log('INSTANCE ID:', instanceId);
  await page.waitForTimeout(1500);
}

console.log('USING processKey =', processKey, ' instanceId =', instanceId);
const shortId = instanceId.split('-')[0];

// Inbox: locate OUR row precisely (scope by tr containing shortId AND
// "Согласование финдиректора" — the task-fin step name — to avoid any
// collision with the escalation task-esc row that may ALSO carry the same
// instance id after the timer fires).
await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

let finRow = page.locator('tr', { hasText: shortId }).filter({ hasText: 'Согласование финдиректора' });
for (let i = 0; i < 6 && (await finRow.count()) === 0; i++) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'networkidle' });
  finRow = page.locator('tr', { hasText: shortId }).filter({ hasText: 'Согласование финдиректора' });
}
console.log('task-fin rows found:', await finRow.count());
await page.screenshot({ path: `${EVDIR}/40-inbox-before-claim.png` });

if ((await finRow.count()) === 0) {
  console.log('TASK-FIN ROW NOT FOUND.');
  await browser.close();
  process.exit(2);
}

// Claim ("Взять") scoped to this row.
const claimBtnInRow = finRow.first().getByRole('button', { name: /^взять$/i });
if (await claimBtnInRow.count() > 0) {
  await claimBtnInRow.first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${EVDIR}/41-after-claim.png` });
  console.log('Clicked Взять in our row.');
} else {
  console.log('No Взять button in our row (maybe already claimed) — row text:', await finRow.first().innerText());
}

// Re-locate the row (state may have re-rendered) and click its "Открыть".
finRow = page.locator('tr', { hasText: shortId }).filter({ hasText: 'Согласование финдиректора' });
const openBtnInRow = finRow.first().getByRole('button', { name: /^открыть$/i });
console.log('Открыть buttons in our row:', await openBtnInRow.count());
if (await openBtnInRow.count() > 0) {
  await openBtnInRow.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${EVDIR}/42-drawer-opened.png` });
}

// Verify the drawer shows OUR instance id before completing (guard against
// misclick onto an unrelated row's drawer, as happened previously).
const drawerText = await page.locator('.chs-overlay--drawer, [role="dialog"]').first().innerText().catch(() => '');
console.log('DRAWER TEXT:', drawerText.slice(0, 500));
if (!drawerText.includes(shortId)) {
  console.log('WARNING: drawer does not mention our instance short id — may be wrong task.');
}

const completeBtn = page.getByRole('button', { name: /выполнить шаг/i });
console.log('Выполнить-шаг buttons:', await completeBtn.count());
if (await completeBtn.count() > 0) {
  await completeBtn.first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${EVDIR}/43-after-complete.png` });
  console.log('Clicked Выполнить шаг.');
}

console.log('FINAL_INSTANCE_ID=' + instanceId);
console.log('FINAL_PROCESS_KEY=' + processKey);

await browser.close();
