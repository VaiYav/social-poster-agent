const { PrismaClient } = require('@prisma/client');
const { EncryptionService } = require('./dist/infrastructure/crypto/encryption.service.js');
const { Camoufox } = require('camoufox-js');
(async () => {
  const db = new PrismaClient();
  const enc = new EncryptionService({ get: (k, d) => k === 'SESSION_ENCRYPTION_KEY' ? process.env.SESSION_ENCRYPTION_KEY : d });
  const session = await db.session.findFirst({ where: { id: '88472bfd-a2e5-4acf-a3b6-7b48753207a2' } });
  const ss = enc.decrypt(session.storageState);
  await db.$disconnect();
  const browser = await Camoufox({ headless: true, os: 'windows', locale: 'en-US', humanize: false, geoip: false });
  const context = await browser.newContext({ storageState: ss, viewport: null });
  const page = await context.newPage();
  page.on('crash', () => console.log('CRASH'));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  const requests = [];
  page.on('requestfinished', async (req) => {
    const resp = req.response();
    const status = resp?.status;
    requests.push({ url: req.url(), status, failure: req.failure()?.errorText });
  });
  page.on('requestfailed', req => {
    requests.push({ url: req.url(), status: null, failure: req.failure()?.errorText });
  });
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  for (const r of requests) {
    if (r.url.includes('main') || r.url.includes('vendor') || r.url.includes('runtime') || r.url.includes('abs.twimg')) {
      console.log(r.url, r.status, r.failure);
    }
  }
  await context.close();
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
