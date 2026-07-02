// Post-install patch for Playwright coreBundle.js — Camoufox/Juggler uncaughtError crash.
//
// Bug: Camoufox's Juggler protocol emits Page.uncaughtError WITHOUT a `location` field
// for some uncaught errors. Playwright's Firefox driver unconditionally dereferences
// `pageError.location.url` → TypeError: Cannot read properties of undefined (reading 'url').
// The crash is in the driver subprocess — it kills the browser and cannot be caught
// from the client. This breaks engagement browsing sessions (scroll_feed) on X/Threads.
//
// Upstream Playwright declined the defensive fix (PR #40982) because their own Firefox
// build always supplies location. Camoufox is a third-party Firefox build that doesn't
// uphold that invariant.
//
// Refs:
//   https://github.com/daijro/camoufox/issues/635
//   https://github.com/microsoft/playwright/issues/41046
//   https://github.com/microsoft/playwright/issues/41169
//
// This script patches three sites in coreBundle.js:
//   1. FFPage._onUncaughtError — fallback location when params.location is undefined
//   2. browserContextDispatcher — null-guard on pageError.location.{url,lineNumber,columnNumber}
//   3. tracing recorder — same null-guard
//
// Idempotent: skips if already patched (checks for the fallback marker).

'use strict';

const fs = require('fs');
const path = require('path');

function findCoreBundle() {
  // Resolve playwright-core from the backend package
  let pwDir;
  try {
    pwDir = path.dirname(require.resolve('playwright-core/package.json'));
  } catch {
    // playwright-core not installed (e.g. in CI without deps) — skip silently
    return null;
  }
  const coreBundle = path.join(pwDir, 'lib', 'coreBundle.js');
  if (!fs.existsSync(coreBundle)) {
    return null;
  }
  return coreBundle;
}

function patchFile(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');

  // Idempotency check — if the fallback marker is already present, skip.
  if (src.includes('params2.location ?? { url:')) {
    console.log('[patch-playwright] Already patched, skipping.');
    return false;
  }

  let patched = src;

  // ── Site 1: FFPage._onUncaughtError — root cause ──────────────────
  // Before: this._page.addPageError(error, params2.location);
  // After:  this._page.addPageError(error, params2.location ?? { url: '', lineNumber: 0, columnNumber: 0 });
  patched = patched.replace(
    /this\._page\.addPageError\(error,\s*params2\.location\);/,
    'this._page.addPageError(error, params2.location ?? { url: \'\', lineNumber: 0, columnNumber: 0 });',
  );

  // ── Sites 2 & 3: browserContextDispatcher + tracing recorder ──────
  // These dereference pageError.location.{url,lineNumber,columnNumber} without a guard.
  // Patch all occurrences of `pageError.location.url` → `(pageError.location||{url:'',lineNumber:0,columnNumber:0}).url`
  // and the corresponding .lineNumber / .columnNumber reads.
  patched = patched.replace(
    /pageError\.location\.(url|lineNumber|columnNumber)/g,
    '(pageError.location||{url:\'\',lineNumber:0,columnNumber:0}).$1',
  );

  if (patched === src) {
    console.log('[patch-playwright] WARNING: no patch sites matched — Playwright version may have changed.');
    return false;
  }

  fs.writeFileSync(filePath, patched, 'utf8');
  console.log('[patch-playwright] Patched', filePath);
  return true;
}

const coreBundle = findCoreBundle();
if (!coreBundle) {
  console.log('[patch-playwright] playwright-core/lib/coreBundle.js not found — skipping.');
  process.exit(0);
}

patchFile(coreBundle);
