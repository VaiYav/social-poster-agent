import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { SessionStatus, SocialNetwork, type Prisma } from '@prisma/client';

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

  // Login page selectors per network
  private readonly LOGIN_SELECTORS = {
    X: {
      url: 'https://x.com/i/flow/login',
      usernameInput: 'input[autocomplete="username"]',
      passwordInput: 'input[autocomplete="current-password"]',
      submitButton: '[data-testid="LoginForm_Login_Button"]',
      successIndicator: '[data-testid="AppTabBar_Home_Link"]',
    },
    THREADS: {
      url: 'https://www.threads.com/login',
      usernameInput: 'input[aria-label*="Username"], input[aria-label*="username"], input[placeholder*="Username"], input[placeholder*="username"]',
      passwordInput: 'input[aria-label*="Password"], input[aria-label*="password"], input[type="password"]',
      submitButton: 'div[role="button"]:has-text("Log in"):not(:has-text("Instagram")), button:has-text("Log in"):not(:has-text("Instagram"))',
      // After login, Threads shows a "Create" button (not a link) in the nav
      successIndicator: 'button[aria-label="Create"], button:has-text("Create"), a[href="/compose"]',
    },
    FACEBOOK: {
      url: 'https://www.facebook.com/login',
      usernameInput: 'input[aria-label*="Email"], input[aria-label*="email"], input[placeholder*="Email"], input#email',
      passwordInput: 'input[aria-label*="Password"], input[aria-label*="password"], input[type="password"], input#pass',
      submitButton: 'button:has-text("Log in")',
      successIndicator: '[role="navigation"], [role="banner"]',
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountsService: AccountsService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly configService: ConfigService,
  ) {}

  async getOrCreateSession(network: SocialNetwork) {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) return null;

    // Find active session
    const session = await this.prisma.session.findFirst({
      where: { accountId: account.id, status: SessionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });

    if (session) {
      this.logger.debug(`Found active session for ${network}`);
      return session;
    }

    // No active session — auto-login from env credentials (OQ-8)
    this.logger.log(`No active session for ${network} — starting auto-login`);
    return this.autoLogin(network);
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

    if (!password) {
      this.logger.error(`No credentials in env for ${network} — cannot auto-login`);
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

      // Navigate to login page
      await page.goto(selectors.url, { waitUntil: 'networkidle' });
      await this.browser.randomDelay(3000, 8000);
      this.logger.log(`Login page loaded for ${network}: ${page.url()}`);

      // Fill username — use pressSequentially for React-controlled inputs
      // (fill() doesn't trigger React onChange in some apps like Threads/Instagram)
      let usernameInput = page.locator(selectors.usernameInput).first();
      // Fallback: try getByLabel if CSS selector fails
      if (!(await usernameInput.isVisible().catch(() => false))) {
        const label = network === 'FACEBOOK' ? 'Email address or mobile number' :
          network === 'THREADS' ? 'Username, phone number or email address' : '';
        if (label) {
          usernameInput = page.getByLabel(label).first();
        }
      }
      await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
      await usernameInput.focus();
      await this.browser.randomDelay(500, 1500);
      await usernameInput.pressSequentially(username, { delay: 50 });
      await this.browser.randomDelay(1000, 3000);

      // Fill password — same approach
      let passwordInput = page.locator(selectors.passwordInput).first();
      if (!(await passwordInput.isVisible().catch(() => false))) {
        passwordInput = page.getByLabel('Password').first();
      }
      await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
      // Use focus + type instead of click (some sites have overlays that block click)
      await passwordInput.focus();
      await this.browser.randomDelay(500, 1500);
      await passwordInput.pressSequentially(password, { delay: 50 });
      await this.browser.randomDelay(1000, 2000);

      // Submit — wait for button to be enabled (React may disable until both fields are valid)
      let submitBtn = page.locator(selectors.submitButton).first();
      if (!(await submitBtn.isVisible().catch(() => false))) {
        submitBtn = page.getByRole('button', { name: 'Log in' }).first();
      }
      await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
      // Wait for button to become enabled (not disabled) — use Playwright's attribute check
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      // Give React time to enable the button after input
      await this.browser.randomDelay(2000, 4000);
      // Use force click to bypass Camoufox humanize mouse movement issues
      await submitBtn.click({ force: true });
      await this.browser.randomDelay(5000, 10000);

      // Check if login succeeded — first by URL (not on login page), then by success indicator
      await this.browser.randomDelay(3000, 5000);
      const pageUrl = page.url();
      const isOnLoginPage = pageUrl.includes('/login') || pageUrl.includes('/auth');
      const isOnChallengePage = pageUrl.includes('challenge') || pageUrl.includes('checkpoint') || pageUrl.includes('two_factor') || pageUrl.includes('captcha');

      if (isOnChallengePage) {
        // Check for captcha or 2FA — can appear on any URL, not just login pages
        this.logger.error(`Login challenge/captcha for ${network} — manual intervention needed (${pageUrl})`);
        await this.browser.screenshot(page, network, 'on-error');
        await page.close();
        return null;
      }

      if (isOnLoginPage) {
        this.logger.error(`Login failed for ${network} — still on login page (${pageUrl})`);
        await this.browser.screenshot(page, network, 'on-error');
        await page.close();
        return null;
      }

      // We're not on the login page — login likely succeeded.
      // Try to find success indicator as secondary check (with longer timeout)
      const successIndicator = page.locator(selectors.successIndicator).first();
      const isLoggedIn = await successIndicator.isVisible().catch(() => false);

      if (!isLoggedIn) {
        // Success indicator not found — login likely failed
        this.logger.error(`Login failed for ${network} — no success indicator found (${pageUrl})`);
        await this.browser.screenshot(page, network, 'on-error');
        await page.close();
        return null;
      }

      // Take post-login screenshot for debugging
      await this.browser.screenshot(page, network, 'after-login');

      // Save storageState
      const storageState = await this.browser.saveStorageState(context);
      await page.close();

      // Create session in DB
      const session = await this.prisma.session.create({
        data: {
          accountId: account.id,
          storageState: JSON.parse(storageState) as Prisma.InputJsonValue,
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

  async updateStorageState(sessionId: string, storageState: string): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        storageState: JSON.parse(storageState) as Prisma.InputJsonValue,
        status: SessionStatus.ACTIVE,
        lastHealthCheck: new Date(),
      },
    });
    this.logger.debug(`Updated storage state for session ${sessionId}`);
  }

  async createSession(network: SocialNetwork, storageState: string): Promise<void> {
    const account = await this.accountsService.findByNetwork(network);
    if (!account) return;

    await this.prisma.session.create({
      data: {
        accountId: account.id,
        storageState: JSON.parse(storageState) as Prisma.InputJsonValue,
        status: SessionStatus.ACTIVE,
        lastHealthCheck: new Date(),
      },
    });
    this.logger.log(`Created new session for ${network}`);
  }

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
    try {
      const storageStateStr = JSON.stringify(session.storageState);
      const context = await this.browser.createContext(network, storageStateStr);
      const page = await context.newPage();

      const selectors = this.LOGIN_SELECTORS[network];
      // Navigate to the network's home page to check session validity
      const checkUrl = network === 'X' ? 'https://x.com/home' :
        network === 'THREADS' ? 'https://www.threads.com/' :
        'https://www.facebook.com/';
      await page.goto(checkUrl, { waitUntil: 'networkidle' });
      await this.browser.randomDelay(3000, 5000);

      // If redirected to login, session is expired
      const currentUrl = page.url();
      const isExpired = currentUrl.includes('/login') || currentUrl.includes('/auth');

      await page.close();

      if (isExpired) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.EXPIRED },
        });
        return { healthy: false, message: 'Session expired (redirected to login)' };
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
    }
  }

  async findAll() {
    return this.prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      include: { account: true },
      take: 20,
    });
  }
}
