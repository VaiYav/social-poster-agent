#!/usr/bin/env npx tsx
// Extract auth cookies from encrypted sessions and print as SOCIAL_*_COOKIES env format.
// Usage: npx tsx scripts/extract-cookies.ts
//
// Reads SESSION_ENCRYPTION_KEY from .env, decrypts active sessions from DB,
// extracts auth cookies, and prints env-var-ready strings.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Load .env manually (no NestJS needed) ──
// Walk up from cwd to find .env (handles running from packages/backend or repo root)
function findEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('.env not found in any parent directory');
}
const envPath = findEnvFile();
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match && !match[1].startsWith('#')) {
    // Strip inline comments and trim
    let value = match[2];
    const commentIdx = value.indexOf(' #');
    if (commentIdx >= 0) value = value.slice(0, commentIdx);
    envVars[match[1]] = value.trim();
  }
}

const ENCRYPTION_KEY = envVars.SESSION_ENCRYPTION_KEY;
const DATABASE_URL = envVars.DATABASE_URL;

if (!ENCRYPTION_KEY) {
  console.error('SESSION_ENCRYPTION_KEY not found in .env');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL not found in .env');
  process.exit(1);
}

// ── Decryption (mirrors EncryptionService) ──
const ALGORITHM = 'aes-256-gcm';
const VERSION_PREFIX = 'v1';
const AUTH_TAG_LENGTH = 16;

function decrypt(encryptedString: string): unknown {
  if (!encryptedString.startsWith(`${VERSION_PREFIX}:`)) {
    return JSON.parse(encryptedString);
  }
  const parts = encryptedString.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted format');
  const [, ivHex, encryptedHex, authTagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const encrypted = Buffer.from(encryptedHex!, 'hex');
  const authTag = Buffer.from(authTagHex!, 'hex');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ── Auth cookie specs (mirrors sessions.service.ts AUTH_COOKIES) ──
const AUTH_COOKIES: Record<string, Array<{ name: string; domain: string }>> = {
  X: [
    { name: 'auth_token', domain: 'x.com' },
    { name: 'ct0', domain: 'x.com' },
  ],
  THREADS: [{ name: 'sessionid', domain: 'threads.net' }],
  FACEBOOK: [
    { name: 'c_user', domain: 'facebook.com' },
    { name: 'xs', domain: 'facebook.com' },
  ],
};

// ── Query DB directly via pg ──
async function main(): Promise<void> {
  // Parse DATABASE_URL: postgresql://spa:spa@localhost:5433/social_poster
  const url = new URL(DATABASE_URL);
  const pgHost = url.hostname;
  const pgPort = parseInt(url.port || '5432', 10);
  const pgUser = url.username;
  const pgPassword = url.password;
  const pgDatabase = url.pathname.slice(1);

  // Dynamic import pg (Prisma's pg dependency)
  const { Client } = await import('pg');
  const client = new Client({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPassword,
    database: pgDatabase,
  });
  await client.connect();

  const res = await client.query(`
    SELECT s."accountId", a.network, s.status, s."storageState"::text as storage_text
    FROM "Session" s
    JOIN "SocialAccount" a ON s."accountId" = a.id
    WHERE s.status = 'ACTIVE'
    ORDER BY a.network, s."updatedAt" DESC
  `);

  const seen = new Set<string>();
  console.log('# Extracted auth cookies from active sessions');
  console.log('# Format: SOCIAL_<NETWORK>_COOKIES="name1=value1; name2=value2"');
  console.log();

  for (const row of res.rows) {
    const network = row.network as string;
    if (seen.has(network)) continue; // first active session per network
    seen.add(network);

    try {
      const decrypted = decrypt(row.storage_text as string) as {
        cookies?: Array<{ name: string; value: string; domain: string }>;
      };
      const cookies = decrypted.cookies ?? [];
      const required = AUTH_COOKIES[network] ?? [];
      const authCookies = cookies.filter((c) =>
        required.some((r) => c.name === r.name && c.domain.includes(r.domain)),
      );

      if (authCookies.length === 0) {
        console.log(`# ${network}: no auth cookies found in session (decrypted ${cookies.length} total cookies)`);
        continue;
      }

      const cookieStr = authCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const envName = `SOCIAL_${network}_COOKIES`;
      console.log(`${envName}="${cookieStr}"`);
      console.log(`# (${authCookies.length} auth cookies: ${authCookies.map((c) => c.name).join(', ')})`);
    } catch (err) {
      console.log(`# ${network}: failed to decrypt — ${(err as Error).message}`);
    }
  }

  console.log();
  console.log('# Networks without active sessions:');
  for (const net of ['X', 'THREADS', 'FACEBOOK']) {
    if (!seen.has(net)) console.log(`#   ${net}: NO ACTIVE SESSION`);
  }

  await client.end();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
