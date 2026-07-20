/**
 * MOD-04: Session Lifecycle Module — Vitest unit tests.
 *
 * Source: packages/backend/src/modules/sessions/sessions.service.ts
 * Test cases: CONSTITUTION.md §14 (Testing) — test case IDs are inline (UTC-060..074)
 *
 * Notes:
 * - `autoLogin()` is private; UTC-063..067 exercise it indirectly via
 *   `getOrCreateSession()` (no active session → autoLogin branch).
 * - Mocks: PrismaService, AccountsService, IBrowserPort, ConfigService.
 *
 * Vitest transforms with esbuild, which does NOT emit `design:paramtypes`
 * decorator metadata. Nest DI relies on that metadata to resolve type-injected
 * constructor params. The `@Inject(IBrowserPort)` token survives (it uses a
 * separate metadata key), but the class-typed params (PrismaService,
 * AccountsService, ConfigService) come back as `undefined`. We restore the
 * metadata explicitly via `Reflect.defineMetadata` so `@nestjs/testing` DI
 * works as intended.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SessionStatus, SocialNetwork } from '@prisma/client';

import { SessionsService } from '../../../src/modules/sessions/sessions.service';
import { AccountsService } from '../../../src/modules/accounts/accounts.service';
import { PrismaService } from '../../../src/infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../../src/infrastructure/crypto/encryption.service.js';
import { DiscordNotificationService } from '../../../src/infrastructure/notifications/discord-notification.service.js';
import { IBrowserPort } from '../../../src/domain/ports/browser.port.js';
import { SHARED_REDIS } from '../../../src/infrastructure/redis/redis.module.js';
import { EmailReaderService } from '../../../src/infrastructure/email/email-reader.service.js';
import { defineParamtypes, restoreAllDesignParamtypes } from '../../helpers/restore-paramtypes';
import {
  createMockPrismaService,
  createMockBrowserPort,
  createMockEncryptionService,
} from '../../mocks/index';

// ── Redis mock ──
function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve('OK'); }),
    del: vi.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
    _store: store,
  };
}

// ── EmailReader mock ──
function createMockEmailReader() {
  return {
    fetchVerificationCode: vi.fn().mockResolvedValue(null),
    pollForVerificationCode: vi.fn().mockResolvedValue(null),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_X = { id: 'acc-x', network: SocialNetwork.X, handle: 'myzodiacai', active: true, credentialsRef: 'SOCIAL_X_USERNAME,SOCIAL_X_PASSWORD,SOCIAL_X_COOKIES' };
const ACCOUNT_THREADS = { id: 'acc-threads', network: SocialNetwork.THREADS, handle: 'myzodiacai', active: true, credentialsRef: 'SOCIAL_THREADS_USERNAME,SOCIAL_THREADS_PASSWORD,SOCIAL_THREADS_COOKIES' };
const ACCOUNT_FB = { id: 'acc-fb', network: SocialNetwork.FACEBOOK, handle: 'myzodiacai@fb.com', active: true, credentialsRef: 'SOCIAL_FACEBOOK_USERNAME,SOCIAL_FACEBOOK_PASSWORD,SOCIAL_FACEBOOK_COOKIES' };

const ACTIVE_SESSION = {
  id: 'sess-active-1',
  accountId: 'acc-x',
  storageState: { cookies: [{ name: 'auth', value: 'token' }], origins: [] },
  status: SessionStatus.ACTIVE,
  lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
  createdAt: new Date('2026-07-10T00:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
};

/**
 * Build a mock Playwright `Page` with configurable url + success-indicator
 * visibility. Locator chain: page.locator(sel).first() → { waitFor, fill, click, isVisible }.
 *
 * Selector-aware visibility: the mock inspects the selector string to determine
 * visibility. This is needed because X login flow (stealth-x approach) checks
 * multiple distinct selectors (username, password, 2FA, account switcher) and
 * expects different visibility states. By default:
 *   - 2FA input (ocfEnterText) → NOT visible (no 2FA challenge in normal flow)
 *   - All other selectors → visible = opts.successVisible
 */
function createMockPage(opts: { url: string; successVisible: boolean } = { url: 'https://x.com/home', successVisible: true }) {
  // Determine visibility based on selector content — 2FA input is never visible
  // in the default mock (no 2FA challenge). This prevents the X Step 3 2FA check
  // from triggering when successVisible=true (which would close the page).
  const isVisibleForSelector = (selector: string): boolean => {
    // 2FA / identity verification input — never visible in default mock
    if (selector.includes('ocfEnterText') || selector.includes('twoFactor')) {
      return false;
    }
    // Login form inputs and action buttons are always visible; only success indicators
    // (home/profile nav, account switcher, etc.) reflect `successVisible`.
    if (
      selector.includes('AppTabBar') ||
      selector.includes('SideNav') ||
      selector.includes('accountSwitcher') ||
      selector.includes('primaryColumn') ||
      selector.includes('NewTweet_Button')
    ) {
      return opts.successVisible;
    }
    return true;
  };

  const makeLocatorFirst = (selector: string) => ({
    waitFor: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(isVisibleForSelector(selector)),
    isEnabled: vi.fn().mockResolvedValue(true),
    isHidden: vi.fn().mockResolvedValue(!isVisibleForSelector(selector)),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    inputValue: vi.fn().mockResolvedValue('filled-value'),
    count: vi.fn().mockResolvedValue(isVisibleForSelector(selector) ? 1 : 0),
    evaluate: vi.fn().mockResolvedValue(undefined),
    boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 50 }),
    nth: vi.fn().mockReturnValue({
      isVisible: vi.fn().mockResolvedValue(isVisibleForSelector(selector)),
      click: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const locatorResult = (selector: string) => ({
    first: () => makeLocatorFirst(selector),
    // Use this.first() so test overrides that shadow first() also affect all().
    all: vi.fn().mockImplementation(function () { return Promise.resolve([this.first()]); }),
    allTextContents: vi.fn().mockResolvedValue([]),
    innerText: vi.fn().mockResolvedValue(''),
    evaluateAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(isVisibleForSelector(selector) ? 1 : 0),
    nth: vi.fn().mockReturnValue(makeLocatorFirst(selector)),
  });
  const locator = vi.fn((selector: string) => locatorResult(selector));
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    locator,
    getByLabel: vi.fn().mockReturnValue(locatorResult('getByLabel')),
    getByRole: vi.fn().mockReturnValue(locatorResult('getByRole')),
    getByText: vi.fn().mockReturnValue(locatorResult('getByText')),
    url: vi.fn().mockReturnValue(opts.url),
    close: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html></html>'),
    textContent: vi.fn().mockResolvedValue(''),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    },
    _locatorFirst: makeLocatorFirst('default'),
  };
}

/**
 * Build a mock BrowserContext whose newPage() resolves to the supplied page.
 */
function createMockContext(
  page: ReturnType<typeof createMockPage>,
  opts?: { cookies?: Array<{ name: string; value: string; domain: string; expires?: number }> },
) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({}),
    pages: vi.fn().mockReturnValue([page]),
    cookies: vi.fn().mockResolvedValue(opts?.cookies ?? []),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

/** ConfigService mock: returns values from a key→value map, else default. */
function createMockConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: string) => {
      if (key in values) return values[key];
      return def;
    }),
  } as unknown as ConfigService;
}

/** AccountsService mock with overridable findFirstActiveByNetwork. */
function createMockAccountsService(byNetwork: Record<string, unknown> = {}) {
  const fn = vi.fn((network: SocialNetwork) => Promise.resolve(byNetwork[network] ?? null));
  const activeAccounts = Object.values(byNetwork).filter(Boolean);
  return {
    findByNetwork: vi.fn((network: SocialNetwork) => Promise.resolve(byNetwork[network] ? [byNetwork[network]] : [])),
    findFirstActiveByNetwork: fn,
    findById: vi.fn((id: string) => Promise.resolve(activeAccounts.find((a: any) => a.id === id) ?? null)),
    findAll: vi.fn().mockResolvedValue(activeAccounts),
    seedFromEnv: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn(),
  };
}

