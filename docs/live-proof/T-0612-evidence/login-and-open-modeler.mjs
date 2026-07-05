// LIVE_PROOF T-0612 helper: real KC-form login (Playwright, headless chromium),
// then navigate to the process modeler and screenshot. Pattern per
// memory/choros-acceptance-t0583-users-2026-07-04.md DURABLE notes.
import { chromium } from 'playwright';

const BASE = 'http://100.121.76.86:3000';
const USER = process.env.LP_USER || 'e-owner';
const PASS = process.env.LP_PASS || 'LiveProof-0583-owner!';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'docs/live-proof/T-0612-evidence/00-landing.png' });

// Click "Войти" if present (landing page, not auto-redirect).
const loginBtn = page.getByRole('button', { name: /войти/i }).or(page.getByRole('link', { name: /войти/i }));
if (await loginBtn.count() > 0) {
  await loginBtn.first().click();
}

await page.waitForSelector('#username', { timeout: 15000 }).catch(() => {});
if (await page.locator('#username').count() > 0) {
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await page.click('#kc-login');
}

await page.waitForURL(/overview|processes/, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/live-proof/T-0612-evidence/01-post-login.png' });
console.log('URL after login:', page.url());
console.log('localStorage chs-kc-session present:', await page.evaluate(() => !!localStorage.getItem('chs-kc-session')));

await browser.close();
