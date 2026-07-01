import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { DiscordNotificationService } from '../../infrastructure/notifications/discord-notification.service.js';
import { SessionStatus, SocialNetwork, type Prisma } from '@prisma/client';
import { withRetry, navigateWithRetry, type RetryOptions } from '../../domain/retry.js';
import { CircuitBreakerRegistry, CircuitOpenError } from '../../domain/circuit-breaker.js';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { EmailReaderService } from '../../infrastructure/email/email-reader.service.js';

/**
 * Session manager — persistent browser sessions via Playwright storageState.
 *
 * - Saves cookies + localStorage after each posting session
 * - Restores on next posting to avoid frequent logins
 * - Health check: verify session is still valid before posting
 * - Auto-login: if session expired, login from env credentials (OQ-8: auto-login)
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  // In-memory lock per network to prevent race conditions in session creation.
  // If two concurrent calls try to create a session for the same network, the second
  // waits for the first to complete, then re-checks for an existing ACTIVE session.
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  // Login page selectors per network
  // X-only fields (nextButton, twoFactorInput, twoFactorConfirm, accountSwitcher) are
  // included as empty strings in THREADS/FACEBOOK for type union compatibility — X is the
  // only network with a multi-step onboarding wizard + 2FA (stealth-x Step 1.5/3).
  private readonly LOGIN_SELECTORS = {
    X: {
      // X uses onboarding wizard (/i/flow/login → /i/jf/onboarding/web?mode=login)
      // Multi-step wizard: Step 1 = username → Next → Step 2 = password → Log in → /home
      // Selectors aligned with stealth-x (Youhai020616/stealth-x) — same Camoufox + Playwright stack.
      url: 'https://x.com/i/flow/login',
      usernameInput: 'input[name="text"][autocomplete="username"], input[autocomplete="username"], input[name="text"], input[name="username_or_email"], #jf-input-username_or_email',
      passwordInput: 'input[name="password"], input[type="password"], input[autocomplete="current-password"]',
      // "Next" button — submits the username step (stealth-x separates Next from Log in)
      nextButton: '[data-testid="LoginForm_Login_Button"], button[role="button"]:has-text("Next"), div[role="button"]:has-text("Next"), button[type="submit"]:has-text("Continue")',
      // "Log in" button — submits the password step
      submitButton: '[data-testid="LoginForm_Login_Button"], button[role="button"]:has-text("Log in"), div[role="button"]:has-text("Log in"), button[type="submit"]',
      // 2FA / identity verification input (stealth-x Step 1.5 / Step 3)
      // X uses ocfEnterTextTextInput for both 2FA code and "enter phone/email to verify identity"
      twoFactorInput: 'input[data-testid="ocfEnterTextTextInput"], input[name="text"][type="text"]',
      twoFactorConfirm: '[data-testid="ocfEnterTextNextButton"], button[role="button"]:has-text("Next"), div[role="button"]:has-text("Next")',
      // Account switcher — most reliable logged-in indicator (stealth-x checkLoggedIn)
      // aria-label format: "Account menu, Accounts: @username"
      accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
      // After login, X shows the home timeline
      successIndicator: '[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_NewTweet_Button"], a[href="/home"], [data-testid="primaryColumn"], [data-testid="AppTabBar_Profile_Link"]',
    },
    THREADS: {
      url: 'https://www.threads.com/login',
      usernameInput: 'input[aria-label*="Username"], input[aria-label*="username"], input[placeholder*="Username"], input[placeholder*="username"]',
      passwordInput: 'input[aria-label*="Password"], input[aria-label*="password"], input[type="password"]',
      nextButton: '',
      submitButton: 'div[role="button"]:has-text("Log in"):not(:has-text("Instagram")), button:has-text("Log in"):not(:has-text("Instagram"))',
      twoFactorInput: '',
      twoFactorConfirm: '',
      accountSwitcher: '',
      // After login, Threads shows "New thread" button in the nav
      successIndicator: 'button:has-text("New thread"), div[role="button"]:has-text("New thread"), a[href="/compose"], button[aria-label="Create"], button:has-text("Create")',
    },
    FACEBOOK: {
      // Use mbasic.facebook.com (basic mobile) for login — simplest HTML, stable IDs,
      // least anti-automation detection. Cookies work on www.facebook.com (same domain).
      // Reference: tas33n/fb-login-bot (m.facebook.com), ramasedang/facebook-page-scraper (mbasic)
      url: 'https://mbasic.facebook.com/login',
      // mbasic login page has stable IDs: #m_login_email, #m_login_password
      usernameInput: '#m_login_email, input[name="email"], input#email, input[aria-label*="Email"]',
      passwordInput: '#m_login_password, input[name="pass"], input#pass, input[type="password"]',
      nextButton: '',
      // mbasic uses <input type="submit" value="Log In"> or <button value="Log In">
      submitButton: 'input[value="Log In"], button[value="Log In"], button:has-text("Log in"), button[name="login"], button[type="submit"]',
      twoFactorInput: '',
      twoFactorConfirm: '',
      accountSwitcher: '',
      // After login, mbasic FB shows navigation links
      successIndicator: 'a[href*="/home"], a[href*="/profile"], a[href*="/settings"], nav, [role="navigation"]',
    },
  };

  private readonly circuitBreakers: CircuitBreakerRegistry = new CircuitBreakerRegistry();

  // SE1: throttle username/password form logins (the top "suspicious login" trigger).
  private readonly lastFormLoginAt = new Map<string, number>();
  private readonly formLoginCooldownMs: number;
  // SE1: when true, latency/ban-sensitive callers (posting) never form-login inline —
  // they defer (return null → retry) and an out-of-band cron performs the controlled re-login.
  private readonly deferredLogin: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountsService: AccountsService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly discord: DiscordNotificationService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly emailReader: EmailReaderService,
  ) {
    // Default 0 = cooldown disabled (opt-in). Operators set FORM_LOGIN_COOLDOWN_MS in prod
    // (e.g. 1800000 = 30 min) to throttle the riskiest action; keeping it off by default
    // avoids surprising the inline-login path and keeps tests deterministic.
    const rawCooldown = Number(this.configService.get<string>('FORM_LOGIN_COOLDOWN_MS', '0'));
    this.formLoginCooldownMs = Number.isFinite(rawCooldown) && rawCooldown >= 0 ? rawCooldown : 0;
    this.deferredLogin = parseBool(this.configService.get<string>('SESSION_DEFERRED_LOGIN', 'false'));
  }

  async getOrCreateSession(network: SocialNetwork, opts: { deferFormLogin?: boolean } = {}) {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) return null;

    // Find active session — fast path, no lock needed
    const session = await this.prisma.session.findFirst({
      where: { accountId: account.id, status: SessionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });

    if (session) {
      this.logger.debug(`Found active session for ${network}`);
      return session;
    }

    // No active session — acquire per-network lock to prevent race condition
    // where multiple concurrent calls all try to auto-login simultaneously
    const lockKey = `login:${network}`;
    const existingLock = this.sessionLocks.get(lockKey);
    if (existingLock) {
      // Another call is already creating a session — wait for it, then re-check DB
      this.logger.debug(`Waiting for in-flight session creation for ${network}...`);
      await existingLock.catch(() => {});
      // Re-check: the other call may have created a session
      const newSession = await this.prisma.session.findFirst({
        where: { accountId: account.id, status: SessionStatus.ACTIVE },
        orderBy: { createdAt: 'desc' },
      });
      if (newSession) {
        this.logger.debug(`Session created by concurrent call for ${network}`);
        return newSession;
      }
      // Still no session — proceed to create one (fall through to lock acquisition)
    }

    // Acquire lock for session creation
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve; });
    this.sessionLocks.set(lockKey, lockPromise);

    try {
      // Double-check after acquiring lock (another call may have created a session)
      const existingSession = await this.prisma.session.findFirst({
        where: { accountId: account.id, status: SessionStatus.ACTIVE },
        orderBy: { createdAt: 'desc' },
      });
      if (existingSession) {
        this.logger.debug(`Session created by concurrent call for ${network} (after lock)`);
        return existingSession;
      }

      // No active session — auto-login from env credentials (OQ-8)
      // Circuit breaker: if login has failed repeatedly, skip to avoid IP bans
      const breaker = this.circuitBreakers.get(`login:${network}`, {
        failureThreshold: 3,
        resetTimeoutMs: 900000, // 15 min — same as twscrape's lock duration
        failureWindowMs: 600000, // 10 min window
      });

      if (!breaker.canExecute()) {
        this.logger.warn(
          `Login circuit breaker OPEN for ${network} — skipping auto-login (${Math.ceil(breaker.resetInMs / 1000)}s until reset)`,
        );
        return null;
      }

      this.logger.log(`No active session for ${network} — starting auto-login`);
      try {
        // First, try cookie-based auth (more stable than username/password login).
        // Reference: twscrape prefers cookie-based auth (auth_token + ct0 for X).
        // If cookies are provided in env, use them directly — no login form needed.
        const cookieSession = await this.tryCookieAuth(network);
        if (cookieSession) {
          return cookieSession;
        }

        // SE1: username/password form login is the highest "suspicious login" risk.
        // (a) Deferral: a ban-sensitive caller (posting) must not form-login inline when
        //     SESSION_DEFERRED_LOGIN is on — return null so it retries while the out-of-band
        //     refreshSessionsCron performs the controlled re-login.
        if (opts.deferFormLogin && this.deferredLogin) {
          this.logger.warn(
            `No cookie session for ${network} and inline form-login is deferred (SESSION_DEFERRED_LOGIN) — caller should retry`,
          );
          return null;
        }
        // (b) Cooldown: never form-login again within the cooldown window (throttle frequency,
        //     even across failed attempts — set the marker before attempting).
        const lastLogin = this.lastFormLoginAt.get(network) ?? 0;
        const sinceMs = Date.now() - lastLogin;
        if (sinceMs < this.formLoginCooldownMs) {
          this.logger.warn(
            `Form-login cooldown active for ${network} (${Math.ceil((this.formLoginCooldownMs - sinceMs) / 1000)}s left) — skipping form login`,
          );
          return null;
        }
        // (c) Alert on the risky action, then attempt the form login. Alerting is best-effort
        // and must never block login (and discord.warning may be a no-op in some setups/tests).
        try {
          await this.discord.warning(
            'Form Login Performed',
            `Falling back to username/password form login for **${network}** — the highest "suspicious login" risk. Cookie auth is preferred; check the session/cookie config.`,
          );
        } catch {
          // non-blocking
        }
        this.lastFormLoginAt.set(network, Date.now());
        return await breaker.execute(() => this.autoLogin(network));
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          this.logger.warn(`Login circuit tripped for ${network}: ${err.message}`);
          return null;
        }
        throw err;
      }
    } finally {
      resolveLock();
      this.sessionLocks.delete(lockKey);
    }
  }

  /**
   * SE1: out-of-band controlled re-login. When SESSION_DEFERRED_LOGIN is on, posting no longer
   * form-logs-in inline — it defers. This cron proactively (re)establishes a session per network
   * off the posting path, subject to the same cookie-first + cooldown + circuit-breaker + alert
   * guards in getOrCreateSession. No-op when deferral is off (current inline behavior).
   */
  @Cron(process.env.SESSION_RELOGIN_CRON ?? '*/15 * * * *')
  async refreshSessionsCron(): Promise<void> {
    if (!this.deferredLogin) return;
    for (const network of Object.values(SocialNetwork)) {
      try {
        await this.getOrCreateSession(network); // no deferFormLogin → controlled form login allowed here
      } catch (err) {
        this.logger.warn(`Out-of-band session refresh failed for ${network}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Cookie-based authentication — import cookies from env vars.
   *
   * This is more stable than username/password login because it bypasses
   * the login form entirely. Cookies can be extracted from a browser session
   * and set as env vars.
   *
   * Supported env vars (per network):
   *   X: SOCIAL_X_COOKIES — format: "auth_token=xxx; ct0=yyy"
   *   THREADS: SOCIAL_THREADS_COOKIES — format: "sessionid=xxx"
   *   FACEBOOK: SOCIAL_FACEBOOK_COOKIES — format: "c_user=xxx; xs=yyy"
   *
   * Reference: twscrape's add_cookie() method accepts the same format.
   *
   * @returns A session if cookie auth succeeded, null otherwise.
   */
  private async tryCookieAuth(network: SocialNetwork) {
    const credPrefix = `SOCIAL_${network === 'X' ? 'X' : network === 'THREADS' ? 'THREADS' : 'FACEBOOK'}_`;
    const cookieStr = this.configService.get<string>(`${credPrefix}COOKIES`, '');

    if (!cookieStr || cookieStr.trim() === '') {
      return null;
    }

    this.logger.log(`Found ${network} cookies in env — attempting cookie-based auth`);

    const account = await this.accountsService.findByNetwork(network);
    if (!account) return null;

    // Parse cookie string: "name1=value1; name2=value2"
    const cookies = this.parseCookieString(cookieStr, network);
    if (cookies.length === 0) {
      this.logger.warn(`Failed to parse ${network} cookies from env — invalid format`);
      return null;
    }

    // Validate required auth cookies are present
    const requiredCookies = this.AUTH_COOKIES[network] ?? [];
    const missingRequired = requiredCookies.filter(
      (req) => !cookies.some((c) => c.name === req.name),
    );
    if (missingRequired.length > 0) {
      this.logger.warn(
        `Cookie auth for ${network}: missing required cookies: ${missingRequired.map((c) => c.name).join(', ')}`,
      );
      return null;
    }

    let context: Awaited<ReturnType<IBrowserPort['createContext']>> | null = null;
    try {
      context = await this.browser.createContext(network);
      const page = await context.newPage();

      // Add cookies to the browser context
      await context.addCookies(cookies);

      // Navigate to the network's home page to verify cookies are valid
      const checkUrl = network === 'X' ? 'https://x.com/home' :
        network === 'THREADS' ? 'https://www.threads.com/' :
        'https://www.facebook.com/';
      await navigateWithRetry(page, checkUrl, {
        waitUntil: 'domcontentloaded',
        timeoutMs: 30000,
        maxRetries: 2,
      });
      await this.browser.randomDelay(3000, 5000);

      // Check if we're logged in (not redirected to login)
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
        this.logger.warn(`Cookie auth for ${network} failed — redirected to login (${currentUrl})`);
        await page.close();
        return null;
      }

      // Verify auth cookies are still present (not cleared by the server)
      const browserCookies = await context.cookies();
      const stillHasAuth = requiredCookies.every((req) =>
        browserCookies.some((c) => c.name === req.name && c.domain.includes(req.domain)),
      );
      if (!stillHasAuth) {
        this.logger.warn(`Cookie auth for ${network} failed — auth cookies were cleared by server`);
        await page.close();
        return null;
      }

      // Success — save session
      this.logger.log(`Cookie auth successful for ${network} (URL: ${currentUrl})`);
      await this.browser.screenshot(page, network, 'after-login');
      const storageState = await this.browser.saveStorageState(context);
      await page.close();

      const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
      const session = await this.prisma.session.create({
        data: {
          accountId: account.id,
          storageState: encrypted as unknown as Prisma.InputJsonValue,
          status: SessionStatus.ACTIVE,
          lastHealthCheck: new Date(),
        },
      });
      this.logger.log(`Cookie auth session created for ${network}, session ${session.id}`);
      return session;
    } catch (err) {
      this.logger.error(`Cookie auth failed for ${network}: ${(err as Error).message}`);
      try {
        if (context) {
          const page = context.pages()[0];
          if (page) await this.browser.screenshot(page, network, 'on-error');
        }
      } catch {}
      return null;
    }
  }

  /**
   * Parse a cookie string into Playwright cookie objects.
   * Format: "name1=value1; name2=value2"
   * Adds domain and path based on the network.
   */
  private parseCookieString(
    cookieStr: string,
    network: SocialNetwork,
  ): Array<{ name: string; value: string; domain: string; path: string }> {
    const domain = network === 'X' ? '.x.com' :
      network === 'THREADS' ? '.threads.net' :
      '.facebook.com';

    const cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];

    for (const part of cookieStr.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!name || !value) continue;
      cookies.push({ name, value, domain, path: '/' });
    }

    return cookies;
  }

  /**
   * Auto-login: open browser, fill credentials from env, save session.
   * OQ-8: agent logs in itself from env credentials on first run.
   */
  private async autoLogin(network: SocialNetwork) {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) return null;

    // Get credentials from env
    const credPrefix = `SOCIAL_${network === 'X' ? 'X' : network === 'THREADS' ? 'THREADS' : 'FACEBOOK'}_`;
    const username = this.configService.get<string>(`${credPrefix}USERNAME`) ??
      this.configService.get<string>(`${credPrefix}EMAIL`, '');
    const password = this.configService.get<string>(`${credPrefix}PASSWORD`, '');

    if (!password || !username) {
      this.logger.error(
        `Incomplete credentials in env for ${network} — both username/email and password are required`,
      );
      return null;
    }

    const selectors = this.LOGIN_SELECTORS[network];
    if (!selectors) {
      this.logger.error(`No login selectors for ${network}`);
      return null;
    }

    this.logger.log(`Auto-login ${network} as ${username}`);

    let context: Awaited<ReturnType<IBrowserPort['createContext']>> | null = null;
    try {
      context = await this.browser.createContext(network);
      const page = await context.newPage();

      // Facebook: persistent context may already have valid cookies from previous run.
      // Check for c_user cookie before attempting login — skip login if already authenticated.
      if (network === 'FACEBOOK') {
        const existingCookies = await context.cookies();
        const cUser = existingCookies.find(
          (c) => c.name === 'c_user' && c.domain.includes('facebook.com'),
        );
        if (cUser) {
          this.logger.log(
            `Facebook: found existing c_user cookie (user ID: ${cUser.value}) — checking if session is still valid`,
          );
          // Navigate to Facebook home to verify session
          await navigateWithRetry(page, 'https://www.facebook.com/', {
            waitUntil: 'domcontentloaded',
            timeoutMs: 30000,
            maxRetries: 2,
          });
          await this.browser.randomDelay(3000, 5000);
          const currentUrl = page.url();
          // If we're NOT redirected to login, session is valid
          if (!currentUrl.includes('/login') && !currentUrl.includes('two_step') && !currentUrl.includes('checkpoint')) {
            this.logger.log(`Facebook: session still valid (URL: ${currentUrl}) — skipping login`);
            await this.browser.screenshot(page, network, 'after-login');
            const storageState = await this.browser.saveStorageState(context);
            await page.close();
            const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
            const session = await this.prisma.session.create({
              data: {
                accountId: account.id,
                storageState: encrypted as unknown as Prisma.InputJsonValue,
                status: SessionStatus.ACTIVE,
                lastHealthCheck: new Date(),
              },
            });
            this.logger.log(`Auto-login successful for ${network}, session ${session.id} created (persistent cookies)`);
            return session;
          }
          this.logger.warn(`Facebook: c_user cookie found but session invalid (URL: ${currentUrl}) — proceeding with login`);
        } else {
          this.logger.log(`Facebook: no c_user cookie found — proceeding with login`);
        }
      }

      // Navigate to login page — with retry on network/timeout errors
      await navigateWithRetry(page, selectors.url, {
        waitUntil: 'domcontentloaded',
        timeoutMs: 30000,
        maxRetries: 3,
        onRetry: (attempt, delayMs, err) => {
          this.logger.warn(
            `Login page navigation retry ${attempt} for ${network} after ${(err as Error).message} — waiting ${delayMs}ms`,
          );
        },
      });
      // Give SPA time to render the login form
      await this.browser.randomDelay(5000, 10000);
      this.logger.log(`Login page loaded for ${network}: ${page.url()}`);

      // DEBUG: dump page HTML for login troubleshooting (only in dry-run mode)
      if (parseBool(process.env.SPA_DRY_RUN)) {
        try {
          const html = await page.content();
          const fs = await import('node:fs/promises');
          const debugDir = '/tmp/spa-debug';
          await fs.mkdir(debugDir, { recursive: true });
          await fs.writeFile(`${debugDir}/${network.toLowerCase()}-login-page.html`, html);
          this.logger.debug(`Login page HTML dumped to ${debugDir}/${network.toLowerCase()}-login-page.html (${html.length} bytes)`);
        } catch {
          // non-blocking
        }
      }

      // Facebook mobile may show a welcome page with "I already have an account" button
      if (network === 'FACEBOOK') {
        const welcomeBtn = page.locator('text=I already have an account').first();
        if (await welcomeBtn.isVisible().catch(() => false)) {
          this.logger.debug(`Facebook welcome page — clicking "I already have an account"`);
          await welcomeBtn.click().catch(() => {});
          await this.browser.randomDelay(1000, 2000);
        }
      }

      // Fill username — use pressSequentially for React-controlled inputs
      // (fill() doesn't trigger React onChange in some apps like Threads/Instagram)
      let usernameInput = page.locator(selectors.usernameInput).first();
      this.logger.debug(`Login: looking for username input with selector: ${selectors.usernameInput}`);
      // Fallback: try getByLabel if CSS selector fails
      if (!(await usernameInput.isVisible().catch(() => false))) {
        // Facebook mobile uses "Phone or email" label; desktop uses "Email or mobile number"
        const label = network === 'FACEBOOK' ? 'Phone or email' :
          network === 'THREADS' ? 'Username, phone number or email address' : '';
        if (label) {
          this.logger.debug(`Login: CSS selector failed, trying getByLabel("${label}")`);
          usernameInput = page.getByLabel(label).first();
        }
      }
      await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
      this.logger.debug(`Login: username input found, filling with ${username.length} chars`);
      // X onboarding React inputs: fill() and pressSequentially() set DOM value but don't
      // trigger React's internal state. Use nativeInputValueSetter to set value through React.
      // Reference: https://stackoverflow.com/questions/40894637/how-to-programmatically-fill-input-elements-with-react-onchange-handlers
      if (network === 'X') {
        // ── Step 1: Username (stealth-x approach — typeHuman first, React setter fallback) ──
        // typeHuman: per-character keyboard.type with randomized 40-120ms delay + 5% "thinking"
        // pauses. More human-like than pressSequentially with fixed delay — X's anti-bot
        // detects uniform typing patterns (stealth-x Youhai020616/stealth-x typeHuman()).
        await usernameInput.click({ force: true }).catch(() => {});
        await this.browser.randomDelay(300, 800);
        // Strategy 1: typeHuman with locator (stealth-x primary approach)
        // Pass locator to use pressSequentially per-char — ensures focus stays on the
        // React-controlled input (page.keyboard.type alone doesn't trigger React onChange
        // for X's onboarding username field).
        this.logger.debug(`X: typing username via typeHuman (stealth-x approach)`);
        await this.browser.typeHuman(page, username, usernameInput).catch(() => {});
        await this.browser.randomDelay(500, 1000);

        // Verify value was set
        let usernameVal = await usernameInput.inputValue().catch(() => '');
        this.logger.debug(`X: username value after typeHuman: "${usernameVal ? '***' : '(empty)'}" (${usernameVal.length} chars)`);

        // Strategy 2: React-native value setter (fallback if typeHuman didn't trigger onChange)
        if (!usernameVal) {
          this.logger.warn(`X: typeHuman didn't set value — trying React-native setter`);
          await usernameInput.evaluate((el: HTMLInputElement, val: string) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            nativeSetter?.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, username).catch(() => {});
          usernameVal = await usernameInput.inputValue().catch(() => '');
        }

        // Strategy 3: fill() (last resort)
        if (!usernameVal) {
          this.logger.warn(`X: React setter didn't work — trying fill()`);
          await usernameInput.fill(username).catch(() => {});
        }
      } else {
        await usernameInput.focus();
        await this.browser.randomDelay(500, 1500);
        await usernameInput.pressSequentially(username, { delay: 50 });
      }
      await this.browser.randomDelay(1000, 3000);

      // X onboarding is a MULTI-STEP WIZARD (jf/onboarding/web):
      //   Step 1: username → click Next → API: begin_login → step 2 appears
      //   Step 1.5: (optional) identity verification — "enter phone/email to verify"
      //   Step 2: password → click Log in → API: login_enter_password → /home
      //   Step 3: (optional) 2FA — enter code → click Next → /home
      // The password input exists in DOM from the start but is hidden (opacity:0, aria-hidden).
      // NOT disabled — so :not([disabled]) matches it even in step 1. Need to check visibility instead.
      if (network === 'X') {
        // Verify username was actually filled
        const usernameVal = await usernameInput.inputValue().catch(() => '');
        if (!usernameVal) {
          this.logger.error(`X login: username field is empty after all strategies`);
          await page.close();
          return null;
        }
        this.logger.debug(`X: username filled (${usernameVal.length} chars), submitting step 1`);

        // ── Step 1 submit: Click "Next" button (stealth-x: clickElement nextButton, fallback Enter) ──
        const nextButton = page.locator(selectors.nextButton).first();
        const hasNext = await nextButton.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasNext) {
          this.logger.debug(`X: found Next button — clicking it`);
          await nextButton.click({ force: true }).catch(() => {});
        } else {
          this.logger.debug(`X: no Next button — pressing Enter on input`);
          await usernameInput.focus().catch(() => {});
          await this.browser.randomDelay(200, 500);
          await usernameInput.press('Enter');
        }
        await this.browser.randomDelay(2000, 4000);

        // ── Step 1.5: Identity verification challenge (stealth-x Step 1.5) ──
        // X sometimes asks "Enter your phone number or email to verify" after username.
        // Detect: username input reappears BUT password input is NOT visible.
        const verifyUsernameInput = page.locator(selectors.usernameInput).first();
        const hasVerifyInput = await verifyUsernameInput.isVisible({ timeout: 3000 }).catch(() => false);
        const hasPasswordField = await page.locator(selectors.passwordInput).first().isVisible({ timeout: 1000 }).catch(() => false);
        if (hasVerifyInput && !hasPasswordField) {
          this.logger.warn(`X: identity verification challenge detected (Step 1.5) — username input reappeared without password field`);
          const isHeaded = process.env.CAMOUFOX_HEADLESS === 'false';
          if (isHeaded) {
            this.logger.warn(
              `X: identity verification required — waiting up to 120s for manual completion (headed mode).\n` +
              `Please complete the verification in the browser window (enter phone/email, solve challenge).`,
            );
            // Wait for password field to appear (user completes verification)
            await page.waitForSelector(selectors.passwordInput, { state: 'visible', timeout: 120000 }).catch(() => {});
            await this.browser.randomDelay(1000, 2000);
          } else {
            this.logger.error(`X: identity verification challenge — manual intervention needed (re-run with CAMOUFOX_HEADLESS=false)`);
            await this.browser.screenshot(page, network, 'on-error');
            await page.close();
            void this.discord
              .critical(
                'X Login Verification Challenge — Manual Intervention Needed',
                `Auto-login for **X** hit an identity verification challenge after username. The account cannot be logged in automatically.`,
                [
                  { name: 'Network', value: 'X', inline: true },
                  { name: 'Challenge', value: 'Identity verification (phone/email)' },
                  { name: 'Action Needed', value: 'Re-run with CAMOUFOX_HEADLESS=false and complete the verification in the browser window.' },
                ],
              )
              .catch(() => void 0);
            return null;
          }
        }

        // Wait for step 1 → step 2 transition.
        // The password input becomes visible (opacity:1, pointer-events:auto) in step 2.
        // Check by waiting for the password input to become visible (not just not-disabled)
        const passwordInput = page.locator('input[name="password"]').first();
        // Wait for the password input to become visible (opacity changes from 0 to 1)
        await page.waitForFunction(
          () => {
            const el = document.querySelector('input[name="password"]') as HTMLInputElement;
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.opacity !== '0' && style.pointerEvents !== 'none' && el.getAttribute('aria-hidden') !== 'true';
          },
          { timeout: 15000 },
        ).catch(() => {});
        await this.browser.randomDelay(1000, 2000);

        // Verify we're on step 2 by checking if password input is now visible
        const isPasswordVisible = await passwordInput.isVisible().catch(() => false);
        if (!isPasswordVisible) {
          // Maybe step didn't transition — check page text for clues
          const bodyText = await page.locator('body').innerText().catch(() => '');
          this.logger.warn(`X: password not visible after step 1 submit. Page text: ${bodyText.slice(0, 500)}`);
        }
        this.logger.debug(`X: step 1 done, URL: ${page.url()}, password visible: ${isPasswordVisible}`);

        // ── Step 2: Password (stealth-x approach — typeHuman for human-like input) ──
        this.logger.debug(`X: password field enabled, filling via typeHuman`);
        await passwordInput.click({ force: true }).catch(() => {});
        await this.browser.randomDelay(300, 800);
        // Clear any existing value first
        await passwordInput.fill('').catch(() => {});
        await this.browser.randomDelay(200, 500);
        // typeHuman: per-character with randomized delay (stealth-x) — real key events trigger React onChange
        // Pass locator to ensure focus stays on the password field
        await this.browser.typeHuman(page, password, passwordInput);
        await this.browser.randomDelay(200, 500);

        // Verify password was filled
        const pwVal = await passwordInput.inputValue().catch(() => '');
        this.logger.debug(`X: password value after typeHuman: "${pwVal ? '***' : '(empty)'}" (${pwVal.length} chars)`);
        if (!pwVal) {
          // Fallback: React-native setter
          this.logger.warn(`X: typeHuman didn't work — trying React setter`);
          await passwordInput.evaluate((el: HTMLInputElement, val: string) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            nativeSetter?.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, password).catch(() => {});
        }
        await this.browser.randomDelay(1000, 2000);

        // ── Step 2 submit: Click "Log in" button (stealth-x: clickElement loginButton, fallback Enter) ──
        this.logger.debug(`X: submitting password step 2`);
        // Find all submit buttons and pick the visible one (step 1's is hidden)
        const submitButtons = page.locator('button[type="submit"]');
        const submitCount = await submitButtons.count().catch(() => 0);
        let clickedSubmit = false;
        for (let i = 0; i < submitCount; i++) {
          const btn = submitButtons.nth(i);
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            this.logger.debug(`X: found visible submit button (index ${i}) — clicking it`);
            await btn.click({ force: true }).catch(() => {});
            clickedSubmit = true;
            break;
          }
        }
        if (!clickedSubmit) {
          this.logger.debug(`X: no visible submit button — pressing Enter on password`);
          await passwordInput.focus().catch(() => {});
          await this.browser.randomDelay(200, 500);
          await passwordInput.press('Enter');
        }
        await this.browser.randomDelay(3000, 5000);

        // ── Step 3: 2FA check (stealth-x Step 3) ──
        // X uses ocfEnterTextTextInput for 2FA code entry. Detect after password submit.
        const twoFAInput = page.locator(selectors.twoFactorInput).first();
        const has2FA = await twoFAInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (has2FA) {
          this.logger.warn(`X: two-factor authentication detected (Step 3)`);
          const isHeaded = process.env.CAMOUFOX_HEADLESS === 'false';
          if (isHeaded) {
            this.logger.warn(
              `X: 2FA required — waiting up to 120s for manual completion (headed mode).\n` +
              `Please enter the 2FA code in the browser window.`,
            );
            // Wait for 2FA to be completed — detect by URL change to /home or account switcher appearing
            const maxWaitMs = 120000;
            const pollIntervalMs = 2000;
            const startTime = Date.now();
            let twoFaResolved = false;
            while (Date.now() - startTime < maxWaitMs) {
              await this.browser.randomDelay(pollIntervalMs, pollIntervalMs + 500);
              const currentUrl = page.url();
              if (currentUrl.includes('/home') || currentUrl === 'https://x.com/') {
                this.logger.log(`X: 2FA likely completed — URL changed to ${currentUrl}`);
                twoFaResolved = true;
                break;
              }
              // Also check for account switcher (logged-in indicator)
              const hasSwitcher = await page.locator(selectors.accountSwitcher).first().isVisible({ timeout: 500 }).catch(() => false);
              if (hasSwitcher) {
                this.logger.log(`X: 2FA likely completed — account switcher detected`);
                twoFaResolved = true;
                break;
              }
            }
            if (!twoFaResolved) {
              this.logger.error(`X: 2FA timed out — not completed within 120s`);
              await this.browser.screenshot(page, network, 'on-error');
              await page.close();
              void this.discord
                .critical(
                  'X Login 2FA Timeout — Manual Completion Required',
                  `Auto-login for **X** hit a 2FA challenge and it was not completed within 120 seconds.`,
                  [
                    { name: 'Network', value: 'X', inline: true },
                    { name: 'Challenge', value: 'Two-factor authentication' },
                    { name: 'Action Needed', value: 'Re-run with CAMOUFOX_HEADLESS=false and enter the 2FA code in the browser window.' },
                  ],
                )
                .catch(() => void 0);
              return null;
            }
            await this.browser.randomDelay(3000, 5000);
          } else {
            // Headless mode: try to get the verification code automatically.
            // Strategy:
            //   1. Poll email via IMAP (if configured) — fully automatic
            //   2. Fall back to manual API submission (POST /sessions/verify-code)
            //   3. Also check API while polling email (race — first code wins)
            this.logger.warn(`X: 2FA challenge in headless mode — attempting automatic email code retrieval`);

            // Try email first (up to 60s), then fall back to API (remaining time)
            let code: string | null = null;

            // Phase 1: Try email (if configured)
            code = await this.emailReader.pollForVerificationCode(60000, 5000).catch((err) => {
              this.logger.warn(`Email reader error: ${(err as Error).message}`);
              return null;
            });

            // Phase 2: If email didn't find a code, wait for manual API submission
            if (!code) {
              this.logger.warn(`X: email code not found — waiting for manual submission via API`);
              void this.discord
                .warning(
                  'X Login 2FA — Verification Code Needed',
                  `Auto-login for **X** hit a 2FA challenge. Email retrieval failed or not configured.\n` +
                    'Submit the code manually via:\n' +
                    '`POST /api/v1/sessions/verify-code?network=X&code=<CODE>`\n' +
                    'The login flow will wait up to 60 seconds for the code.',
                )
                .catch(() => void 0);

              code = await this.waitForVerificationCode(network, 60000);
            }

            if (!code) {
              this.logger.error(`X: 2FA timed out — no verification code obtained within 120s`);
              await this.browser.screenshot(page, network, 'on-error');
              await page.close();
              return null;
            }

            // Enter the code into the 2FA input field
            this.logger.log(`X: entering verification code into 2FA field`);
            await twoFAInput.fill(code);
            await this.browser.randomDelay(500, 1500);

            // Click the confirm/next button
            const twoFAConfirm = page.locator(selectors.twoFactorConfirm).first();
            const hasConfirm = await twoFAConfirm.isVisible({ timeout: 3000 }).catch(() => false);
            if (hasConfirm) {
              await twoFAConfirm.click();
            } else {
              // Fallback: press Enter
              await twoFAInput.press('Enter');
            }
            await this.browser.randomDelay(3000, 5000);

            // Verify login succeeded
            const postLoginUrl = page.url();
            const hasSwitcher = await page.locator(selectors.accountSwitcher).first().isVisible({ timeout: 5000 }).catch(() => false);
            if (!hasSwitcher && (postLoginUrl.includes('/login') || postLoginUrl.includes('/onboarding'))) {
              this.logger.error(`X: 2FA code entered but login did not succeed — URL: ${postLoginUrl}`);
              await this.browser.screenshot(page, network, 'on-error');
              await page.close();
              return null;
            }
            this.logger.log(`X: 2FA completed successfully — URL: ${postLoginUrl}`);
          }
        }
        await this.browser.randomDelay(3000, 5000);
      } else {
        // Other networks: single-page login (username + password on same page)
        let passwordInput = page.locator(selectors.passwordInput).first();
        const passwordVisible = await passwordInput.isVisible().catch(() => false);

        if (!passwordVisible) {
          passwordInput = page.getByLabel('Password').first();
        }

        // Fill password
        if (!(await passwordInput.isVisible().catch(() => false))) {
          passwordInput = page.getByLabel('Password').first();
        }
        await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
        await passwordInput.focus();
        await this.browser.randomDelay(500, 1500);
        await passwordInput.pressSequentially(password, { delay: 50 });
        await this.browser.randomDelay(1000, 2000);

        // Submit
        let submitBtn = page.locator(selectors.submitButton).first();
        this.logger.debug(`Login: looking for submit button with selector: ${selectors.submitButton}`);
        if (!(await submitBtn.isVisible().catch(() => false))) {
          // Mobile FB uses <button value="Log In">; desktop uses <div aria-label="Log In">
          submitBtn = page.locator('button[value="Log In"], input[value="Log In"], div[aria-label="Log In"], button:has-text("Log in"), button:has-text("Continue"), button[type="submit"]').first();
          this.logger.debug(`Login: primary submit selector failed, trying fallback`);
        }
        await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
        this.logger.debug(`Login: submit button found, clicking`);
        await this.browser.randomDelay(2000, 4000);
        await submitBtn.click({ force: true });
        this.logger.debug(`Login: submit clicked, waiting for navigation`);
        await this.browser.randomDelay(5000, 10000);
      }

      // Check if login succeeded — first by URL (not on login page), then by success indicator
      await this.browser.randomDelay(3000, 5000);
      const pageUrl = page.url();
      const isOnLoginPage = pageUrl.includes('/login') || pageUrl.includes('/auth') || pageUrl.includes('/onboarding');
      const isOnChallengePage = pageUrl.includes('challenge') || pageUrl.includes('checkpoint') || pageUrl.includes('two_factor') || pageUrl.includes('two_step_verification') || pageUrl.includes('captcha') || pageUrl.includes('/2fa');

      if (isOnChallengePage) {
        // 2FA / captcha / checkpoint — Facebook "suspicious login" challenge.
        // In headed mode (CAMOUFOX_HEADLESS=false), wait for the user to complete
        // the challenge manually. We detect success by checking for the `c_user`
        // cookie (Facebook's authenticated user ID cookie) — same approach as
        // tas33n/fb-login-bot's waitForCUserCookie().
        const isHeaded = process.env.CAMOUFOX_HEADLESS === 'false';

        if (isHeaded) {
          this.logger.warn(
            `Login challenge for ${network} — waiting up to 600s for manual completion (headed mode).\n` +
            `Please complete the challenge in the browser window (enter code, approve login, etc.).`,
          );

          // Dump challenge page HTML for debugging
          try {
            const html = await page.content();
            const fs = await import('node:fs/promises');
            const debugDir = '/tmp/spa-debug';
            await fs.mkdir(debugDir, { recursive: true });
            await fs.writeFile(`${debugDir}/${network.toLowerCase()}-challenge-page.html`, html);
            this.logger.debug(`Challenge page HTML dumped to ${debugDir}/${network.toLowerCase()}-challenge-page.html (${html.length} bytes)`);
            // Wait for React to render, then get visible text
            await page.waitForTimeout(10000);
            const bodyText = await page.locator('body').innerText().catch(() => '');
            this.logger.warn(`Challenge page visible text:\n${bodyText.slice(0, 2000)}`);
            // Log all buttons and inputs
            const buttons = await page.locator('button, div[role="button"], input[type="submit"], a[role="button"]').allTextContents().catch(() => []);
            this.logger.warn(`Challenge page buttons: ${JSON.stringify(buttons.slice(0, 15))}`);
            const inputs = await page.locator('input').evaluateAll((els) => els.map((e) => ({ name: (e as HTMLInputElement).name, type: (e as HTMLInputElement).type, ariaLabel: e.getAttribute('aria-label'), placeholder: (e as HTMLInputElement).placeholder }))).catch(() => []);
            this.logger.warn(`Challenge page inputs: ${JSON.stringify(inputs.slice(0, 10))}`);
          } catch {
            // non-blocking
          }

          // Wait for `c_user` cookie to appear (Facebook auth cookie) — polling approach
          // Reference: tas33n/fb-login-bot waitForCUserCookie()
          const maxWaitMs = 600000;
          const pollIntervalMs = 2000;
          const startTime = Date.now();
          let challengeResolved = false;

          while (Date.now() - startTime < maxWaitMs) {
            await this.browser.randomDelay(pollIntervalMs, pollIntervalMs + 500);
            const cookies = await context.cookies();
            const cUserCookie = cookies.find(
              (c) => c.name === 'c_user' && c.domain.includes('facebook.com'),
            );
            if (cUserCookie) {
              challengeResolved = true;
              this.logger.log(
                `Login challenge completed for ${network} — c_user cookie detected (user ID: ${cUserCookie.value})`,
              );
              break;
            }
            // Also check if URL changed away from challenge pages
            const currentUrl = page.url();
            const stillOnChallenge =
              currentUrl.includes('two_step_verification') ||
              currentUrl.includes('two_factor') ||
              currentUrl.includes('checkpoint') ||
              currentUrl.includes('challenge');
            if (!stillOnChallenge && !currentUrl.includes('/login')) {
              // URL changed to non-challenge, non-login page — likely success
              this.logger.log(`Login challenge likely completed for ${network} — URL changed to ${currentUrl}`);
              challengeResolved = true;
              break;
            }
          }

          if (!challengeResolved) {
            this.logger.error(`Login challenge timed out for ${network} — not completed within 600s`);
            await this.browser.screenshot(page, network, 'on-error');
            await page.close();

            void this.discord
              .critical(
                'Login Challenge Timeout — Manual Completion Required',
                `Auto-login for **${network}** hit a challenge page and it was not completed within 600 seconds.`,
                [
                  { name: 'Network', value: network, inline: true },
                  { name: 'Challenge URL', value: pageUrl.slice(0, 1024) },
                  { name: 'Action Needed', value: 'Re-run with --headed and complete the challenge in the browser window.' },
                ],
              )
              .catch(() => void 0);

            return null;
          }

          // Challenge resolved — wait for page to settle, then fall through to success check
          await this.browser.randomDelay(3000, 5000);
        } else {
          // Headless mode — can't auto-solve challenges
          this.logger.error(`Login challenge/captcha for ${network} — manual intervention needed (${pageUrl})`);
          await this.browser.screenshot(page, network, 'on-error');
          await page.close();

          void this.discord
            .critical(
              'Login Challenge Detected — Manual Intervention Needed',
              `Auto-login for **${network}** hit a captcha/2FA/challenge page. The account cannot be logged in automatically.`,
              [
                { name: 'Network', value: network, inline: true },
                { name: 'Challenge URL', value: pageUrl.slice(0, 1024) },
                { name: 'Action Needed', value: 'Re-run with --headed and complete the challenge in the browser window.' },
              ],
            )
            .catch(() => void 0);

          return null;
        }
      }

      // Re-check URL after challenge resolution
      const postChallengeUrl = page.url();
      const stillOnChallengePost =
        postChallengeUrl.includes('two_step_verification') ||
        postChallengeUrl.includes('two_factor') ||
        postChallengeUrl.includes('checkpoint') ||
        postChallengeUrl.includes('challenge');
      const isOnLoginPagePost =
        postChallengeUrl.includes('/login') ||
        postChallengeUrl.includes('/auth') ||
        postChallengeUrl.includes('/onboarding');

      // If we have c_user cookie, login succeeded regardless of URL
      const cookies = await context.cookies();
      const hasCUserCookie = cookies.some(
        (c) => c.name === 'c_user' && c.domain.includes('facebook.com'),
      );

      if (hasCUserCookie) {
        this.logger.log(`Login verified for ${network} — c_user cookie present`);
        // Take post-login screenshot for debugging
        await this.browser.screenshot(page, network, 'after-login');
        // Save storageState
        const storageState = await this.browser.saveStorageState(context);
        await page.close();

        // P0-H3: Encrypt storageState before storing in DB
        const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
        const session = await this.prisma.session.create({
          data: {
            accountId: account.id,
            storageState: encrypted as unknown as Prisma.InputJsonValue,
            status: SessionStatus.ACTIVE,
            lastHealthCheck: new Date(),
          },
        });
        this.logger.log(`Auto-login successful for ${network}, session ${session.id} created`);
        return session;
      }

      if (stillOnChallengePost || isOnLoginPagePost) {
        // DEBUG: dump error messages and page text for X login troubleshooting
        if (network === 'X') {
          try {
            const bodyText = await page.locator('body').innerText().catch(() => '');
            this.logger.warn(`X login page text after submit:\n${bodyText.slice(0, 2000)}`);
            // Look for error messages
            const errorEls = await page.locator('[role="alert"], [data-testid="toast"], .error, [class*="error" i]').allTextContents().catch(() => []);
            this.logger.warn(`X login error elements: ${JSON.stringify(errorEls.slice(0, 5))}`);
          } catch {
            // non-blocking
          }
        }
        this.logger.error(`Login failed for ${network} — still on ${stillOnChallengePost ? 'challenge' : 'login'} page (${postChallengeUrl})`);
        await this.browser.screenshot(page, network, 'on-error');
        await page.close();
        return null;
      }

      // Facebook may show a "Save" browser info dialog after login — dismiss it
      if (network === 'FACEBOOK') {
        const saveBtn = page.locator('[role="button"][aria-label="Save"], button:has-text("Save"), input[value="Save"]').first();
        if (await saveBtn.isVisible().catch(() => false)) {
          this.logger.debug(`Facebook "Save" dialog — clicking Save`);
          await saveBtn.click().catch(() => {});
          await this.browser.randomDelay(2000, 4000);
        }
        // Also handle "Continue" checkpoint button if present
        const continueBtn = page.locator('button:has-text("Continue"), input[value="Continue"], a:has-text("Continue")').first();
        if (await continueBtn.isVisible().catch(() => false)) {
          this.logger.debug(`Facebook checkpoint — clicking Continue`);
          await continueBtn.click().catch(() => {});
          await this.browser.randomDelay(3000, 5000);
        }
      }

      // We're not on the login page — login likely succeeded.
      // Try to find success indicator as secondary check (with longer timeout)
      const successIndicator = page.locator(selectors.successIndicator).first();
      const isLoggedIn = await successIndicator.isVisible().catch(() => false);

      if (!isLoggedIn) {
        // Success indicator not found — login likely failed
        this.logger.error(`Login failed for ${network} — no success indicator found (${pageUrl})`);
        await this.browser.screenshot(page, network, 'on-error');
        // Debug: dump page HTML and visible buttons to help update selectors
        try {
          const html = await page.content();
          const buttons = await page.locator('button, div[role="button"], a[href]').allTextContents();
          this.logger.debug(`Login debug for ${network} — URL: ${pageUrl}`);
          this.logger.debug(`Visible buttons/links: ${JSON.stringify(buttons.slice(0, 20))}`);
          // Save HTML for manual inspection
          const { writeFileSync } = await import('node:fs');
          const debugPath = `/tmp/spa-screenshots/${network.toLowerCase()}/login-debug-${Date.now()}.html`;
          writeFileSync(debugPath, html);
          this.logger.debug(`Login debug HTML saved: ${debugPath}`);
        } catch (e) {
          this.logger.debug(`Failed to dump debug HTML: ${(e as Error).message}`);
        }
        await page.close();
        return null;
      }

      // Take post-login screenshot for debugging
      await this.browser.screenshot(page, network, 'after-login');

      // Save storageState
      const storageState = await this.browser.saveStorageState(context);
      await page.close();

      // P0-H3: Encrypt storageState before storing in DB
      const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
      const session = await this.prisma.session.create({
        data: {
          accountId: account.id,
          storageState: encrypted as unknown as Prisma.InputJsonValue,
          status: SessionStatus.ACTIVE,
          lastHealthCheck: new Date(),
        },
      });

      this.logger.log(`Auto-login successful for ${network}, session ${session.id} created`);
      return session;
    } catch (err) {
      this.logger.error(`Auto-login failed for ${network}: ${(err as Error).message}`);
      // Take screenshot for debugging using the new IBrowserPort.screenshot method
      try {
        if (context) {
          const page = context.pages()[0];
          if (page) {
            await this.browser.screenshot(page, network, 'on-error');
          }
        }
      } catch {}
      return null;
    }
  }

  /**
   * P0-H3: Update storageState with encryption.
   * The storageState string from browser is encrypted before storing in DB.
   */
  async updateStorageState(sessionId: string, storageState: string): Promise<void> {
    const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        storageState: encrypted as unknown as Prisma.InputJsonValue,
        status: SessionStatus.ACTIVE,
        lastHealthCheck: new Date(),
      },
    });
    this.logger.debug(`Updated storage state for session ${sessionId} (encrypted: ${this.encryptionService.isEnabled()})`);
  }

  /**
   * P0-H3: Create session with encrypted storageState.
   */
  async createSession(network: SocialNetwork, storageState: string): Promise<void> {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) return;

    const encrypted = this.encryptionService.encrypt(JSON.parse(storageState));
    await this.prisma.session.create({
      data: {
        accountId: account.id,
        storageState: encrypted as unknown as Prisma.InputJsonValue,
        status: SessionStatus.ACTIVE,
        lastHealthCheck: new Date(),
      },
    });
    this.logger.log(`Created new session for ${network} (encrypted: ${this.encryptionService.isEnabled()})`);
  }

  /**
   * P0-H3: Decrypt storageState from a session for use with browser.
   * Handles three cases:
   *   1. Encrypted string (v1: prefix) → decrypt → JSON.stringify
   *   2. Passthrough string (no v1: prefix, from encrypt() in disabled mode) → already JSON, return as-is
   *   3. Legacy plaintext object → JSON.stringify
   *
   * Public so PostingService can reuse it instead of duplicating the logic.
   */
  decryptStorageState(session: { storageState: unknown }): string {
    const raw = session.storageState;
    if (typeof raw === 'string') {
      // Encrypted string — decrypt it
      if (this.encryptionService.isEncrypted(raw)) {
        const decrypted = this.encryptionService.decrypt(raw);
        return JSON.stringify(decrypted);
      }
      // Passthrough mode: encrypt() returned JSON.stringify(data) — already a JSON string
      return raw;
    }
    // Legacy plaintext object — stringify it
    return JSON.stringify(raw);
  }

  /**
   * Network-specific authentication cookies that indicate a valid session.
   * Used for deep health check — validates cookies, not just URL.
   * Reference: facebook-scraper validates c_user + xs, twscrape validates ct0 + auth_token.
   */
  private readonly AUTH_COOKIES: Record<SocialNetwork, Array<{ name: string; domain: string }>> = {
    X: [
      { name: 'auth_token', domain: 'x.com' },
      { name: 'ct0', domain: 'x.com' },
    ],
    THREADS: [
      { name: 'sessionid', domain: 'threads.net' },
    ],
    FACEBOOK: [
      { name: 'c_user', domain: 'facebook.com' },
      { name: 'xs', domain: 'facebook.com' },
    ],
  };

  /**
   * Deep health check — validates session by checking auth cookies AND URL.
   *
   * Previously only checked if the URL redirected to /login. Now also:
   *   1. Checks for presence of network-specific auth cookies (c_user, xs, auth_token, ct0, sessionid)
   *   2. Validates cookie expiry (expired cookies = invalid session even if URL doesn't redirect)
   *   3. Uses navigateWithRetry for resilient page loading
   *
   * Reference: facebook-scraper validates c_user + xs; twscrape validates ct0 + auth_token.
   */
  async healthCheck(network: SocialNetwork): Promise<{ healthy: boolean; message: string }> {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) {
      return { healthy: false, message: 'No account found' };
    }

    const session = await this.prisma.session.findFirst({
      where: { accountId: account.id, status: SessionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return { healthy: false, message: 'No active session' };
    }

    // Open browser with saved storageState and check if still logged in
    const storageStateStr = this.decryptStorageState(session);
    // Use acquireContext (pool) instead of createContext (new context each time)
    let context: Awaited<ReturnType<IBrowserPort['acquireContext']>> | null = null;
    let page = null;

    try {
      context = await this.browser.acquireContext(network, storageStateStr);
      page = await context.newPage();

      // Navigate to the network's home page — with retry on network errors
      const checkUrl = network === 'X' ? 'https://x.com/home' :
        network === 'THREADS' ? 'https://www.threads.com/' :
        'https://www.facebook.com/';
      await navigateWithRetry(page, checkUrl, {
        waitUntil: 'networkidle',
        timeoutMs: 30000,
        maxRetries: 2,
      });
      await this.browser.randomDelay(3000, 5000);

      // Deep check 1: If redirected to login, session is definitely expired
      const currentUrl = page.url();
      const isExpired = currentUrl.includes('/login') || currentUrl.includes('/auth');

      // Deep check 2: Validate auth cookies are present and not expired
      const cookies = await context.cookies();
      const requiredCookies = this.AUTH_COOKIES[network] ?? [];
      const now = Date.now();
      const missingCookies: string[] = [];
      const expiredCookies: string[] = [];

      for (const required of requiredCookies) {
        const cookie = cookies.find(
          (c) => c.name === required.name && c.domain.includes(required.domain),
        );
        if (!cookie) {
          missingCookies.push(required.name);
        } else if (cookie.expires && cookie.expires > 0 && cookie.expires * 1000 < now) {
          // Cookie has an expiry timestamp and it's in the past
          expiredCookies.push(required.name);
        }
      }

      // Determine health status
      if (isExpired) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.EXPIRED },
        });
        return { healthy: false, message: 'Session expired (redirected to login)' };
      }

      if (missingCookies.length > 0) {
        this.logger.warn(
          `Health check for ${network}: missing auth cookies: ${missingCookies.join(', ')}`,
        );
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.EXPIRED },
        });
        return {
          healthy: false,
          message: `Session expired (missing auth cookies: ${missingCookies.join(', ')})`,
        };
      }

      if (expiredCookies.length > 0) {
        this.logger.warn(
          `Health check for ${network}: expired auth cookies: ${expiredCookies.join(', ')}`,
        );
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.EXPIRED },
        });
        return {
          healthy: false,
          message: `Session expired (cookies expired: ${expiredCookies.join(', ')})`,
        };
      }

      // Update last health check
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastHealthCheck: new Date() },
      });

      return { healthy: true, message: 'Session active' };
    } catch (err) {
      this.logger.error(`Health check failed for ${network}: ${(err as Error).message}`);
      return { healthy: false, message: `Health check error: ${(err as Error).message}` };
    } finally {
      // Always close page and release context back to pool
      try { if (page) await page.close(); } catch { /* best-effort */ }
      try { if (context) this.browser.releaseContext(network, context); } catch { /* best-effort */ }
    }
  }

  async findAll() {
    return this.prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      include: { account: true },
      take: 20,
    });
  }

  /**
   * Mark a session as EXPIRED so getOrCreateSession won't return it.
   * Used by PostingService self-recovery when a poster detects session expiry
   * mid-post — forces getOrCreateSession to auto-login and create a fresh session.
   */
  async markSessionExpired(network: SocialNetwork, sessionId: string): Promise<void> {
    try {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.EXPIRED },
      });
      this.logger.log(`Marked session ${sessionId} for ${network} as EXPIRED (self-recovery)`);
    } catch (err) {
      this.logger.warn(
        `Failed to mark session ${sessionId} as EXPIRED: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Cleanup old EXPIRED sessions from the database.
   * Keeps only the most recent 5 expired sessions per account for debugging;
   * deletes older ones to prevent unbounded growth.
   *
   * Should be called periodically (e.g., via cron or on health check).
   */
  async cleanupExpiredSessions(): Promise<{ deleted: number }> {
    try {
      // Find all expired sessions grouped by account
      const expiredSessions = await this.prisma.session.findMany({
        where: { status: SessionStatus.EXPIRED },
        orderBy: { createdAt: 'desc' },
        select: { id: true, accountId: true },
      });

      // Group by account
      const byAccount = new Map<string, string[]>();
      for (const s of expiredSessions) {
        const arr = byAccount.get(s.accountId) ?? [];
        arr.push(s.id);
        byAccount.set(s.accountId, arr);
      }

      // Keep the 5 most recent per account, delete the rest
      const toDelete: string[] = [];
      for (const [, sessionIds] of byAccount) {
        if (sessionIds.length > 5) {
          toDelete.push(...sessionIds.slice(5));
        }
      }

      if (toDelete.length > 0) {
        await this.prisma.session.deleteMany({
          where: { id: { in: toDelete } },
        });
        this.logger.log(`Cleaned up ${toDelete.length} old expired sessions`);
      }

      return { deleted: toDelete.length };
    } catch (err) {
      this.logger.warn(`Failed to cleanup expired sessions: ${(err as Error).message}`);
      return { deleted: 0 };
    }
  }

  // ── 2FA / Verification Code API ──────────────────────────────────────────
  // When X (or another network) sends a verification code via email, the operator
  // submits it via POST /api/v1/sessions/verify-code. The code is stored in Redis
  // with a 5-minute TTL. The login flow polls Redis for a pending code when it
  // hits a 2FA/challenge page in headless mode.

  private verifyCodeKey(network: string): string {
    return `spa:verify-code:${network.toUpperCase()}`;
  }

  /**
   * Store a verification code submitted by the operator (via API).
   * TTL: 5 minutes (codes expire quickly).
   */
  async setVerificationCode(network: string, code: string): Promise<void> {
    const key = this.verifyCodeKey(network);
    await this.redis.set(key, code, 'EX', 300); // 5 min TTL
    this.logger.log(`Verification code stored for ${network} (expires in 5 min)`);
  }

  /**
   * Poll for a verification code submitted by the operator.
   * Used by the login flow when it hits a 2FA/challenge page in headless mode.
   * Waits up to `timeoutMs` for a code to appear in Redis.
   * Returns the code string, or null if no code was submitted in time.
   */
  async waitForVerificationCode(network: string, timeoutMs = 120000): Promise<string | null> {
    const key = this.verifyCodeKey(network);
    const pollIntervalMs = 2000;
    const startTime = Date.now();

    this.logger.warn(
      `Waiting for verification code for ${network} — submit via POST /api/v1/sessions/verify-code?network=${network}&code=<CODE> (timeout: ${timeoutMs / 1000}s)`,
    );

    while (Date.now() - startTime < timeoutMs) {
      const code = await this.redis.get(key).catch(() => null);
      if (code) {
        // Delete the code after consuming it (single-use)
        await this.redis.del(key).catch(() => {});
        this.logger.log(`Verification code received for ${network}`);
        return code;
      }
      await this.browser.randomDelay(pollIntervalMs, pollIntervalMs + 500);
    }

    this.logger.error(`No verification code submitted for ${network} within ${timeoutMs / 1000}s`);
    return null;
  }
}
