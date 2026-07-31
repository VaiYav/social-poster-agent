import { Camoufox } from 'camoufox-js';
import fs from 'node:fs/promises';
import path from 'node:path';

const username = process.env.SOCIAL_X_USERNAME || 'mzai_soulwise';
const password = process.env.SOCIAL_X_PASSWORD || 'fake-password';

const debugDir = '/tmp/x-debug';
await fs.mkdir(debugDir, { recursive: true });

async function dump(page, name) {
  const html = await page.content();
  await fs.writeFile(path.join(debugDir, `${name}.html`), html);
  try {
    await page.screenshot({ path: path.join(debugDir, `${name}.png`) });
  } catch {}
  console.log(`dumped ${name}`);
}

const browser = await Camoufox({
  headless: true,
  humanize: true,
  geoip: true,
  os: 'windows',
  locale: 'en-US',
});

try {
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await dump(page, '01-initial');

  // Fill username (first visible input with name)
  const userInput = page.locator('input[name="username_or_email"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 15000 });
  await userInput.click({ force: true });
  await userInput.fill(username);
  await page.waitForTimeout(1000);
  console.log('username value:', await userInput.inputValue());

  // Click visible Continue
  const continueCandidates = await page.getByText('Continue', { exact: true }).all();
  const continueVisChecks = await Promise.all(continueCandidates.map(l => l.isVisible().catch(() => false)));
  const continueBtn = continueCandidates[continueVisChecks.findIndex(Boolean)];
  console.log('continue candidates:', continueCandidates.length, 'visible index:', continueVisChecks.findIndex(Boolean));
  if (!continueBtn) throw new Error('no visible Continue');
  await continueBtn.click({ force: true });
  await page.waitForTimeout(4000);
  await dump(page, '02-after-continue');
  console.log('after continue URL:', page.url());

  // Find visible password input
  const allPw = await page.locator('input[name="password"]').all();
  console.log('password inputs:', allPw.length);
  for (let i = 0; i < allPw.length; i++) {
    const info = await allPw[i].evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        ariaHidden: el.getAttribute('aria-hidden'),
        rect: el.getBoundingClientRect(),
      };
    });
    console.log(`pw[${i}]`, info);
  }

  // Try fill password in the visible one
  const visiblePw = allPw.find(async (loc) => {
    const op = await loc.evaluate((el) => window.getComputedStyle(el).opacity);
    return op !== '0';
  }) || page.locator('input[name="password"]').first();

  await visiblePw.fill(password);
  console.log('password value:', await visiblePw.inputValue());

  // Click Log in / Continue
  const loginBtn = page.getByText('Log in', { exact: true }).first();
  if (await loginBtn.isVisible().catch(() => false)) {
    console.log('click Log in');
    await loginBtn.click({ force: true });
  } else {
    console.log('click Continue');
    await page.getByText('Continue', { exact: true }).first().click({ force: true });
  }
  await page.waitForTimeout(4000);
  await dump(page, '03-after-submit');
  console.log('after submit URL:', page.url());

  await context.close();
} catch (e) {
  console.error('debug error:', e);
} finally {
  await browser.close();
}
