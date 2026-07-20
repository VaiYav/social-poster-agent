// Verify X post by checking profile — standalone (no NestJS DI, uses compiled dist).
// Run from packages/backend: npx tsx scripts/verify-x-post-standalone.ts <post-id>

import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { Camoufox } from 'camoufox-js';
// Camoufox is a function (not a class) that returns Promise<Browser>

const ALGORITHM = 'aes-256-gcm';

function findEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const c = path.join(dir, '.env');
    if (fs.existsSync(c)) return c;
    dir = path.dirname(dir);
  }
  throw new Error('.env not found');
}

const envContent = fs.readFileSync(findEnvFile(), 'utf8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !m[1].startsWith('#')) {
    let v = m[2];
    const ci = v.indexOf(' #');
    if (ci >= 0) v = v.slice(0, ci);
    envVars[m[1]] = v.trim();
  }
}

function decrypt(s: string): unknown {
  if (!s.startsWith('v1:')) return JSON.parse(s);
  const [, iv, enc, tag] = s.split(':');
  const d = crypto.createDecipheriv(ALGORITHM, Buffer.from(envVars.SESSION_ENCRYPTION_KEY, 'hex'), Buffer.from(iv!, 'hex'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tag!, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(enc!, 'hex')), d.final()]).toString('utf8'));
}

async function main() {
  const postId = process.argv[2];
  if (!postId) { console.error('Usage: npx tsx scripts/verify-x-post-standalone.ts <post-id>'); process.exit(1); }

  const prisma = new PrismaClient();
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) { console.error('Post not found'); process.exit(1); }

  console.log(`Post: network=${post.network} status=${post.status}`);
  console.log(`Content: ${post.content.slice(0, 80)}...`);

  if (post.network !== 'X') { console.log('Not an X post'); await prisma.$disconnect(); process.exit(0); }

  // Get X session from DB
  const session = await prisma.session.findFirst({
    where: { status: 'ACTIVE', account: { network: 'X' } },
    include: { account: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!session) { console.log('No X session'); await prisma.$disconnect(); process.exit(1); }

  // Decrypt storage state
  const raw = session.storageState;
  const storageStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const storageState = decrypt(storageStr) as { cookies: Array<{ name: string; value: string; domain: string }> };

  console.log(`\nLaunching Camoufox...`);
  const browser = await Camoufox({
    headless: true,
    humanize: true,
    geoip: true,
  }) as any;

  const context = await browser.newContext({ storageState, viewport: null as any });
  const page = await context.newPage();

  // Suppress page errors
  page.on('pageerror', (err) => console.log(`[pageerror]: ${err.message}`));

  try {
    const handle = 'mzai_soulwise';
    console.log(`Navigating to https://x.com/${handle}...`);
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const searchSnippet = post.content.slice(0, 30).replace(/["\\]/g, '');
    console.log(`Looking for snippet: "${searchSnippet}..."`);

    const found = await page.evaluate((snippet: string) => {
      const tweets = document.querySelectorAll('[data-testid="tweetText"]');
      for (const tweet of tweets) {
        const text = tweet.textContent || '';
        if (text.includes(snippet)) {
          return { found: true, text: text.slice(0, 120) };
        }
      }
      return { found: false, texts: Array.from(tweets).map((t) => (t.textContent || '').slice(0, 80)) };
    }, searchSnippet);

    if (found.found) {
      console.log(`\n✓ TWEET FOUND ON PROFILE!`);
      console.log(`  Text: ${found.text}`);

      // Extract tweet URL
      const tweetUrl = await page.evaluate((snippet: string) => {
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        for (const tweet of tweets) {
          const textEl = tweet.querySelector('[data-testid="tweetText"]');
          if (textEl && (textEl.textContent || '').includes(snippet)) {
            const timeEl = tweet.querySelector('time');
            const link = timeEl?.closest('a')?.href;
            return link || null;
          }
        }
        return null;
      }, searchSnippet);

      console.log(`  URL: ${tweetUrl || 'not found'}`);
      await prisma.post.update({
        where: { id: postId },
        data: {
          status: 'POSTED',
          postUrl: tweetUrl || `https://x.com/${handle}/status/unknown`,
          postedAt: new Date(),
        },
      });
      console.log(`  ✓ Post status updated to POSTED`);
    } else {
      console.log(`\n✗ Tweet NOT found on profile`);
      const texts = (found as any).texts as string[];
      console.log(`  Tweets on profile (${texts?.length || 0}):`);
      texts?.forEach((t, i) => console.log(`    ${i}: ${t}`));
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await prisma.$disconnect();
    process.exit(0);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
