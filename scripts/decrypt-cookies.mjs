// Decrypt storageState and extract auth cookies.
// Usage: node scripts/decrypt-cookies.mjs < /tmp/spa-encrypted-sessions.txt
// Reads SESSION_ENCRYPTION_KEY from .env (walks up from cwd).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;

// Find .env
function findEnvFile() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const c = path.join(dir, '.env');
    if (fs.existsSync(c)) return c;
    dir = path.dirname(dir);
  }
  throw new Error('.env not found');
}

const envContent = fs.readFileSync(findEnvFile(), 'utf8');
const envVars = {};
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

function decrypt(s) {
  if (!s.startsWith('v1:')) return JSON.parse(s);
  const [, ivHex, encHex, tagHex] = s.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(KEY, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8'));
}

const AUTH_COOKIES = {
  X: [{ name: 'auth_token', domain: 'x.com' }, { name: 'ct0', domain: 'x.com' }],
  THREADS: [{ name: 'sessionid', domain: 'threads.net' }],
  FACEBOOK: [{ name: 'c_user', domain: 'facebook.com' }, { name: 'xs', domain: 'facebook.com' }],
};

const seen = new Set();
const rl = readline.createInterface({ input: process.stdin });

console.log('# Extracted auth cookies from active sessions');
console.log('# Paste these into .env for stable cookie-auth:\n');

for await (const line of rl) {
  const sep = line.indexOf('|');
  if (sep < 0) continue;
  const network = line.slice(0, sep);
  const storageStr = line.slice(sep + 1).replace(/^"(.*)"$/, '$1');
  if (seen.has(network)) continue;
  seen.add(network);

  try {
    const data = decrypt(storageStr);
    const cookies = data.cookies ?? [];
    const required = AUTH_COOKIES[network] ?? [];
    const auth = cookies.filter((c) => required.some((r) => c.name === r.name && c.domain.includes(r.domain)));

    if (auth.length === 0) {
      console.log(`# ${network}: no auth cookies found (${cookies.length} total cookies decrypted)`);
      continue;
    }
    const cookieStr = auth.map((c) => `${c.name}=${c.value}`).join('; ');
    console.log(`SOCIAL_${network}_COOKIES="${cookieStr}"`);
    console.log(`# (${auth.length} auth cookies: ${auth.map((c) => c.name).join(', ')})\n`);
  } catch (err) {
    console.log(`# ${network}: decrypt failed — ${err.message}\n`);
  }
}

console.log('# Networks without active sessions:');
for (const n of ['X', 'THREADS', 'FACEBOOK']) {
  if (!seen.has(n)) console.log(`#   ${n}: NO ACTIVE SESSION`);
}
