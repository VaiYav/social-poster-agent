/**
 * MOD-04: Session Lifecycle Module — Vitest unit tests.
 *
 * Source: packages/backend/src/modules/sessions/sessions.service.ts
 * Test cases: features/spa/v-model/unit-test/unit-test-cases.md (UTC-060..074)
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
import { SessionStatus, SocialNetwork } from '@prisma/client';

import { SessionsService } from '../../../src/modules/sessions/sessions.service';
import { AccountsService } from '../../../src/modules/accounts/accounts.service';
import { PrismaService } from '../../../src/infrastructure/prisma/prisma.service';
import { IBrowserPort } from '../../../src/domain/ports/browser.port.js';
import {
  createMockPrismaService,
  createMockBrowserPort,
} from '../../mocks/index';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_X = { id: 'acc-x', network: SocialNetwork.X, handle: 'myzodiacai', active: true };
const ACCOUNT_THREADS = { id: 'acc-threads', network: SocialNetwork.THREADS, handle: 'myzodiacai', active: true };
const ACCOUNT_FB = { id: 'acc-fb', network: SocialNetwork.FACEBOOK, handle: 'myzodiacai@fb.com', active: true };

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
 */
function createMockPage(opts: { url: string; successVisible: boolean } = { url: 'https://x.com/home', successVisible: true }) {
  const locatorFirst = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(opts.successVisible),
    isEnabled: vi.fn().mockResolvedValue(true),
    isHidden: vi.fn().mockResolvedValue(false),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
  };
  const locatorResult = { first: () => locatorFirst };
  const locator = vi.fn().mockReturnValue(locatorResult);
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    locator,
    getByLabel: vi.fn().mockReturnValue(locatorResult),
    getByRole: vi.fn().mockReturnValue(locatorResult),
    getByText: vi.fn().mockReturnValue(locatorResult),
    url: vi.fn().mockReturnValue(opts.url),
    close: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    },
    _locatorFirst: locatorFirst,
  };
}

/**
 * Build a mock BrowserContext whose newPage() resolves to the supplied page.
 */
function createMockContext(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({}),
    pages: vi.fn().mockReturnValue([page]),
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

/** AccountsService mock with overridable findByNetwork. */
function createMockAccountsService(byNetwork: Record<string, any> = {}) {
  return {
    findByNetwork: vi.fn((network: SocialNetwork) => Promise.resolve(byNetwork[network] ?? null)),
    findAll: vi.fn().mockResolvedValue([]),
    seedFromEnv: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn(),
  };
}

async function buildModule(opts: {
  prisma?: any;
  browser?: any;
  accounts?: any;
  config?: ConfigService;
}): Promise<{ service: SessionsService; module: TestingModule; prisma: any; browser: any; accounts: any }> {
  const prisma = opts.prisma ?? createMockPrismaService();
  const browser = opts.browser ?? createMockBrowserPort();
  const accounts = opts.accounts ?? createMockAccountsService();
  const config = opts.config ?? createMockConfigService();

  const module = await Test.createTestingModule({
    providers: [
      SessionsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AccountsService, useValue: accounts },
      { provide: IBrowserPort, useValue: browser },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  const service = module.get(SessionsService);
  return { service, module, prisma, browser, accounts };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MOD-04: SessionsService', () => {
  let prisma: any;
  let browser: any;
  let accounts: any;
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
  async function setup(opts: { accounts?: any; config?: ConfigService; browser?: any; prisma?: any } = {}) {
    const acc = opts.accounts ?? accounts;
    const cfg = opts.config ?? config;
    const brw = opts.browser ?? browser;
    const prs = opts.prisma ?? prisma;

    // Restore design:paramtypes stripped by esbuild so Nest DI can resolve
    // the type-injected constructor params. Order matches the constructor:
    //   (prisma, accountsService, browser, configService)
    // The @Inject(IBrowserPort) token at index 2 overrides whatever is here.
    if (Reflect.getMetadata('design:paramtypes', SessionsService) == null) {
      Reflect.defineMetadata(
        'design:paramtypes',
        [PrismaService, AccountsService, Object, ConfigService],
        SessionsService,
      );
    }

    const compiled = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: prs },
        { provide: AccountsService, useValue: acc },
        { provide: IBrowserPort, useValue: brw },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();
    module = compiled;
    return {
      service: compiled.get(SessionsService),
      prisma: prs,
      browser: brw,
      accounts: acc,
      config: cfg,
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

    expect(t.browser.createContext).toHaveBeenCalledWith(SocialNetwork.THREADS);
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
    expect(createArg.data.storageState).toEqual(JSON.parse(savedState));
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
    expect(arg.data.storageState).toEqual({ cookies: [] });
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
  });

  it('UTC-071: healthCheck() marks session EXPIRED when redirected to login page (HAZ-007)', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // redirected to /login
    const page = createMockPage({ url: 'https://x.com/login', successVisible: false });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/expired/i);
    // update called with EXPIRED status
    const expiredCall = t.prisma.session.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === SessionStatus.EXPIRED,
    );
    expect(expiredCall).toBeTruthy();
    expect(expiredCall[0].where).toEqual({ id: ACTIVE_SESSION.id });
    expect(page.close).toHaveBeenCalled();
  });

  it('UTC-072: healthCheck() updates lastHealthCheck and returns healthy when session valid', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    prisma.session.update.mockResolvedValue({});

    // stays on /home (not login)
    const page = createMockPage({ url: 'https://x.com/home', successVisible: false });
    const context = createMockContext(page);
    browser.createContext.mockResolvedValue(context);

    const t = await setup({ accounts: createMockAccountsService({ X: ACCOUNT_X }) });

    const result = await t.service.healthCheck(SocialNetwork.X);

    expect(result).toEqual({ healthy: true, message: 'Session active' });
    // update called with lastHealthCheck (no status change to EXPIRED)
    const updateCall = t.prisma.session.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.lastHealthCheck instanceof Date && c[0]?.data?.status !== SessionStatus.EXPIRED,
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[0].where).toEqual({ id: ACTIVE_SESSION.id });
    expect(updateCall[0].data.lastHealthCheck).toBeInstanceOf(Date);
  });

  it('UTC-073: healthCheck() catches browser errors and returns unhealthy with error message (HAZ-013)', async () => {
    prisma.session.findFirst.mockResolvedValue(ACTIVE_SESSION);
    browser.createContext.mockRejectedValue(new Error('context failed'));

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
});
