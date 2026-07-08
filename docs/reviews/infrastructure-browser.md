# Module: `infrastructure/browser`

## 1. What this module does

`infrastructure/browser` is the Camoufox/Playwright automation layer for X, Threads, and Facebook. It owns:

- **`BrowserFactory`** (`browser.factory.ts`) — the adapter that implements the domain `IBrowserPort`. It launches Camoufox (a stealth-patched Firefox), manages a per-network pooled-context lifecycle for X/Threads and a persistent `user_data_dir` context for Facebook, applies memory-saving `firefox_user_prefs`, blocks heavy resources in read-only contexts, suppresses page-side JS errors, takes screenshots, and provides human-like typing/clicking/scrolling helpers.
- **`SelectorHealthService`** (`selector-health.service.ts`) — in-memory selector success/failure tracker intended to detect UI drift. It is exported but currently has no callers.
- **`BrowserModule`** (`browser.module.ts`) — registers `BrowserFactory`, `SelectorHealthService`, and the `IBrowserPort` provider. In dry-run mode it wraps the real factory with `DryRunBrowserPort`.
- **Sibling infra (reviewed because they are conceptually part of the browser stack):**
  - `infrastructure/proxy/proxy-rotation.service.ts` + `proxy.module.ts` — proxy pool/sticky-session service, gated by `PROXY_ROTATION_ENABLED`.
  - `infrastructure/captcha/captcha-solver.service.ts` + `captcha.module.ts` — 2Captcha integration for reCAPTCHA/hCaptcha, gated by `CAPTCHA_SOLVER_ENABLED`.
  - `scripts/patch-playwright.js` — post-install patch that null-guards `pageError.location` in `playwright-core/lib/coreBundle.js` to avoid the Camoufox/Juggler `Page.uncaughtError` driver crash (camoufox#635, playwright#41046/41169).

## 2. Key files & public API

| File | Role | Public API / notable exports |
|------|------|------------------------------|
| `infrastructure/browser/browser.factory.ts` | Camoufox adapter | `BrowserFactory` implements `IBrowserPort` + `OnModuleInit/Destroy`; 1165-line class handling launch, pool, persistent context, actions, screenshots, resource blocking, error suppression, patch verification. |
| `infrastructure/browser/browser.module.ts` | NestJS module | `BrowserModule` providers `BrowserFactory`, `SelectorHealthService`, and `IBrowserPort` (useFactory that swaps in `DryRunBrowserPort` when `SPA_DRY_RUN`). |
| `infrastructure/browser/selector-health.service.ts` | Selector drift tracker | `SelectorHealthService` (`recordSuccess`, `recordFailure`, `getStatus`, `getUnhealthySelectors`, `setAlertCallback`). |
| `domain/ports/browser.port.ts` | Hexagonal port | `IBrowserPort` Symbol + interface (`createContext`, `acquireContext`, `releaseContext`, `saveStorageState`, `humanType`, `typeHuman`, `humanClick`, `scrollPage`, `screenshot`, `applyResourceBlocking`, `suppressPageErrors`, etc.). |
| `domain/ports/browser-primitives.ts` | Type seam | Re-exports `Browser`, `BrowserContext`, `Locator`, `Page` from `playwright-core`; intended to be the only file that names `playwright-core`. |
| `dry-run/dry-run.browser-port.ts` | Dry-run wrapper | `DryRunBrowserPort` implements `IBrowserPort` and intercepts submit/engagement clicks; returns synthetic URLs. |
| `infrastructure/proxy/proxy-rotation.service.ts` | Proxy pool | `ProxyRotationService` (`getProxy`, `clearStickySession`, `getProxyPool`). |
| `infrastructure/proxy/proxy.module.ts` | Proxy module | `ProxyModule` — gated by `PROXY_ROTATION_ENABLED` in `app.module.ts`. |
| `infrastructure/captcha/captcha-solver.service.ts` | 2Captcha solver | `CaptchaSolverService` (`solve(page)`, `solveRecaptcha`, `solveHcaptcha`). |
| `infrastructure/captcha/captcha.module.ts` | Captcha module | `CaptchaModule` — gated by `CAPTCHA_SOLVER_ENABLED` in `app.module.ts`. |
| `scripts/patch-playwright.js` | Post-install patch | Idempotently patches `playwright-core/lib/coreBundle.js` for `Page.uncaughtError` null location. |

## 3. How it works

### 3.1 `BrowserFactory` lifecycle

- **Constructor** (`browser.factory.ts:109-171`) reads `ConfigService` for Camoufox, pool, memory, screenshot, and profile options, builds `firefoxUserPrefs` if `CAMOUFOX_MEMORY_PREFS=true`, and warns in production when `CAMOUFOX_PROFILE_DIR` is under `/tmp`.
- **Shared browser** (`getBrowser`, `browser.factory.ts:182-201`) uses a single in-flight launch promise so concurrent callers share one Camoufox binary/UBO-addon extraction.
- **Persistent Facebook context** (`getOrCreatePersistentContext` / `launchPersistentContext`, `browser.factory.ts:311-392`) launches Camoufox with `user_data_dir` under `CAMOUFOX_PROFILE_DIR`. Cookies/fingerprint persist on disk; the factory closes the persistent context when idle longer than `PERSISTENT_CONTEXT_IDLE_TTL_MS` (default 15 min).
- **Pooled X/Threads contexts** (`createContext` / `acquireContext` / `releaseContext`, `browser.factory.ts:411-625`) create a fresh `BrowserContext` from the shared `Browser`, `viewport: null` to avoid Camoufox conflicts, optionally restore `storageState` cookies, and return contexts to an idle pool for reuse.
- **Idle/orphan/lifetime sweep** (`sweepIdleContexts`, `browser.factory.ts:982-1068`) runs on a `Math.min(contextIdleTtlMs, 60000)` interval:
  - Evicts idle contexts past `BROWSER_CONTEXT_IDLE_TTL_MS` (default 3 min).
  - Reaps in-use contexts held longer than `BROWSER_ORPHAN_GRACE_MS` (default max(3×idle TTL, browsing+10 min)).
  - Restarts the shared `Browser` after `BROWSER_MAX_LIFETIME_MS` (default 15 min) when no contexts are in use.
  - Closes idle persistent (Facebook) contexts after `PERSISTENT_CONTEXT_IDLE_TTL_MS`.

### 3.2 Memory & resource optimizations

- **Memory prefs** (`buildMemoryPrefs`, `browser.factory.ts:210-242`) disables session history/restore, caps caches, tunes JS GC, lowers image decode chunk size, and disables telemetry. Applied to both browser and persistent contexts. `dom.ipc.processCount` is intentionally left untouched to preserve Camoufox's fission/web-content isolation for anti-detect.
- **Resource blocking** (`applyResourceBlocking`, `browser.factory.ts:921-939`) uses `page.route('**/*')` to abort `media`/`font` always and `image` when `blockImages=true` and `CAMOUFOX_BLOCK_IMAGES_READONLY=true`. Callers like `browsing-session.service.ts`, `trending-scraper.service.ts`, `replies-monitor.service.ts`, and `base.poster.ts#verifyPosted` pass `blockImages: true`. Posting/login paths do not.
- **Error suppression** (`suppressPageErrors`, `browser.factory.ts:894-900`) injects a `window.addEventListener` for `error`/`unhandledrejection` on every page and adds a no-op `pageerror` handler. This only catches page-side JS; the driver-side crash is fixed by the `coreBundle.js` patch.

### 3.3 Playwright patch (`scripts/patch-playwright.js`)

- The script locates `playwright-core/lib/coreBundle.js`.
- Site 1: changes `this._page.addPageError(error, params2.location);` to `this._page.addPageError(error, params2.location ?? { url: '', lineNumber: 0, columnNumber: 0 });`.
- Sites 2 & 3: replace all `pageError.location.{url,lineNumber,columnNumber}` with `(pageError.location||{url:'',lineNumber:0,columnNumber:0}).$1`.
- It is idempotent (checks for `params2.location ?? { url:`) and runs in `postinstall` and both Docker build stages.
- `BrowserFactory#verifyCamoufoxPatch` (`browser.factory.ts:1083-1111`) checks the bundle at runtime and logs an error if the marker is missing.

### 3.4 Dry-run wrapper

`dry-run/dry-run.browser-port.ts` wraps `BrowserFactory`. It proxies `Page` and `BrowserContext`:
- `humanClick` after non-login typing is intercepted, a screenshot is taken, and a synthetic post URL is returned.
- Engagement clicks are intercepted in engagement mode.
- `acquireContext` bypasses the pool and creates fresh contexts (to avoid storage-state issues). `releaseContext` closes the context.

### 3.5 Proxy and captcha services

- `ProxyRotationService` parses `PROXY_LIST` (comma-separated), supports `PROXY_GATEWAY_URL`, and provides sticky sessions per network for `PROXY_STICKY_MINUTES`.
- `CaptchaSolverService` detects reCAPTCHA/hCaptcha by `iframe[src*="recaptcha"]` / `iframe[src*="hcaptcha"]`, submits to `2captcha.com/in.php`, polls `res.php`, and injects the token into the hidden textarea.
- Neither service is currently invoked by `BrowserFactory`, posters, or `SessionsService`.

### 3.6 Camoufox pre-install fallback (`scripts/camoufox-preinstall.sh`)

- Runs in Docker build before the backend starts. First tries the JS `CamoufoxFetcher.install()` (3 attempts with backoff).
- Verifies `camoufox-bin` exists in `~/.cache/camoufox`.
- If missing (e.g. v152.0.2-alpha Linux zip has no binary, or AdmZip fails), falls back to downloading a known-good release `v150.0.2-beta.25` directly via `curl` and extracting with `unzip`.
- Writes a synthetic `version.json` so `camoufox-js` Version detection works.
- Exits non-fatally (`exit 0`) if fallback also fails; runtime will retry via `camoufox-js`.

## 4. Dependencies

**Downstream (called by this module):**
- `camoufox-js` (`Camoufox` launcher)
- `playwright-core` (types and runtime primitives)
- `@nestjs/config` `ConfigService`
- `infrastructure/config/parse-bool.js`
- `infrastructure/util/with-timeout.js`
- `domain/ports/browser.port.ts`, `domain/ports/browser-primitives.ts`

**Upstream (callers of this module):**
- `modules/posting/posting.service.ts` and `posters/*` — `acquireContext` / `releaseContext`, `humanClick`, `humanType`, etc.
- `modules/sessions/sessions.service.ts` — `createContext` and `saveStorageState` for login/cookie auth.
- `modules/engagement/browsing-session.service.ts` — `acquireContext`, `suppressPageErrors`, `applyResourceBlocking`.
- `modules/engagement/engagers/*` and `human-behavior-engine.ts` — browser actions.
- `modules/trending/trending-scraper.service.ts` — `acquireContext`, `applyResourceBlocking`, `suppressPageErrors`.
- `modules/replies/replies-monitor.service.ts` — same.
- `dry-run/dry-run.browser-port.ts` — wraps `BrowserFactory`.

## 5. Environment variables

| Variable | Default | Purpose | Where used |
|----------|---------|---------|------------|
| `CAMOUFOX_HEADLESS` | `true` | Run Camoufox headless | `browser.factory.ts:110` |
| `CAMOUFOX_HUMANIZE` | `true` | Human-like mouse movement | `browser.factory.ts:111` |
| `CAMOUFOX_GEOIP` | `true` | Geo/timezone/locale spoofing | `browser.factory.ts:112` |
| `CAMOUFOX_LOCALE` | `en-US` | Target locale | `browser.factory.ts:113` |
| `CAMOUFOX_OS` | `windows` | Fingerprint OS (`windows`/`macos`/`linux`) | `browser.factory.ts:114-117` |
| `CAMOUFOX_PROXY_URL` | `undefined` | Static proxy for Camoufox | `browser.factory.ts:118` / `launchBrowser` |
| `CAMOUFOX_PROFILE_DIR` | `/tmp/spa-profiles` | Persistent profile directory (Facebook) | `browser.factory.ts:151` |
| `CAMOUFOX_MEMORY_PREFS` | `true` | Enable memory-saving `firefox_user_prefs` | `browser.factory.ts:156` |
| `CAMOUFOX_IMAGE_DECODE_CHUNK` | `4096` | Image decode chunk size | `browser.factory.ts:157` |
| `CAMOUFOX_BLOCK_IMAGES_READONLY` | `true` | Gate image blocking in `applyResourceBlocking` | `browser.factory.ts:160` |
| `BROWSER_POOL_SIZE` | `1` | Max pooled contexts per network | `browser.factory.ts:130` |
| `BROWSER_POOL_ACQUIRE_TIMEOUT_MS` | `60000` | Wait timeout for a pooled context | `browser.factory.ts:131` |
| `BROWSER_CONTEXT_IDLE_TTL_MS` | `180000` (3 min) | Idle context eviction | `browser.factory.ts:134` |
| `BROWSER_ORPHAN_GRACE_MS` | `max(3×idle, browsing+10min)` | Orphaned context reap | `browser.factory.ts:139-142` |
| `BROWSER_MAX_LIFETIME_MS` | `900000` (15 min) | Shared browser restart | `browser.factory.ts:148` |
| `PERSISTENT_CONTEXT_IDLE_TTL_MS` | `900000` (15 min) | Facebook persistent idle close | `browser.factory.ts:146` |
| `F1_BROWSING_SESSION_MINUTES` | `15` | Used to compute orphan grace | `browser.factory.ts:139` |
| `SPA_SCREENSHOT_DIR` | `/tmp/spa-screenshots` | Screenshot path | `browser.factory.ts:119` |
| `SPA_SCREENSHOTS` | `false` | Enable screenshots | `browser.factory.ts:123` |
| `SPA_SCREENSHOT_FULLPAGE` | `false` | Full-page screenshots | `browser.factory.ts:124` |
| `SPA_DRY_RUN` | `false` | Enable `DryRunBrowserPort` | `browser.module.ts:16` |
| `PROXY_ROTATION_ENABLED` | `false` | Load `ProxyModule` | `app.module.ts:61` |
| `PROXY_LIST` | `''` | Comma-separated proxy list | `proxy-rotation.service.ts:38` |
| `PROXY_GATEWAY_URL` | `''` | Rotating proxy endpoint | `proxy-rotation.service.ts:34` |
| `PROXY_STICKY_MINUTES` | `10` | Sticky session duration | `proxy-rotation.service.ts:35` |
| `CAPTCHA_SOLVER_ENABLED` | `false` | Load `CaptchaModule` | `app.module.ts:60` |
| `TWO_CAPTCHA_API_KEY` | `''` | 2Captcha API key | `captcha-solver.service.ts:24` |
| `CAPTCHA_POLL_INTERVAL_MS` | `5000` | Polling interval | `captcha-solver.service.ts:25` |
| `CAPTCHA_MAX_POLL_ATTEMPTS` | `24` | Max polls | `captcha-solver.service.ts:26` |

None of the Camoufox/browser/proxy/captcha variables are listed in `env.validation.ts`.

## 6. Findings

### 6.1 Bugs / correctness

**B1. `SessionsService` leaks `BrowserContext` instances for X/Threads on every login and cookie-auth attempt.**
`sessions.service.ts` calls `this.browser.createContext(network)` in `tryCookieAuth` (line 330) and `autoLogin` (line 455). Both create a fresh `BrowserContext` for X/Threads, then `page.close()` but never `context.close()` on success or failure paths. `BrowserFactory` documents that callers must close non-persistent contexts (`browser.factory.ts:404-406`). Each missed close leaves a Camoufox/Firefox process resident until application restart. This is the most critical resource leak in the browser stack.

**B2. `getOrCreatePersistentContext` returns a cached context without checking whether it is closed.**
`browser.factory.ts:313` returns `cached` directly. It does not consult `this.closedContexts` or verify `context.browser()?.isConnected()`. If the persistent (Facebook) context is closed by a crash or an external event, the factory returns the dead context and subsequent operations fail immediately.

**B3. `ProxyRotationService` is built but never used.**
`ProxyRotationService` (`proxy-rotation.service.ts`) is enabled by `PROXY_ROTATION_ENABLED` and exported by `ProxyModule`, but `BrowserFactory` only reads `CAMOUFOX_PROXY_URL` (`browser.factory.ts:118`). There is no code path that calls `ProxyRotationService#getProxy`. Enabling the module therefore has no effect.

**B4. `parseProxyUrl` can produce an invalid proxy URL when no explicit port is given.**
`proxy-rotation.service.ts:111` builds `server: \`${parsed.protocol}//${parsed.hostname}:${parsed.port}\``. `new URL` returns an empty `parsed.port` for default ports (`http://proxy.example` or `http://proxy.example:80`?), producing `http://proxy.example:`. `ProxyRotationService` is currently unused, so this is latent, but if wired in it will produce broken proxy strings.

**B5. `CaptchaSolverService` is dead code and its 2Captcha protocol is likely wrong.**
No module calls `CaptchaSolverService#solve`. `BasePoster#isOnChallengePage` only checks URL strings; it does not invoke the captcha solver. Even if called, `submitAndPoll` (`captcha-solver.service.ts:129-172`) POSTs `application/json` to `2captcha.com/in.php` and `res.php`, but the 2Captcha API expects `application/x-www-form-urlencoded` or query parameters. After receiving a token, the code injects it into the hidden textarea but never triggers the site's `grecaptcha`/`hcaptcha` callback, so the form is unlikely to validate.

**B6. `SelectorHealthService` is exported but has no callers.**
`selector-strategy.ts` accepts an optional `healthTracking` argument (`selector-strategy.ts:54-72`) but `BasePoster` and `BaseEngager` call `waitForSelector` without passing it. The service is therefore an unused abstraction; selector drift is not actually tracked.

**B7. `applyResourceBlocking` discards route continuation promises without awaiting them.**
`browser.factory.ts:931-933` uses `void route.abort()` and `void route.continue()`. Playwright's `route.abort()`/`continue()` return `Promise<void>`; if either rejects, the discarded promise becomes an unhandled rejection. In practice this is rare, but it is not robust.

**B8. `browser.module.ts` uses `process.env.SPA_DRY_RUN` at module-load time.**
`browser.module.ts:16` reads `process.env.SPA_DRY_RUN` directly and lazy-loads `DryRunBrowserPort` via `require()`. The variable is not in `env.validation.ts` and is not read through `ConfigService`, so it cannot be changed without a restart and may be silently mis-typed.

**B9. `configService.get<number>` for `BROWSER_POOL_SIZE` and related numeric vars can yield `NaN`.**
`browser.factory.ts:130-148` uses `Math.max(..., this.configService.get<number>('...', default))`. Because `ConfigService` returns strings from `process.env`, `Math.max` will coerce them, but a malformed value such as `BROWSER_POOL_SIZE=foo` produces `NaN`. `env.validation.ts` does not validate these numeric variables, so a typo can render the pool math (`inUse.size + pending < this.poolSize`) always false, causing all `acquireContext` calls to hang until the wait timeout.

**B10. `getOrCreatePersistentContext`/`createContext` do not install a `close` listener for persistent contexts.**
Fresh X/Threads contexts get a `close` listener that adds them to `this.closedContexts` (`browser.factory.ts:440-443`), but the persistent Facebook path does not. A persistent context that dies externally is not marked closed, and the leak/return-dead-context bug in B2 applies.

**B11. `sessions.service.ts` health check and login paths do not call `suppressPageErrors` or `applyResourceBlocking`.**
`SessionsService` opens pages in `tryCookieAuth` (line 331), `autoLogin` (line 456), and `healthCheck` (line 1309) but never calls `IBrowserPort#suppressPageErrors` or `applyResourceBlocking`. The port docs state `suppressPageErrors` should be called "immediately after every `context.newPage()`" (`domain/ports/browser.port.ts:149-156`). Without it, uncaught page JS errors from X/Threads home/login pages can trigger the same driver crash the `coreBundle.js` patch mitigates, and the unblocked media-heavy pages consume more memory than necessary for read-only login/health-check operations.

**B12. `typeHuman` with a locator is unnecessarily per-character `pressSequentially`.**
`browser.factory.ts:714-731` loops over each character and calls `locator.pressSequentially(char, { delay })`. `pressSequentially` is designed for a full string; calling it once per character is less efficient and more chatty with the protocol, although it does produce the intended human-like delay.

**B13. `waitForStable` does not actually wait for stability.**
`browser.factory.ts:878-883` waits for `visible` then sleeps. It does not verify the element is no longer moving, so the name is misleading. Heavy animations may still interfere with the subsequent click.

**B14. `createContext` uses `JSON.parse(storageState) as never`.**
`browser.factory.ts:432` casts parsed storage state to `never`. This is a type-smell and can mask mismatches with Playwright's `storageState` option type. It should be typed as `Parameters<Browser['newContext']>[0]['storageState']`.

### 6.2 Performance

**P1. `BrowserFactory` is a 1165-line god class.**
It combines browser lifecycle, context pool management, persistent-profile handling, human-like actions, scrolling, screenshots, error suppression, resource blocking, memory-pref construction, and patch verification. This makes the file hard to test and reason about and should be split into `BrowserLifecycle`, `ActionHelpers`, and `ResourceBlocker` services.

**P2. `SessionsService` context leak (B1) wastes ~150-300 MB per login/health attempt.**
Each leaked `BrowserContext` keeps a Camoufox/Firefox process alive. In a system that re-logins on session expiry, this can exhaust container memory quickly.

**P3. `randomDelay` uses `setTimeout` without `unref()`, so long delays can keep the process alive.**
`browser.factory.ts:641-644` does not call `unref()` on the timer. In contexts like `postById` retry loops or thread-reply delays, a long random delay can prevent graceful shutdown.

**P4. `SelectorHealthService` keeps records for 30 days but prunes only hourly.**
This is acceptable for a small selector keyspace, but the TTL window is much longer than the operational relevance of UI drift. The in-memory Map also cannot be inspected across restarts.

**P5. `applyResourceBlocking` is invoked per-page instead of per-context.**
`page.route` is fast, but the call site pattern (every `newPage` in read-only paths) means route handlers are added repeatedly and may be redundant if pages are opened in a context that always blocks media.

### 6.3 Architecture / anti-patterns

**A1. `ProxyRotationService` and `CaptchaSolverService` are feature modules with no consumers.**
`app.module.ts` conditionally imports them (`captchaImports`, `proxyImports`) but no service calls them. This creates the illusion of anti-ban/captcha support while the implementation is dead. They should either be wired into `BrowserFactory`/`BasePoster` or removed.

**A2. `SelectorHealthService` is a dead abstraction.**
It is provided and exported but not integrated into `selector-strategy.ts`. The optional `healthTracking` parameter in `selector-strategy.ts` is never supplied, so the health stats never update.

**A3. The `browser-primitives` seam is bypassed in several places.**
`domain/ports/browser-primitives.ts` is supposed to be the only file that imports `playwright-core`, but:
- `domain/retry.ts:94` uses `import('playwright-core').Page`.
- `modules/engagement/engagers/base.engager.ts:313,399,444,573` uses `import('playwright-core').Locator`.
- `modules/engagement/engagement.service.ts:141` uses `import('playwright-core').Page`.

This undermines the central seam and makes driver swapping harder.

**A4. `DryRunBrowserPort` is coupled to `BrowserFactory` instead of `IBrowserPort`.**
`dry-run/dry-run.browser-port.ts:25` imports `BrowserFactory` and `constructor(private readonly real: BrowserFactory)`. It only uses `IBrowserPort` methods, so it should accept `IBrowserPort` to respect the hexagonal boundary.

**A5. `browser.module.ts` uses a dynamic `require()` for `DryRunBrowserPort`.**
`browser.module.ts:17-18` lazy-loads `DryRunBrowserPort` with `require()` to avoid a circular import. Since the package is `commonjs`, this works, but it bypasses TypeScript/bundler static analysis and the class is not tree-shaken or type-checked at compile time.

**A6. `applyResourceBlocking` and `suppressPageErrors` are opt-in per page.**
Callers must remember to invoke them after every `newPage`. This is error-prone, as shown by `SessionsService` missing them. The factory could wrap `newPage` or `BrowserContext` to apply these automatically for read-only operations.

**A7. `BrowserFactory` handles both pooled and persistent context concerns.**
The Facebook persistent path is special-cased throughout (`network === 'FACEBOOK'` in `createContext`, `acquireContext`, `releaseContext`, `sweepIdleContexts`). This branching is brittle and makes the code harder to extend to other networks that might need persistent profiles.

### 6.4 TypeScript / type safety

**T1. `JSON.parse(storageState) as never` in `createContext` should be a real type.**
`browser.factory.ts:432` casts the parsed storage state to `never`. It should be `Parameters<Browser['newContext']>[0]['storageState']`.

**T2. `Camoufox` returns are cast `as unknown as Browser` / `as unknown as BrowserContext`.**
`browser.factory.ts:268` and `browser.factory.ts:385` use `unknown` casts because `camoufox-js` does not ship strict types. If the library's return shape changes, the cast will compile but fail at runtime.

**T3. `page.viewportSize?.() as { width: number; height: number } | undefined` is an unnecessary cast.**
`browser.factory.ts:778` should use the return type from `Page#viewportSize` rather than `as`.

**T4. Non-null assertions are used in multiple hot paths.**
`browser.factory.ts:476` (`idle.pop()!`), `browser.factory.ts:597/617/1029` (`waiters.shift()!`), `browser.factory.ts:716` (`text[i]!`). These are safe under the current logic but make the code brittle to refactor.

**T5. `browser.module.ts` imports `parseBool` without the `.js` extension.**
`browser.module.ts:5` does `import { parseBool } from '../config/parse-bool'`, while `browser.factory.ts:13` uses `'../config/parse-bool.js'`. Although `type: commonjs`, the codebase otherwise uses `.js` in ESM-style imports, so this is inconsistent.

**T6. `IBrowserPort` is implemented by `BrowserFactory`, but `BrowserModule` also exports the concrete class.**
`browser.module.ts:26` exports `BrowserFactory`, which allows downstream modules to depend on the concrete class rather than the port. `DryRunBrowserPort` already does this (A4).

### 6.5 Security / reliability

**S1. Persistent Facebook profile stores plaintext cookies on disk.**
`browser.factory.ts:150-170` stores `c_user`/`xs` cookies under `CAMOUFOX_PROFILE_DIR`. A constructor warning is logged when `NODE_ENV=production` and the path is `/tmp`, but the app does not enforce a restricted/encrypted path. This is acknowledged in the code but remains a security risk if operators miss the log.

**S2. `verifyCamoufoxPatch` logs an error but does not fail startup when the patch is missing.**
`browser.factory.ts:1103-1107` logs an `error` if `coreBundle.js` is not patched. In production this is a reliability foot-gun: the first X/Threads feed scroll will crash the driver. Consider failing fast or disabling browser-dependent modules when the patch is missing.

**S3. `CaptchaSolverService` sends the API key to 2Captcha and parses the response without `res.ok` checks.**
`captcha-solver.service.ts:137` and `captcha-solver.service.ts:157` call `await res.json()` without checking `res.ok`. If 2Captcha returns an error page or rate-limit HTML, the JSON parse will throw and be swallowed, returning `false` without a clear diagnostic.

**S4. `proxy-rotation.service.ts` `parseProxyUrl` decodes credentials with `decodeURIComponent`.**
`proxy-rotation.service.ts:114-117` can throw on malformed percent-encoding. The whole `try` block is caught, so it falls back to `{ server: url }`, but then the username/password are silently lost. A malformed proxy URL should be logged loudly.

**S5. `suppressPageErrors` installs a global `window` error handler that suppresses all page errors.**
This is intentional to keep Camoufox alive, but it can mask real site issues that poster logic could use for diagnostics (e.g., challenge pages, network errors). It should be paired with logging or `page.on('console')` capture.

**S6. `browser.module.ts` dynamic `require` of `DryRunBrowserPort` is not guarded by `AUTH_ENABLED` or admin checks.**
`SPA_DRY_RUN` is a CLI flag, but if set in production via env, the module silently wraps the real browser. The `dry-run` CLI documentation (`CLAUDE.md`) treats `dry-run` as safe because it intercepts submit, but there is no runtime enforcement that prevents `SPA_DRY_RUN=true` from being used on a production deployment.

**S7. `BrowserFactory` `browser.on('disconnected')` does not wake waiters for the pooled context queue.**
When the browser disconnects, `inUse` and `idle` contexts are marked closed (`browser.factory.ts:274-288`), but `contextWaiters` are not resolved. If `acquireContext` is waiting when the browser crashes, it will wait the full `BROWSER_POOL_ACQUIRE_TIMEOUT_MS` before failing. `onModuleDestroy` does reject waiters, but a runtime crash does not.

## 7. New feature / improvement ideas

1. **Fix the `SessionsService` context leak.** Add `context.close()` in `tryCookieAuth` and `autoLogin` for non-Facebook contexts after `saveStorageState`/`page.close()`.
2. **Integrate `ProxyRotationService` into `BrowserFactory` or remove it.** If proxy rotation is needed, `getProxy(network)` should be used per `launchBrowser`/`createContext` and sticky sessions should be cleared on bans. If not needed, delete the modules and env vars to avoid confusion.
3. **Wire `CaptchaSolverService` into `BasePoster#isOnChallengePage` and `SessionsService` login flows** or remove it. If kept, rewrite `submitAndPoll` to use `application/x-www-form-urlencoded` and trigger the captcha callback after token injection.
4. **Use `SelectorHealthService` in `selector-strategy.ts` or delete it.** If selector drift monitoring is desired, pass the health service from `BasePoster`/`BaseEngager` into `waitForSelector`.
5. **Split `BrowserFactory` into smaller services.** Extract `BrowserLifecycleManager`, `PooledContextManager`, `PersistentContextManager`, `ActionHelper`, `ResourceBlocker`, and `ScreenshotService`.
6. **Add `env.validation.ts` entries for all browser variables.** Validate `CAMOUFOX_*`, `BROWSER_*`, `SPA_DRY_RUN`, `PROXY_*`, and `CAPTCHA_*` with numeric checks.
7. **Make `suppressPageErrors` and `applyResourceBlocking` automatic for read-only contexts.** Wrap `newPage` or the context so callers cannot forget them.
8. **Enforce the `browser-primitives` seam.** Replace `import('playwright-core')` in `domain/retry.ts`, `base.engager.ts`, and `engagement.service.ts` with imports from `domain/ports/browser-primitives`.
9. **Fail fast on missing Camoufox patch in production.** `verifyCamoufoxPatch` should throw when `NODE_ENV=production` and the marker is not found.
10. **Add `context.close()`/`browser()` liveness check in `getOrCreatePersistentContext`.** Guard against returning closed/dead persistent contexts.
11. **Fix `parseProxyUrl` default-port handling.** Avoid producing `http://host:` URLs and log on malformed URLs.
12. **Add `unref()` to `randomDelay` timers** (or wrap with `withTimeout` style) so long delays don't block process shutdown.

## 8. Cross-references

- `modules/posting/posting.service.ts` — `acquireContext`/`releaseContext` lifecycle, context crash recovery in `withRetry`.
- `modules/posting/posters/base.poster.ts` — `verifyPosted` uses `applyResourceBlocking` with `blockImages: true`.
- `modules/posting/posters/x.poster.ts` / `threads.poster.ts` / `facebook.poster.ts` — call `suppressPageErrors` after `newPage`.
- `modules/sessions/sessions.service.ts` — creates `createContext` contexts but does not close them; health check missing `suppressPageErrors`/`applyResourceBlocking`.
- `modules/engagement/browsing-session.service.ts` — correctly applies `suppressPageErrors` and `applyResourceBlocking`.
- `modules/engagement/engagers/base.engager.ts` — bypasses `browser-primitives` with `import('playwright-core').Locator`.
- `modules/engagement/engagement.service.ts` — bypasses `browser-primitives` with `import('playwright-core').Page`.
- `modules/replies/replies-monitor.service.ts` — uses `applyResourceBlocking`/`suppressPageErrors`.
- `modules/trending/trending-scraper.service.ts` — uses `applyResourceBlocking`/`suppressPageErrors`.
- `domain/retry.ts` — `navigateWithRetry` uses `import('playwright-core').Page`.
- `domain/ports/browser-primitives.ts` — intended single seam for `playwright-core` types.
- `app.module.ts` — feature-flags `CaptchaModule` and `ProxyModule`.
- `infrastructure/config/env.validation.ts` — does not validate browser/proxy/captcha env variables.
- `AGENTS.md` — "Playwright coreBundle.js post-install patch" and "Browser memory optimization" sections describe the intent behind `patch-playwright.js` and `firefox_user_prefs`.
- `docker/Dockerfile.backend` — runs `patch-playwright.js` in builder and production stages.
- `packages/backend/package.json` — `postinstall` script runs `patch-playwright.js` (errors suppressed with `2>/dev/null`).

## 9. Overall assessment

**Health score: 6 / 10**

The browser infrastructure is impressively tuned for Camoufox's memory and reliability issues: it has a working context pool, idle/orphan/lifetime sweeps, persistent Facebook context support, deliberate `firefox_user_prefs` tuning, per-page resource blocking, and the `coreBundle.js` patch for the uncaught-error driver crash. The separation between `IBrowserPort`, `BrowserFactory`, and `DryRunBrowserPort` is a solid hexagonal foundation.

However, the critical `BrowserContext` leak in `SessionsService` (B1) means every X/Threads login or cookie-auth attempt leaks a Camoufox process, which will quickly exhaust memory in long-running deployments. Three major feature-flagged services (`ProxyRotationService`, `CaptchaSolverService`, `SelectorHealthService`) are built but not wired into anything, creating dead code and a false sense of capability. The `browser-primitives` seam is violated in several places, and the `BrowserFactory` has become a 1165-line god class that is hard to test and extend. The proxy URL parser has a latent default-port bug, and the captcha solver's API protocol is likely incorrect. Env validation for browser-related variables is missing entirely.

**Top recommended next actions:**

1. **Close `BrowserContext` in `SessionsService` `tryCookieAuth` and `autoLogin` for non-Facebook networks** — this is the highest-impact leak (B1).
2. **Decide the fate of `ProxyRotationService` and `CaptchaSolverService`** — either wire them into `BrowserFactory`/`BasePoster`/`SessionsService` or delete them.
3. **Validate `CAMOUFOX_*`, `BROWSER_*`, `SPA_DRY_RUN`, `PROXY_*`, and `CAPTCHA_*` env variables** in `env.validation.ts` with numeric checks.
4. **Integrate `SelectorHealthService` into `selector-strategy.ts` or remove it** to avoid a dead abstraction.
5. **Enforce the `browser-primitives` type seam** by removing direct `import('playwright-core')` usage in `domain/retry.ts`, `base.engager.ts`, and `engagement.service.ts`.
6. **Refactor `BrowserFactory` into smaller lifecycle/action services** to reduce the god-class surface and improve testability.
7. **Fail fast on a missing Camoufox patch when `NODE_ENV=production`** to avoid runtime driver crashes.
