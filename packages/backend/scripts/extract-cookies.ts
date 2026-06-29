// Extract auth cookies using Prisma client + EncryptionService (same code path as production).
// Run from packages/backend: npx tsx scripts/extract-cookies.ts

import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1';

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

const KEY = envVars.SESSION_ENCRYPTION_KEY;
if (!KEY) { console.error('SESSION_ENCRYPTION_KEY not found'); process.exit(1); }

function decrypt(s: string): unknown {
  if (!s.startsWith(`${VERSION_PREFIX}:`)) return JSON.parse(s);
  const parts = s.split(':');
  if (parts.length !== 4) throw new Error(`Invalid format: ${parts.length} parts`);
  const [, ivHex, encHex, tagHex] = parts;
  const d = crypto.createDecipheriv(ALGORITHM, Buffer.from(KEY, 'hex'), Buffer.from(ivHex!, 'hex'), { authTagLength: AUTH_TAG_LENGTH });
  d.setAuthTag(Buffer.from(tagHex!, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(encHex!, 'hex')), d.final()]).toString('utf8'));
}

const AUTH_COOKIES: Record<string, Array<{ name: string; domain: string }>> = {
  X: [{ name: 'auth_token', domain: 'x.com' }, { name: 'ct0', domain: 'x.com' }],
  THREADS: [{ name: 'sessionid', domain: 'threads.com' }],
  FACEBOOK: [{ name: 'c_user', domain: 'facebook.com' }, { name: 'xs', domain: 'facebook.com' }],
};

async function main() {
  const prisma = new PrismaClient();
  const sessions = await prisma.session.findMany({
    where: { status: 'ACTIVE' },
    include: { account: true },
    orderBy: { updatedAt: 'desc' },
  });

  const seen = new Set<string>();
  console.log('# Extracted auth cookies from active sessions');
  console.log('# Paste these into .env for stable cookie-auth:\n');

  for (const s of sessions) {
    const network = s.account.network;
    if (seen.has(network)) continue;
    seen.add(network);

    // storageState is Json in Prisma — could be string or object
    const raw = s.storageState;
    const storageStr = typeof raw === 'string' ? raw : JSON.stringify(raw);

    try {
      const data = decrypt(storageStr) as { cookies?: Array<{ name: string; value: string; domain: string }> };
      const cookies = data.cookies ?? [];
      const required = AUTH_COOKIES[network] ?? [];
      const auth = cookies.filter((c) => required.some((r) => c.name === r.name && c.domain.includes(r.domain)));

      if (auth.length === 0) {
        console.log(`# ${network}: no auth cookies found (${cookies.length} total cookies decrypted)`);
        // Debug: list all cookie names + domains
        console.log(`#   available cookies: ${cookies.map((c) => `${c.name}(${c.domain})`).join(', ')}\n`);
        continue;
      }
      const cookieStr = auth.map((c) => `${c.name}=${c.value}`).join('; ');
      console.log(`SOCIAL_${network}_COOKIES="${cookieStr}"`);
      console.log(`# (${auth.length} auth cookies: ${auth.map((c) => c.name).join(', ')})\n`);
    } catch (err) {
      console.log(`# ${network}: decrypt failed — ${(err as Error).message}`);
      console.log(`#   storageStr type: ${typeof raw}, starts with: ${storageStr.slice(0, 40)}...\n`);
    }
  }

  console.log('# Networks without active sessions:');
  for (const n of ['X', 'THREADS', 'FACEBOOK']) {
    if (!seen.has(n)) console.log(`#   ${n}: NO ACTIVE SESSION`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