async function buildModule(opts: {
  prisma?: unknown;
  browser?: unknown;
  accounts?: unknown;
  config?: ConfigService;
}): Promise<{ service: SessionsService; module: TestingModule; prisma: unknown; browser: unknown; accounts: unknown }> {
  const prisma = opts.prisma ?? createMockPrismaService();
  const browser = opts.browser ?? createMockBrowserPort();
  const accounts = opts.accounts ?? createMockAccountsService();
  const config = opts.config ?? createMockConfigService();
  const encryption = createMockEncryptionService();
  const redis = createMockRedis();
  const emailReader = createMockEmailReader();
  const discord = { sendAlert: vi.fn().mockResolvedValue(undefined), critical: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined), info: vi.fn().mockResolvedValue(undefined) } as unknown as DiscordNotificationService;

  // Restore design:paramtypes — always set (esbuild doesn't emit them)
  defineParamtypes(
    SessionsService,
    [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService, Object, EmailReaderService],
  );

  const module = await Test.createTestingModule({
    providers: [
      SessionsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AccountsService, useValue: accounts },
      { provide: IBrowserPort, useValue: browser },
      { provide: ConfigService, useValue: config },
      { provide: EncryptionService, useValue: encryption },
      { provide: DiscordNotificationService, useValue: discord },
      { provide: SHARED_REDIS, useValue: redis },
      { provide: EmailReaderService, useValue: emailReader },
    ],
  }).compile();

  const service = module.get(SessionsService);
  return { service, module, prisma, browser, accounts };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MOD-04: SessionsService', () => {
  let prisma: unknown;
  let browser: unknown;
  let accounts: unknown;
  let config: ConfigService;
  let module: TestingModule | null;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    browser = createMockBrowserPort();
    accounts = createMockAccountsService();
    config = createMockConfigService();
    module = null;
  });

  afterEach(async () => {
    if (module) await module.close();
  });

  /** Build the testing module from the current mocks and return service + mocks. */
  async function setup(opts: { accounts?: unknown; config?: ConfigService; browser?: unknown; prisma?: unknown } = {}) {
    const acc = opts.accounts ?? accounts;
    const cfg = opts.config ?? config;
    const brw = opts.browser ?? browser;
    const prs = opts.prisma ?? prisma;

    // Wire up a default getCredentials implementation unless the test already provided one.
    // It reads env var names from account.credentialsRef through the mock ConfigService.
    if (acc && (!acc.getCredentials.getMockImplementation || !acc.getCredentials.getMockImplementation())) {
      acc.getCredentials.mockImplementation((account: any) => {
        const refs = (account.credentialsRef ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
        const result: { username: string; password: string; extra?: string; cookies?: string } = { username: '', password: '' };
        for (const ref of refs) {
          const value = cfg.get<string>(ref, '') ?? '';
          if (ref.includes('_PASSWORD')) result.password = value;
          else if (ref.includes('_USERNAME') || ref.includes('_EMAIL')) result.username = value;
          else if (ref.includes('_COOKIES')) result.cookies = value;
          else if (ref.includes('_PAGE_SLUG')) result.extra = value;
        }
        return result;
      });
    }

    // Restore design:paramtypes stripped by esbuild so Nest DI can resolve
    // the type-injected constructor params. Order matches the constructor:
    //   (prisma, accountsService, browser, configService, encryptionService, discord, redis, emailReader, schedulerRegistry)
    // The @Inject(IBrowserPort) token at index 2 overrides whatever is here.
    // Always set — esbuild doesn't emit design:paramtypes, and stale metadata
    // from other test files must be overwritten.
    defineParamtypes(
      SessionsService,
      [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService, Object, EmailReaderService, SchedulerRegistry],
    );

    const encryption = createMockEncryptionService();
    const redis = createMockRedis();
    const emailReader = createMockEmailReader();
    const discord = { sendAlert: vi.fn().mockResolvedValue(undefined), critical: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined), info: vi.fn().mockResolvedValue(undefined) } as unknown as DiscordNotificationService;
    const schedulerRegistry = { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as unknown as SchedulerRegistry;
    const compiled = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: prs },
        { provide: AccountsService, useValue: acc },
        { provide: IBrowserPort, useValue: brw },
        { provide: ConfigService, useValue: cfg },
        { provide: EncryptionService, useValue: encryption },
        { provide: DiscordNotificationService, useValue: discord },
        { provide: SHARED_REDIS, useValue: redis },
        { provide: EmailReaderService, useValue: emailReader },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
      ],
    }).compile();
    module = compiled;
    return {
      service: compiled.get(SessionsService),
      prisma: prs,
      browser: brw,
      accounts: acc,
      config: cfg,
      discord,
    };
  }

  // ── getOrCreateSession ───────────────────────────────────────────────────

  it('UTC-060: getOrCreateSession() returns existing ACTIVE session when found; autoLogin NOT called', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.create.mockResolvedValue({ id: 'should-not-be-called' });

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toEqual(ACTIVE_SESSION);
    expect(t.prisma.session.findFirst).toHaveBeenCalledWith({
      where: { accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
    // autoLogin path would call prisma.session.create — must NOT happen
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    // browser not touched when session exists
    expect(t.browser.createContext).not.toHaveBeenCalled();
  });

  it('UTC-061: getOrCreateSession() calls autoLogin when no active session exists and returns new session', async () => {
    prisma.session.findFirst.mockResolvedValue(null); // no active session
    prisma.session.create.mockResolvedValue({ id: 'sess-new-1', accountId: ACCOUNT_THREADS.id, status: SessionStatus.ACTIVE });

    // Browser automation for successful auto-login
    const page = createMockPage({ url: 'https://www.threads.net/home', successVisible: true });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }),
      config: createMockConfigService({
        SOCIAL_THREADS_USERNAME: 'myzodiacai',
        SOCIAL_THREADS_PASSWORD: 'secret-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.THREADS);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.THREADS, undefined, ACCOUNT_THREADS.id);
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-new-1', status: SessionStatus.ACTIVE }));
  });

  it('UTC-062: getOrCreateSession() returns null when no account exists for network; findFirst NOT called', async () => {
    const t = await setup({ accounts: createMockAccountsService({}) }); // no account for FACEBOOK

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(result).toBeNull();
    expect(t.prisma.session.findFirst).not.toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
  });

  // ── SE1: deferred form login + cooldown + alert + out-of-band cron ─────────

  it('SE1: posting defers (returns null, no form login) when SESSION_DEFERRED_LOGIN=true and only cookies are missing', async () => {
    prisma.session.findFirst.mockResolvedValue(null); // no active session
    const t = await setup({
      accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }),
      config: createMockConfigService({
        SESSION_DEFERRED_LOGIN: 'true',
        SOCIAL_THREADS_USERNAME: 'myzodiacai',
        SOCIAL_THREADS_PASSWORD: 'secret-pass',
        // no SOCIAL_THREADS_COOKIES → cookie auth yields null
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.THREADS, { deferFormLogin: true });

    expect(result).toBeNull();
    // Inline form login must NOT run on the posting path.
    expect(t.browser.createContext).not.toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    expect((t.discord as unknown as { warning: ReturnType<typeof vi.fn> }).warning).not.toHaveBeenCalled();
  });

  it('SE1: form login fires a Discord alert and is throttled by the cooldown on a second attempt', async () => {
    prisma.session.findFirst.mockResolvedValue(null); // stays "no session" across calls
    prisma.session.create.mockResolvedValue({ id: 'sess-new-1', accountId: ACCOUNT_THREADS.id, status: SessionStatus.ACTIVE });
    const page = createMockPage({ url: 'https://www.threads.net/home', successVisible: true });
    browser.createContext.mockResolvedValue(createMockContext(page));
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }),
      config: createMockConfigService({
        SOCIAL_THREADS_USERNAME: 'myzodiacai',
        SOCIAL_THREADS_PASSWORD: 'secret-pass',
        FORM_LOGIN_COOLDOWN_MS: '1800000', // enable the cooldown for this assertion (default is 0/off)
        // deferral off (default) → form login allowed, but cooled down after the first.
      }),
    });

    await t.service.getOrCreateSession(SocialNetwork.THREADS); // 1st: form login
    const warn = (t.discord as unknown as { warning: ReturnType<typeof vi.fn> }).warning;
    expect(warn).toHaveBeenCalledWith('Form Login Performed', expect.stringContaining('THREADS'));
    expect(t.prisma.session.create).toHaveBeenCalledTimes(1);

    await t.service.getOrCreateSession(SocialNetwork.THREADS); // 2nd: within cooldown → skipped
    expect(t.prisma.session.create).toHaveBeenCalledTimes(1); // no second login
  });

  it('SE1: refreshSessions drives logins for all active accounts when called', async () => {
    const on = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X, THREADS: ACCOUNT_THREADS, FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({ SESSION_DEFERRED_LOGIN: 'true' }),
    });
    const onSpy = vi.spyOn(on.service, 'getOrCreateSession').mockResolvedValue(null as never);
    await (on.service as unknown as { refreshSessions: () => Promise<void> }).refreshSessions();
    // One controlled re-login attempt per active account.
    expect(onSpy).toHaveBeenCalledTimes(3);
    expect(onSpy).toHaveBeenCalledWith(ACCOUNT_X.id, ACCOUNT_X.network);
    expect(onSpy).toHaveBeenCalledWith(ACCOUNT_THREADS.id, ACCOUNT_THREADS.network);
    expect(onSpy).toHaveBeenCalledWith(ACCOUNT_FB.id, ACCOUNT_FB.network);
  });

  // ── autoLogin (via getOrCreateSession) ────────────────────────────────────

  it('UTC-063: autoLogin() returns null when no password in env credentials; browser.createContext NOT called (HAZ-009)', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        // password missing → default ''
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(t.browser.createContext).not.toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
  });

  it('UTC-064: autoLogin() returns null when login challenge/captcha detected (HAZ-009)', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // success indicator not visible AND url contains 'challenge'
    const page = createMockPage({ url: 'https://x.com/challenge', successVisible: false });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    // error log mentions challenge/captcha
    const challengeCall = errorSpy.mock.calls.find((c) => /challenge|captcha/i.test(String(c[0])));
    expect(challengeCall).toBeTruthy();
  });

  it('UTC-065: autoLogin() returns null when login fails without challenge (no success indicator)', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // success indicator not visible, url is /home (no challenge)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const failCall = errorSpy.mock.calls.find((c) => /Login failed/i.test(String(c[0])));
    expect(failCall).toBeTruthy();
  });

  it('UTC-066: autoLogin() on success saves storageState, creates session in DB with ACTIVE status, returns session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-1', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);
    const savedState = JSON.stringify({ cookies: [{ name: 'sess', value: 'abc' }], origins: [] });
    browser.saveStorageState.mockResolvedValue(savedState);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(t.browser.saveStorageState).toHaveBeenCalledWith(context);
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    const createArg = t.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_X.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);
    // P0-H3: storageState is now encrypted (stringified in passthrough mock mode)
    expect(createArg.data.storageState).toEqual(savedState);
    expect(createArg.data.lastHealthCheck).toBeInstanceOf(Date);
    expect(result).toEqual(expect.objectContaining({ id: 'sess-1' }));
  });

  it('UTC-067: autoLogin() catches browser errors and returns null (HAZ-013)', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    browser.createContext.mockRejectedValue(new Error('browser launch failed'));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const errCall = errorSpy.mock.calls.find((c) => /Auto-login failed/i.test(String(c[0])));
    expect(errCall).toBeTruthy();
  });

  // ── updateStorageState ────────────────────────────────────────────────────

  it('UTC-068: updateStorageState() persists JSON-parsed state and sets ACTIVE + lastHealthCheck', async () => {
    prisma.session.update.mockResolvedValue({});

    const t = await setup();

    await t.service.updateStorageState('sess-1', '{"cookies":[]}');

    expect(t.prisma.session.update).toHaveBeenCalledOnce();
    const arg = t.prisma.session.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'sess-1' });
    // P0-H3: storageState is now encrypted (stringified in passthrough mock mode)
    expect(arg.data.storageState).toEqual('{"cookies":[]}');
    expect(arg.data.status).toBe(SessionStatus.ACTIVE);
    expect(arg.data.lastHealthCheck).toBeInstanceOf(Date);
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  it('UTC-069: healthCheck() returns unhealthy when no account found', async () => {
    const t = await setup({ accounts: createMockAccountsService({}) }); // no account

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result).toEqual({ healthy: false, message: 'No account found' });
    expect(t.prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('UTC-070: healthCheck() returns unhealthy when no active session exists', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const t = await setup({ accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }) });

    const result = await t.service.healthCheck(SocialNetwork.THREADS);

    expect(result).toEqual({ healthy: false, message: 'No active session' });
    expect(t.prisma.session.findFirst).toHaveBeenCalledWith({
      where: { accountId: ACCOUNT_THREADS.id, status: SessionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
    expect(t.browser.createContext).not.toHaveBeenCalled();
    expect(t.browser.acquireContext).not.toHaveBeenCalled();
  });

  it('UTC-071: healthCheck() marks session EXPIRED when redirected to login page (HAZ-007)', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // redirected to /login
    const page = createMockPage({ url: 'https://x.com/login', successVisible: false });
    const context = createMockContext(page);
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/expired/i);
    // update called with EXPIRED status
    const expiredCall = t.prisma.session.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.EXPIRED,
    );
    expect(expiredCall).toBeTruthy();
    expect(expiredCall[0].where).toEqual({ id: ACTIVE_SESSION.id });
    expect(page.close).toHaveBeenCalled();
    expect(t.browser.releaseContext).toHaveBeenCalled();
  });

  it('UTC-072: healthCheck() updates lastHealthCheck and returns healthy when session valid', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // stays on /home (not login) — provide auth cookies for deep health check
    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page, {
      cookies: [
        { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
        { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
      ],
    });
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result).toEqual({ healthy: true, message: 'Session active' });
    // update called with lastHealthCheck (no status change to EXPIRED)
    const updateCall = t.prisma.session.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.lastHealthCheck instanceof Date && c[0]?.data?.status !== SessionStatus.EXPIRED,
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[0].where).toEqual({ id: ACTIVE_SESSION.id });
    expect(updateCall[0].data.lastHealthCheck).toBeInstanceOf(Date);
    expect(t.browser.releaseContext).toHaveBeenCalled();
  });

  it('UTC-073: healthCheck() catches browser errors and returns unhealthy with error message (HAZ-013)', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    browser.acquireContext.mockRejectedValue(new Error('context failed'));

    const t = await setup({ accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }) });

    const result = await t.service.healthCheck(SocialNetwork.FACEBOOK);

    expect(result.healthy).toBe(false);
    expect(result.message).toContain('context failed');
    expect(result.message).toMatch(/Health check error/i);
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  it('UTC-074: findAll() returns sessions ordered by createdAt DESC with account include, limit 20', async () => {
    const sessions = [{ ...ACTIVE_SESSION, account: ACCOUNT_X }];
    prisma.session.findMany.mockResolvedValue(sessions);

    const t = await setup();

    const result = await t.service.findAll();

    expect(result).toEqual(sessions);
    expect(t.prisma.session.findMany).toHaveBeenCalledOnce();
    expect(t.prisma.session.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      include: { account: true },
      take: 20,
    });
  });

  // ── P0-H3: Encryption passthrough round-trip ──────────────────────────────

  it('UTC-075: healthCheck() correctly handles passthrough string storageState (no double-encoding)', async () => {
    // Simulate what real Prisma returns when encrypt() stored a JSON string
    // in a Json column: the value comes back as a JavaScript string.
    const passthroughSession = {
      ...ACTIVE_SESSION,
      storageState: '{"cookies":[{"name":"auth","value":"token"}],"origins":[]}',
    };
    prisma.session.findFirst.mockResolvedValue(passthroughSession);
    prisma.session.update.mockResolvedValue({});

    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page);
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    await t.service.healthCheck(SocialNetwork.X);

    // acquireContext should receive the raw JSON string, NOT double-encoded
    expect(t.browser.acquireContext).toHaveBeenCalledWith(
      SocialNetwork.X,
      '{"cookies":[{"name":"auth","value":"token"}],"origins":[]}',
      ACCOUNT_X.id,
    );
  });

  // ── Auto-login: Facebook persistent context (c_user cookie → skip login) ───

  it('UTC-076: autoLogin() FACEBOOK with existing c_user cookie skips login form and saves session directly', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-persist', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    // c_user cookie present → persistent context path (skip login form)
    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const context = createMockContext(page, {
      cookies: [{ name: 'c_user', value: '10000123', domain: '.facebook.com' }],
    });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.FACEBOOK, undefined, ACCOUNT_FB.id);
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    const createArg = t.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_FB.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-persist' }));
  });

  // ── Auto-login: Facebook full login form (no c_user cookie) ────────────────

  it('UTC-077: autoLogin() FACEBOOK without c_user cookie fills login form and creates session on success', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-login', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    // No c_user cookie → proceed with full login form
    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.FACEBOOK, undefined, ACCOUNT_FB.id);
    // Login form was filled (pressSequentially called for username + password)
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-login' }));
  });

  // ── Auto-login: Threads (detailed flow) ────────────────────────────────────

  it('UTC-078: autoLogin() THREADS fills login form with Threads selectors and creates session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-threads-2', accountId: ACCOUNT_THREADS.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.threads.net/home', successVisible: true });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }),
      config: createMockConfigService({
        SOCIAL_THREADS_USERNAME: 'myzodiacai',
        SOCIAL_THREADS_PASSWORD: 'threads-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.THREADS);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.THREADS, undefined, ACCOUNT_THREADS.id);
    expect(t.browser.saveStorageState).toHaveBeenCalledWith(context);
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    const createArg = t.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_THREADS.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);
    expect(result).toEqual(expect.objectContaining({ id: 'sess-threads-2' }));
  });

  // ── Cookie-based authentication ────────────────────────────────────────────

  it('UTC-079: tryCookieAuth() X — SOCIAL_X_COOKIES set → skip login → create session from cookies', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-cookie-x', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const context = createMockContext(page, {
      cookies: [
        { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
        { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
      ],
    });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'auth_token=test-auth-token; ct0=test-ct0',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // Cookie auth: browser context created, cookies added, session created
    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.X, undefined, ACCOUNT_X.id);
    expect(context.addCookies).toHaveBeenCalledOnce();
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    const createArg = t.prisma.session.create.mock.calls[0][0];
    expect(createArg.data.accountId).toBe(ACCOUNT_X.id);
    expect(createArg.data.status).toBe(SessionStatus.ACTIVE);
    expect(result).toEqual(expect.objectContaining({ id: 'sess-cookie-x' }));
  });

  it('UTC-080: tryCookieAuth() fails when redirected to login page → returns null, falls back to autoLogin', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fallback', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    // First createContext (cookie auth): URL includes /login → cookie auth fails
    const cookiePage = createMockPage({ url: 'https://x.com/login', successVisible: true });
    const cookieContext = createMockContext(cookiePage, {
      cookies: [
        { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
        { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
      ],
    });
    // Second createContext (autoLogin): URL is /home → login succeeds
    const loginPage = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const loginContext = createMockContext(loginPage);
    browser.createContext
      .mockResolvedValueOnce(cookieContext)
      .mockResolvedValueOnce(loginContext);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'auth_token=test-auth-token; ct0=test-ct0',
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // Cookie auth failed (redirected to login) → fell back to autoLogin → session created
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fallback' }));
    // createContext called twice: once for cookie auth, once for autoLogin
    expect(t.browser.createContext).toHaveBeenCalledTimes(2);
  });

  it('UTC-081: tryCookieAuth() fails when auth cookies cleared by server → returns null, falls back to autoLogin', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fallback-2', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    // First createContext (cookie auth): URL is /home but cookies missing ct0
    const cookiePage = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const cookieContext = createMockContext(cookiePage, {
      cookies: [
        // auth_token present but ct0 missing → server cleared it
        { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
      ],
    });
    // Second createContext (autoLogin): login succeeds
    const loginPage = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const loginContext = createMockContext(loginPage);
    browser.createContext
      .mockResolvedValueOnce(cookieContext)
      .mockResolvedValueOnce(loginContext);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'auth_token=test-auth-token; ct0=test-ct0',
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // Cookie auth failed (ct0 cleared) → fell back to autoLogin → session created
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fallback-2' }));
    expect(t.browser.createContext).toHaveBeenCalledTimes(2);
  });

  it('UTC-082: tryCookieAuth() catches browser errors and returns null, falls back to autoLogin', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fallback-3', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    // First createContext (cookie auth) fails, second (autoLogin) succeeds
    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const context = createMockContext(page);
    browser.createContext
      .mockRejectedValueOnce(new Error('browser crash'))
      .mockResolvedValueOnce(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'auth_token=test; ct0=test',
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // Cookie auth caught error → fell back to autoLogin → session created
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fallback-3' }));
  });

  // ── Circuit breaker scenarios ──────────────────────────────────────────────

  it('UTC-083: circuit breaker opens after 3 failed login attempts → 4th getOrCreateSession returns null', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    // Access the circuit breaker registry directly and force 3 failures
    const breaker = t.service['circuitBreakers'].get(`login:${ACCOUNT_X.id}`, {
      failureThreshold: 3,
      resetTimeoutMs: 900000,
      failureWindowMs: 600000,
    });

    // Force 3 failures by making the breaker execute failing operations
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => Promise.reject(new Error('login failed'))))
        .rejects.toThrow('login failed');
    }

    // Verify breaker is OPEN
    expect(breaker.currentState).toBe('OPEN');

    // 4th attempt: getOrCreateSession checks canExecute() → false → returns null
    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    // Browser NOT touched when circuit is open
    expect(t.browser.createContext).not.toHaveBeenCalled();
  });

  it('UTC-084: circuit breaker timeout → HALF_OPEN → trial success → CLOSED', async () => {
    vi.useFakeTimers();
    try {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.create.mockResolvedValue({ id: 'sess-recover', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

      const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
      const context = createMockContext(page);
      browser.createContext.mockResolvedValue(context);
      browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

      const t = await setup({
        accounts: createMockAccountsService({ X: ACCOUNT_X }),
        config: createMockConfigService({
          SOCIAL_X_USERNAME: 'myzodiacai',
          SOCIAL_X_PASSWORD: 'secret-pass',
        }),
      });

      // Force breaker open with 3 failures
      const breaker = t.service['circuitBreakers'].get(`login:${ACCOUNT_X.id}`, {
        failureThreshold: 3,
        resetTimeoutMs: 900000,
        failureWindowMs: 600000,
      });
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(() => Promise.reject(new Error('fail'))))
          .rejects.toThrow('fail');
      }
      expect(breaker.currentState).toBe('OPEN');

      // Advance time past resetTimeoutMs (900000ms = 15 min)
      vi.advanceTimersByTime(900001);

      // Now canExecute() should return true (HALF_OPEN)
      expect(breaker.canExecute()).toBe(true);

      // getOrCreateSession → autoLogin succeeds → breaker CLOSED
      const result = await t.service.getOrCreateSession(SocialNetwork.X);

      expect(result).toEqual(expect.objectContaining({ id: 'sess-recover' }));
      expect(breaker.currentState).toBe('CLOSED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('UTC-085: circuit breaker HALF_OPEN → trial failure → re-OPEN', async () => {
    vi.useFakeTimers();
    try {
      prisma.session.findFirst.mockResolvedValue(null);

      const t = await setup({
        accounts: createMockAccountsService({ X: ACCOUNT_X }),
        config: createMockConfigService({
          SOCIAL_X_USERNAME: 'myzodiacai',
          SOCIAL_X_PASSWORD: 'secret-pass',
        }),
      });

      // Force breaker open with 3 failures
      const breaker = t.service['circuitBreakers'].get(`login:${ACCOUNT_X.id}`, {
        failureThreshold: 3,
        resetTimeoutMs: 900000,
        failureWindowMs: 600000,
      });
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(() => Promise.reject(new Error('fail'))))
          .rejects.toThrow('fail');
      }
      expect(breaker.currentState).toBe('OPEN');

      // Advance time past resetTimeoutMs → HALF_OPEN (triggered by canExecute)
      vi.advanceTimersByTime(900001);
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.currentState).toBe('HALF_OPEN');

      // Make autoLogin fail (password missing) → getOrCreateSession returns null after
      // the breaker records the AutoLoginFailedError and transitions HALF_OPEN → OPEN.
      t.config.get.mockImplementation((key: string, def?: string) => {
        if (key === 'SOCIAL_X_USERNAME') return 'myzodiacai';
        // password intentionally missing
        return def ?? '';
      });

      const result = await t.service.getOrCreateSession(SocialNetwork.X);

      expect(result).toBeNull();
      // Breaker should be re-OPEN
      expect(breaker.currentState).toBe('OPEN');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Session expiry → re-login ──────────────────────────────────────────────

  it('UTC-086: markSessionExpired() then getOrCreateSession() triggers auto-login for fresh session', async () => {
    prisma.session.update.mockResolvedValue({});
    prisma.session.findFirst.mockResolvedValue(null); // no ACTIVE session after expiry
    prisma.session.create.mockResolvedValue({ id: 'sess-fresh', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });

    // Step 1: mark session as expired
    await t.service.markSessionExpired(SocialNetwork.X, 'sess-old-1');
    expect(t.prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-old-1' },
      data: { status: SessionStatus.EXPIRED },
    });

    // Step 2: getOrCreateSession finds no ACTIVE session → auto-login
    const result = await t.service.getOrCreateSession(SocialNetwork.X);
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fresh' }));
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
  });

  // ── decryptStorageState ────────────────────────────────────────────────────

  it('UTC-087: decryptStorageState() with encrypted string (v1: prefix) → decrypts and returns JSON string', async () => {
    const t = await setup();
    const enc = t.service['encryptionService'] as { isEncrypted: ReturnType<typeof vi.fn>; decrypt: ReturnType<typeof vi.fn> };
    enc.isEncrypted.mockReturnValue(true);
    enc.decrypt.mockReturnValue({ cookies: [{ name: 'auth', value: 'token' }], origins: [] });

    const result = t.service.decryptStorageState({ storageState: 'v1:abc:def:ghi' });

    expect(enc.decrypt).toHaveBeenCalledWith('v1:abc:def:ghi');
    expect(result).toBe(JSON.stringify({ cookies: [{ name: 'auth', value: 'token' }], origins: [] }));
  });

  it('UTC-088: decryptStorageState() passthrough mode (no v1: prefix) → returns string as-is', async () => {
    const t = await setup();

    const jsonStr = '{"cookies":[],"origins":[]}';
    const result = t.service.decryptStorageState({ storageState: jsonStr });

    expect(result).toBe(jsonStr);
  });

  it('UTC-089: decryptStorageState() with legacy plaintext object → JSON.stringify', async () => {
    const t = await setup();

    const legacyObj = { cookies: [{ name: 'sess', value: 'abc' }], origins: [] };
    const result = t.service.decryptStorageState({ storageState: legacyObj });

    expect(result).toBe(JSON.stringify(legacyObj));
  });

  // ── markSessionExpired ─────────────────────────────────────────────────────

  it('UTC-090: markSessionExpired() calls prisma.session.update with status=EXPIRED', async () => {
    prisma.session.update.mockResolvedValue({});

    const t = await setup();

    await t.service.markSessionExpired(SocialNetwork.X, 'sess-123');

    expect(t.prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-123' },
      data: { status: SessionStatus.EXPIRED },
    });
  });

  it('UTC-091: markSessionExpired() catches prisma errors gracefully (no throw)', async () => {
    prisma.session.update.mockRejectedValue(new Error('DB connection lost'));

    const t = await setup();
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    // Should NOT throw — error is caught internally
    await expect(t.service.markSessionExpired(SocialNetwork.X, 'sess-456')).resolves.toBeUndefined();

    const warnCall = warnSpy.mock.calls.find((c) => /Failed to mark session/i.test(String(c[0])));
    expect(warnCall).toBeTruthy();
  });

  // ── Concurrent session creation (race condition) ───────────────────────────

  it('UTC-092: concurrent getOrCreateSession for same network — second call reuses session from first (sessionLock)', async () => {
    const NEW_SESSION = { id: 'sess-concurrent', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE };

    prisma.session.findFirst
      .mockResolvedValueOnce(null) // Call A: initial check
      .mockResolvedValueOnce(null) // Call A: double-check after lock
      .mockResolvedValueOnce(null) // Call B: initial check
      .mockResolvedValueOnce(NEW_SESSION); // Call B: re-check after lock wait

    prisma.session.create.mockResolvedValue(NEW_SESSION);

    // Deferred createContext — Call A will be suspended here
    let resolveCreateContext!: (ctx: unknown) => void;
    const ctxPromise = new Promise<unknown>((resolve) => { resolveCreateContext = resolve; });
    browser.createContext.mockReturnValue(ctxPromise);

    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const context = createMockContext(page);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
        FORM_LOGIN_COOLDOWN_MS: '1800000', // SE1 cooldown on for the concurrent-login assertions
      }),
    });

    // Start both calls concurrently
    const callA = t.service.getOrCreateSession(SocialNetwork.X);
    const callB = t.service.getOrCreateSession(SocialNetwork.X);

    // Let microtasks settle — Call B should be waiting on Call A's lock
    await new Promise((resolve) => setImmediate(resolve));

    // Resolve Call A's createContext — Call A completes, then Call B resumes
    resolveCreateContext(context);

    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(resultA).toEqual(NEW_SESSION);
    expect(resultB).toEqual(NEW_SESSION);
    // Only Call A creates a browser context — Call B reuses the session
    expect(t.browser.createContext).toHaveBeenCalledTimes(1);
    // Only one session.create call (from Call A)
    expect(t.prisma.session.create).toHaveBeenCalledTimes(1);
  });

  // ── createSession ──────────────────────────────────────────────────────────

  it('UTC-093: createSession() creates session with encrypted storageState and ACTIVE status', async () => {
    prisma.session.create.mockResolvedValue({});

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    await t.service.createSession(SocialNetwork.X, '{"cookies":[],"origins":[]}');

    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    const arg = t.prisma.session.create.mock.calls[0][0];
    expect(arg.data.accountId).toBe(ACCOUNT_X.id);
    expect(arg.data.status).toBe(SessionStatus.ACTIVE);
    expect(arg.data.lastHealthCheck).toBeInstanceOf(Date);
  });

  it('UTC-094: createSession() returns early when no account found for network', async () => {
    const t = await setup({ accounts: createMockAccountsService({}) });

    await t.service.createSession(SocialNetwork.X, '{"cookies":[],"origins":[]}');

    expect(t.prisma.session.create).not.toHaveBeenCalled();
  });

  // ── cleanupExpiredSessions ─────────────────────────────────────────────────

  it('UTC-095: cleanupExpiredSessions() deletes old expired sessions beyond 5 per account', async () => {
    // Account 1: 7 expired sessions (keep 5, delete 2 oldest)
    // Account 2: 3 expired sessions (keep all 3, delete 0)
    const expiredSessions = [
      { id: 's1', accountId: 'acc1', createdAt: new Date('2026-07-10') },
      { id: 's2', accountId: 'acc1', createdAt: new Date('2026-07-09') },
      { id: 's3', accountId: 'acc1', createdAt: new Date('2026-07-08') },
      { id: 's4', accountId: 'acc1', createdAt: new Date('2026-07-07') },
      { id: 's5', accountId: 'acc1', createdAt: new Date('2026-07-06') },
      { id: 's6', accountId: 'acc1', createdAt: new Date('2026-07-05') }, // delete
      { id: 's7', accountId: 'acc1', createdAt: new Date('2026-07-04') }, // delete
      { id: 's8', accountId: 'acc2', createdAt: new Date('2026-07-03') },
      { id: 's9', accountId: 'acc2', createdAt: new Date('2026-07-02') },
      { id: 's10', accountId: 'acc2', createdAt: new Date('2026-07-01') },
    ];
    prisma.session.findMany.mockResolvedValue(expiredSessions);
    prisma.session.deleteMany.mockResolvedValue({ count: 2 });

    const t = await setup();

    const result = await t.service.cleanupExpiredSessions();

    expect(result).toEqual({ deleted: 2 });
    expect(t.prisma.session.findMany).toHaveBeenCalledWith({
      where: { status: SessionStatus.EXPIRED },
      orderBy: { createdAt: 'desc' },
      select: { id: true, accountId: true },
    });
    expect(t.prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s6', 's7'] } },
    });
  });

  it('UTC-096: cleanupExpiredSessions() returns {deleted: 0} when no expired sessions exist', async () => {
    prisma.session.findMany.mockResolvedValue([]);

    const t = await setup();

    const result = await t.service.cleanupExpiredSessions();

    expect(result).toEqual({ deleted: 0 });
    expect(t.prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it('UTC-097: cleanupExpiredSessions() catches errors and returns {deleted: 0}', async () => {
    prisma.session.findMany.mockRejectedValue(new Error('DB error'));

    const t = await setup();
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    const result = await t.service.cleanupExpiredSessions();

    expect(result).toEqual({ deleted: 0 });
    const warnCall = warnSpy.mock.calls.find((c) => /Failed to cleanup/i.test(String(c[0])));
    expect(warnCall).toBeTruthy();
  });

  // ── healthCheck: expired/missing auth cookies ──────────────────────────────

  it('UTC-098: healthCheck() marks EXPIRED when required auth cookies are missing', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // URL is /home (not login) but cookies are missing required auth cookies
    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page, {
      cookies: [{ name: 'other_cookie', value: 'xxx', domain: '.x.com' }], // no auth_token or ct0
    });
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/missing auth cookies/i);
    const expiredCall = t.prisma.session.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.EXPIRED,
    );
    expect(expiredCall).toBeTruthy();
    expect(expiredCall[0].where).toEqual({ id: ACTIVE_SESSION.id });
  });

  it('UTC-099: healthCheck() marks EXPIRED when auth cookies have past expiry timestamps', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // Cookies present but expired (expires in 1970)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page, {
      cookies: [
        { name: 'auth_token', value: 'test', domain: '.x.com', expires: 1000 },
        { name: 'ct0', value: 'test', domain: '.x.com', expires: 1000 },
      ],
    });
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/cookies expired/i);
    const expiredCall = t.prisma.session.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.EXPIRED,
    );
    expect(expiredCall).toBeTruthy();
  });

  it('UTC-100: healthCheck() for THREADS navigates to threads.com and validates sessionid cookie', async () => {
    const THREADS_SESSION = {
      ...ACTIVE_SESSION,
      accountId: ACCOUNT_THREADS.id,
      storageState: '{"cookies":[],"origins":[]}',
    };
    prisma.session.findFirst.mockResolvedValue(THREADS_SESSION);
    prisma.session.update.mockResolvedValue({});

    const page = createMockPage({ url: 'https://www.threads.com/', successVisible: false });
    const context = createMockContext(page, {
      cookies: [{ name: 'sessionid', value: 'test-session-id', domain: '.threads.com' }],
    });
    browser.acquireContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }) });

    const result = await t.service.healthCheck(SocialNetwork.THREADS);

    expect(result).toEqual({ healthy: true, message: 'Session active' });
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.threads.com/',
      expect.objectContaining({ waitUntil: 'networkidle' }),
    );
  });

  // ── updateStorageState after posting ───────────────────────────────────────

  it('UTC-101: updateStorageState() encrypts state and persists via prisma.session.update', async () => {
    prisma.session.update.mockResolvedValue({});

    const t = await setup();
    const enc = t.service['encryptionService'] as { encrypt: ReturnType<typeof vi.fn>; isEnabled: ReturnType<typeof vi.fn> };

    const stateStr = '{"cookies":[{"name":"new","value":"cookie"}],"origins":[]}';
    await t.service.updateStorageState('sess-post-post', stateStr);

    expect(enc.encrypt).toHaveBeenCalledWith(JSON.parse(stateStr));
    expect(t.prisma.session.update).toHaveBeenCalledOnce();
    const arg = t.prisma.session.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'sess-post-post' });
    expect(arg.data.status).toBe(SessionStatus.ACTIVE);
    expect(arg.data.lastHealthCheck).toBeInstanceOf(Date);
  });

  // ── getOrCreateSession: double-check after lock ────────────────────────────

  it('UTC-102: getOrCreateSession() double-check after lock finds session created between initial check and lock acquisition', async () => {
    // Simulate: initial findFirst → null, but double-check (after lock) → session exists
    prisma.session.findFirst
      .mockResolvedValueOnce(null)     // initial check → no session
      .mockResolvedValueOnce(ACTIVE_SESSION);  // double-check after lock → session found

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toEqual(ACTIVE_SESSION);
    // Browser NOT touched — session found in double-check
    expect(t.browser.createContext).not.toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
  });

  // ── Cookie auth: edge cases ────────────────────────────────────────────────

  it('UTC-103: tryCookieAuth() with invalid cookie string (no = signs) → returns null, no createContext', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'invalid_no_equals;; ;',
      }),
    });
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // Cookie auth failed (invalid format) → autoLogin also fails (no credentials) → null
    expect(result).toBeNull();
    expect(t.browser.createContext).not.toHaveBeenCalled();
    const parseWarn = warnSpy.mock.calls.find((c) => /Failed to parse.*cookies/i.test(String(c[0])));
    expect(parseWarn).toBeTruthy();
  });

  it('UTC-104: tryCookieAuth() with missing required cookies → returns null, no createContext', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_COOKIES: 'other_cookie=some_value',
      }),
    });
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(t.browser.createContext).not.toHaveBeenCalled();
    const missingWarn = warnSpy.mock.calls.find((c) => /missing required cookies/i.test(String(c[0])));
    expect(missingWarn).toBeTruthy();
  });

  it('UTC-105: tryCookieAuth() THREADS — SOCIAL_THREADS_COOKIES set → create session from sessionid cookie', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-cookie-threads', accountId: ACCOUNT_THREADS.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.threads.com/', successVisible: true });
    const context = createMockContext(page, {
      cookies: [{ name: 'sessionid', value: 'test-session-id', domain: '.threads.com' }],
    });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ THREADS: ACCOUNT_THREADS }),
      config: createMockConfigService({
        SOCIAL_THREADS_COOKIES: 'sessionid=test-session-id',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.THREADS);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.THREADS, undefined, ACCOUNT_THREADS.id);
    expect(context.addCookies).toHaveBeenCalledOnce();
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-cookie-threads' }));
  });

  // ── Facebook: c_user found but session invalid → proceeds with login ──────

  it('UTC-106: autoLogin() FACEBOOK c_user cookie found but session invalid (URL=/login) → proceeds with login form → c_user still present → saves session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-relogin', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    // c_user cookie present BUT url includes /login → session invalid → proceed with login
    // After login form, c_user still present → hasCUserCookie=true → save session
    const page = createMockPage({ url: 'https://www.facebook.com/login', successVisible: true });
    const context = createMockContext(page, {
      cookies: [
        { name: 'c_user', value: '10000123', domain: '.facebook.com' },
        { name: 'xs', value: 'xs-token', domain: '.facebook.com' },
      ],
    });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    // c_user cookie found but invalid → warning logged → login form → c_user present → session saved
    const invalidWarn = warnSpy.mock.calls.find((c) => /c_user cookie found but session invalid/i.test(String(c[0])));
    expect(invalidWarn).toBeTruthy();
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-relogin' }));
  });

  // ── Challenge page in headless mode ────────────────────────────────────────

  it('UTC-107: autoLogin() X — challenge page detected in headless mode → returns null, sends discord alert', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // URL includes 'challenge' after login form submission
    const page = createMockPage({ url: 'https://x.com/challenge', successVisible: true });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    // Discord critical alert sent
    const discord = t.service['discord'] as { critical: ReturnType<typeof vi.fn> };
    expect(discord.critical).toHaveBeenCalled();
    // Error logged about challenge/captcha
    const challengeErr = errorSpy.mock.calls.find((c) => /challenge|captcha/i.test(String(c[0])));
    expect(challengeErr).toBeTruthy();
  });

  // ── X 2FA in headless mode ─────────────────────────────────────────────────

  it('UTC-108: autoLogin() X — 2FA challenge in headless mode → waits for code via API, returns null on timeout', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // Create page where 2FA input IS visible (override default mock that hides it)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      if (selector.includes('ocfEnterText') || selector.includes('twoFactor')) {
        return {
          ...result,
          first: () => ({
            ...result.first(),
            isVisible: vi.fn().mockResolvedValue(true),
          }),
        };
      }
      return result;
    }) as unknown as typeof page.locator;

    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const warnSpy = vi.spyOn(t.service['logger'], 'warn');

    // Mock email reader + waitForVerificationCode to return null (simulates no code found)
    const emailReader = t.service['emailReader'] as { pollForVerificationCode: ReturnType<typeof vi.fn> };
    emailReader.pollForVerificationCode.mockResolvedValue(null);
    vi.spyOn(t.service, 'waitForVerificationCode').mockResolvedValue(null);

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    // 2FA detected warning
    const twoFAWarn = warnSpy.mock.calls.find((c) => /two-factor|2FA/i.test(String(c[0])));
    expect(twoFAWarn).toBeTruthy();
    // Discord warning sent (not critical — it's a "code needed" alert)
    const discord = t.service['discord'] as { warning: ReturnType<typeof vi.fn> };
    expect(discord.warning).toHaveBeenCalled();
  });

  // ── Facebook: no c_user cookie → proceed with login (log message) ──────────

  it('UTC-109: autoLogin() FACEBOOK no c_user cookie → logs "no c_user cookie found" and proceeds with login form', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-nocookie', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });
    const logSpy = vi.spyOn(t.service['logger'], 'log');

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    // "no c_user cookie found" log message
    const noCookieLog = logSpy.mock.calls.find((c) => /no c_user cookie found/i.test(String(c[0])));
    expect(noCookieLog).toBeTruthy();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-nocookie' }));
  });

  // ── Facebook: login still on login page after submit → fail ───────────────

  it('UTC-110: autoLogin() FACEBOOK still on /login page after submit → returns null (login failed)', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // No c_user cookie, URL stays on /login after form submission
    const page = createMockPage({ url: 'https://mbasic.facebook.com/login', successVisible: true });
    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(result).toBeNull();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const failErr = errorSpy.mock.calls.find((c) => /Login failed/i.test(String(c[0])));
    expect(failErr).toBeTruthy();
  });

  // ── Cookie auth: FACEBOOK cookies ──────────────────────────────────────────

  it('UTC-111: tryCookieAuth() FACEBOOK — SOCIAL_FACEBOOK_COOKIES set → create session from c_user + xs cookies', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-cookie-fb', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const context = createMockContext(page, {
      cookies: [
        { name: 'c_user', value: '10000123', domain: '.facebook.com' },
        { name: 'xs', value: 'test-xs', domain: '.facebook.com' },
      ],
    });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_COOKIES: 'c_user=10000123; xs=test-xs',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.FACEBOOK, undefined, ACCOUNT_FB.id);
    expect(context.addCookies).toHaveBeenCalledOnce();
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ id: 'sess-cookie-fb' }));
  });

  // ── getOrCreateSession: concurrent lock wait then no session → creates new ─

  it('UTC-112: concurrent getOrCreateSession — second call waits for lock; SE1 cooldown throttles its back-to-back form login (returns null)', async () => {
    const SESSION_A = { id: 'sess-a', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE };
    const SESSION_B = { id: 'sess-b', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE };

    prisma.session.findFirst
      .mockResolvedValueOnce(null)      // Call A: initial check
      .mockResolvedValueOnce(null)      // Call A: double-check after lock
      .mockResolvedValueOnce(null)      // Call B: initial check
      .mockResolvedValueOnce(null)      // Call B: re-check after lock wait (no session found)
      .mockResolvedValueOnce(null)      // Call B: double-check after acquiring lock
      .mockResolvedValueOnce(SESSION_B);// Call B: not used (autoLogin creates)

    prisma.session.create
      .mockResolvedValueOnce(SESSION_A) // Call A: autoLogin creates
      .mockResolvedValueOnce(SESSION_B); // Call B: autoLogin creates

    // Deferred createContext — Call A will be suspended here
    let resolveCtxA!: (ctx: unknown) => void;
    const ctxPromiseA = new Promise<unknown>((resolve) => { resolveCtxA = resolve; });
    const pageA = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const contextA = createMockContext(pageA);
    const pageB = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const contextB = createMockContext(pageB);
    browser.createContext
      .mockReturnValueOnce(ctxPromiseA)
      .mockResolvedValueOnce(contextB);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
        FORM_LOGIN_COOLDOWN_MS: '1800000', // SE1 cooldown on for the concurrent-login assertions
      }),
    });

    // Start both calls concurrently
    const callA = t.service.getOrCreateSession(SocialNetwork.X);
    const callB = t.service.getOrCreateSession(SocialNetwork.X);

    // Let microtasks settle — Call B should be waiting on Call A's lock
    await new Promise((resolve) => setImmediate(resolve));

    // Resolve Call A's createContext
    resolveCtxA(contextA);

    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(resultA).toEqual(SESSION_A);
    // SE1: the form-login cooldown now throttles a second back-to-back login for the same
    // network — Call B returns null instead of performing a duplicate form login.
    expect(resultB).toBeNull();
    expect(t.browser.createContext).toHaveBeenCalledTimes(1);
  });

  // ── SPA_DRY_RUN debug dump ─────────────────────────────────────────────────

  it('UTC-113: autoLogin() SPA_DRY_RUN=true dumps login page HTML to /tmp/spa-debug', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-dry', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
        SPA_DRY_RUN: 'true',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);
    // Login should still succeed with SPA_DRY_RUN enabled
    expect(result).toEqual(expect.objectContaining({ id: 'sess-dry' }));
  });

  // ── X username empty after all strategies → return null ────────────────────

  it('UTC-114: autoLogin() X — username field empty after typeHuman, React setter, and fill → returns null', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // Create page where inputValue always returns '' (username never gets filled)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      return {
        ...result,
        first: () => ({
          ...result.first(),
          inputValue: vi.fn().mockResolvedValue(''),
          evaluate: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }) as unknown as typeof page.locator;

    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const emptyErr = errorSpy.mock.calls.find((c) => /username field is empty/i.test(String(c[0])));
    expect(emptyErr).toBeTruthy();
  });

  // ── X identity verification in headless mode ───────────────────────────────

  it('UTC-115: autoLogin() X — identity verification challenge (Step 1.5) in headless mode → returns null, sends discord alert', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    // Password field NOT visible after clicking Next → identity verification detected
    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      // Make password selectors invisible (triggers identity verification path)
      if (selector.includes('password') || selector.includes('type="password"')) {
        return {
          ...result,
          first: () => ({
            ...result.first(),
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        };
      }
      return result;
    }) as unknown as typeof page.locator;

    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalled();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const verifyErr = errorSpy.mock.calls.find((c) => /identity verification/i.test(String(c[0])));
    expect(verifyErr).toBeTruthy();
    // Discord critical alert sent
    const discord = t.service['discord'] as { critical: ReturnType<typeof vi.fn> };
    expect(discord.critical).toHaveBeenCalled();
  });

  // ── Other networks: password not visible → getByLabel fallback ─────────────

  it('UTC-116: autoLogin() FACEBOOK password field not visible → getByLabel("Password") fallback → login succeeds', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-pwfallback', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    // Password selector invisible → triggers getByLabel fallback
    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      if (selector.includes('type="password"') || selector.includes('m_login_password')) {
        return {
          ...result,
          first: () => ({
            ...result.first(),
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        };
      }
      return result;
    }) as unknown as typeof page.locator;

    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    // getByLabel fallback used → login succeeds
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-pwfallback' }));
    expect(page.getByLabel).toHaveBeenCalledWith('Password');
  });

  // ── Other networks: submit button not visible → fallback selector ──────────

  it('UTC-117: autoLogin() FACEBOOK submit button not visible → fallback selector → login succeeds', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-submitfb', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    // Primary submit selector invisible → triggers fallback selector
    const page = createMockPage({ url: 'https://www.facebook.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      // Match primary submit selector (contains button[name="login"])
      if (selector.includes('button[name="login"]')) {
        return {
          ...result,
          first: () => ({
            ...result.first(),
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        };
      }
      return result;
    }) as unknown as typeof page.locator;

    const context = createMockContext(page, { cookies: [] });
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-submitfb' }));
  });

  // ── X 2FA in headed mode → URL change → success ────────────────────────────

  it('UTC-118: autoLogin() X — 2FA in headed mode (CAMOUFOX_HEADLESS=false) → URL changes to /home → success', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-2fa-headed', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

    // 2FA input visible + URL=/home (2FA polling finds /home immediately)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
    const origLocator = page.locator as unknown as (sel: string) => { first: () => Record<string, ReturnType<typeof vi.fn>>; [k: string]: unknown };
    page.locator = vi.fn((selector: string) => {
      const result = origLocator(selector);
      if (selector.includes('ocfEnterText') || selector.includes('twoFactor')) {
        return {
          ...result,
          first: () => ({
            ...result.first(),
            isVisible: vi.fn().mockResolvedValue(true),
          }),
        };
      }
      return result;
    }) as unknown as typeof page.locator;

    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ X: ACCOUNT_X }),
      config: createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret-pass',
        CAMOUFOX_HEADLESS: 'false',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.X);

    // 2FA resolved (URL=/home) → login succeeds
    expect(result).toEqual(expect.objectContaining({ id: 'sess-2fa-headed' }));
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
  });

  // ── Facebook challenge page in headed mode → c_user cookie → success ───────

  it('UTC-119: autoLogin() FACEBOOK challenge page in headed mode → c_user cookie detected → session saved', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    prisma.session.create.mockResolvedValue({ id: 'sess-fb-challenge', accountId: ACCOUNT_FB.id, status: SessionStatus.ACTIVE });

    const page = createMockPage({ url: 'https://www.facebook.com/challenge', successVisible: true });
    // Pre-login: no c_user → proceed with login. Polling: c_user found → resolved. Post-challenge: c_user → save.
    const context = createMockContext(page);
    context.cookies
      .mockResolvedValueOnce([]) // pre-login check → no c_user
      .mockResolvedValue([
        { name: 'c_user', value: '10000123', domain: '.facebook.com' },
        { name: 'xs', value: 'xs-token', domain: '.facebook.com' },
      ]); // polling + post-challenge

    browser.createContext.mockResolvedValue(context);
    browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
        CAMOUFOX_HEADLESS: 'false',
      }),
    });

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    // Challenge resolved (c_user cookie) → session saved
    expect(result).toEqual(expect.objectContaining({ id: 'sess-fb-challenge' }));
    expect(t.prisma.session.create).toHaveBeenCalledOnce();
  });

  // ── Facebook challenge resolved but still on challenge page → fail ─────────

  it('UTC-120: autoLogin() FACEBOOK challenge resolved via c_user but post-challenge cookies empty → still on challenge → fail', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    const page = createMockPage({ url: 'https://www.facebook.com/challenge', successVisible: true });
    // Pre-login: no c_user. Polling: c_user found → resolved. Post-challenge: [] → no c_user → fail.
    const context = createMockContext(page);
    context.cookies
      .mockResolvedValueOnce([]) // pre-login check
      .mockResolvedValueOnce([{ name: 'c_user', value: '10000123', domain: '.facebook.com' }]) // challenge polling → resolved
      .mockResolvedValueOnce([]); // post-challenge check → no c_user

    browser.createContext.mockResolvedValue(context);

    const t = await setup({
      accounts: createMockAccountsService({ FACEBOOK: ACCOUNT_FB }),
      config: createMockConfigService({
        SOCIAL_FACEBOOK_USERNAME: 'myzodiacai@fb.com',
        SOCIAL_FACEBOOK_PASSWORD: 'fb-pass',
        CAMOUFOX_HEADLESS: 'false',
      }),
    });
    const errorSpy = vi.spyOn(t.service['logger'], 'error');

    const result = await t.service.getOrCreateSession(SocialNetwork.FACEBOOK);

    // Challenge resolved but post-challenge check fails (no c_user, still on challenge page)
    expect(result).toBeNull();
    expect(t.prisma.session.create).not.toHaveBeenCalled();
    const failErr = errorSpy.mock.calls.find((c) => /Login failed.*still on.*challenge/i.test(String(c[0])));
    expect(failErr).toBeTruthy();
  });

  describe('P1-1.1 cleanup: page before context', () => {
    it('tryCookieAuth success closes page and context in order', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.create.mockResolvedValue({ id: 'sess-cookie-cleanup', accountId: ACCOUNT_X.id, status: SessionStatus.ACTIVE });

      const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
      const context = createMockContext(page, {
        cookies: [
          { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
          { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
        ],
      });
      browser.createContext.mockResolvedValue(context);
      browser.saveStorageState.mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

      const t = await setup({
        accounts: createMockAccountsService({ X: ACCOUNT_X }),
        config: createMockConfigService({
          SOCIAL_X_COOKIES: 'auth_token=test-auth-token; ct0=test-ct0',
        }),
      });

      const result = await t.service.getOrCreateSession(SocialNetwork.X);

      expect(result).toEqual(expect.objectContaining({ id: 'sess-cookie-cleanup' }));
      expect(page.close).toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
      const pageCloseLast = page.close.mock.invocationCallOrder[page.close.mock.invocationCallOrder.length - 1];
      const contextCloseFirst = context.close.mock.invocationCallOrder[0];
      expect(pageCloseLast).toBeLessThan(contextCloseFirst);
    });

    it('tryCookieAuth failure still closes page and context', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      const page = createMockPage({ url: 'https://x.com/login', successVisible: true });
      const context = createMockContext(page, {
        cookies: [
          { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
          { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
        ],
      });
      browser.createContext.mockResolvedValue(context);

      const t = await setup({
        accounts: createMockAccountsService({ X: ACCOUNT_X }),
        config: createMockConfigService({
          SOCIAL_X_COOKIES: 'auth_token=test-auth-token; ct0=test-ct0',
        }),
      });

      const result = await t.service.getOrCreateSession(SocialNetwork.X);

      expect(result).toBeNull();
      expect(page.close).toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
      const pageCloseLast = page.close.mock.invocationCallOrder[page.close.mock.invocationCallOrder.length - 1];
      const contextCloseFirst = context.close.mock.invocationCallOrder[0];
      expect(pageCloseLast).toBeLessThan(contextCloseFirst);
    });

    it('autoLogin closes page and context when navigation fails', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      const page = createMockPage({ url: 'https://x.com/home', successVisible: true });
      page.goto.mockRejectedValue(new Error('navigation failed'));
      const context = createMockContext(page);
      browser.createContext.mockResolvedValue(context);

      const t = await setup({
        accounts: createMockAccountsService({ X: ACCOUNT_X }),
        config: createMockConfigService({
          SOCIAL_X_USERNAME: 'myzodiacai',
          SOCIAL_X_PASSWORD: 'secret-pass',
        }),
      });

      const result = await t.service.getOrCreateSession(SocialNetwork.X);

      expect(result).toBeNull();
      expect(page.close).toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
      const pageCloseLast = page.close.mock.invocationCallOrder[page.close.mock.invocationCallOrder.length - 1];
      const contextCloseFirst = context.close.mock.invocationCallOrder[0];
      expect(pageCloseLast).toBeLessThan(contextCloseFirst);
    });
  });
});
