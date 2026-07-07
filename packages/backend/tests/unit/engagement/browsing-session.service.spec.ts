/**
 * BrowsingSessionService unit tests — page-leak regression coverage.
 *
 * Source: packages/backend/src/modules/engagement/browsing-session.service.ts
 *
 * Focus: runBrowsingSession() must always close the Page it opens via
 * context.newPage(), on both the success path and any failure path. Prior to
 * this fix, `page` was declared inside the `try` block and closed only on
 * line ~175 (success path) — any exception thrown by the engagement graph
 * skipped page.close() entirely while the context was still returned to the
 * pool via `finally`, leaking one open Page per failed session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocialNetwork } from '@prisma/client';
import { BrowsingSessionService } from '../../../src/modules/engagement/browsing-session.service';
import {
  createMockPrismaService,
  createMockSseService,
  fixtureSession,
} from '../../mocks/index';

const mockInvoke = vi.fn();

vi.mock('../../../src/modules/engagement/engagement.graph.js', () => ({
  buildEngagementGraph: vi.fn(() => ({
    compile: () => ({ invoke: mockInvoke }),
  })),
  createEngagementInitialState: vi.fn((opts: Record<string, unknown>) => opts),
}));

describe('BrowsingSessionService — page lifecycle', () => {
  let service: BrowsingSessionService;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let sseService: ReturnType<typeof createMockSseService>;
  let mockPage: { close: ReturnType<typeof vi.fn> };
  let mockContext: { newPage: ReturnType<typeof vi.fn> };
  let browser: {
    acquireContext: ReturnType<typeof vi.fn>;
    releaseContext: ReturnType<typeof vi.fn>;
    saveStorageState: ReturnType<typeof vi.fn>;
    suppressPageErrors: ReturnType<typeof vi.fn>;
    applyResourceBlocking: ReturnType<typeof vi.fn>;
  };
  let sessionsService: {
    getOrCreateSession: ReturnType<typeof vi.fn>;
    decryptStorageState: ReturnType<typeof vi.fn>;
    updateStorageState: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockInvoke.mockReset();

    mockPage = { close: vi.fn().mockResolvedValue(undefined) };
    mockContext = { newPage: vi.fn().mockResolvedValue(mockPage) };
    browser = {
      acquireContext: vi.fn().mockResolvedValue(mockContext),
      releaseContext: vi.fn(),
      saveStorageState: vi.fn().mockResolvedValue(JSON.stringify({ cookies: [], origins: [] })),
      suppressPageErrors: vi.fn().mockResolvedValue(undefined),
      applyResourceBlocking: vi.fn().mockResolvedValue(undefined),
    };
    sessionsService = {
      getOrCreateSession: vi.fn().mockResolvedValue(fixtureSession),
      decryptStorageState: vi.fn().mockReturnValue(fixtureSession.storageState),
      updateStorageState: vi.fn().mockResolvedValue(undefined),
    };
    prisma = createMockPrismaService();
    prisma.browsingSession.create.mockResolvedValue({ id: 'bs-1' });
    prisma.browsingSession.update.mockResolvedValue({ id: 'bs-1' });
    sseService = createMockSseService();

    const configService = { get: vi.fn((_key: string, def?: unknown) => def) };
    const rateLimitService = {};
    const xEngager = { network: SocialNetwork.X };
    const threadsEngager = { network: SocialNetwork.THREADS };
    const facebookEngager = { network: SocialNetwork.FACEBOOK };
    const humanBehaviorEngine = {};
    const targetingService = {};

    service = new BrowsingSessionService(
      prisma as never,
      sessionsService as never,
      browser as never,
      configService as never,
      sseService as never,
      rateLimitService as never,
      xEngager as never,
      threadsEngager as never,
      facebookEngager as never,
      humanBehaviorEngine as never,
      targetingService as never,
      undefined,
    );
  });

  it('BSS-001: closes the page on a successful session', async () => {
    mockInvoke.mockResolvedValue({ postsProcessed: 3, results: [] });

    await service.runBrowsingSession(SocialNetwork.X, 60);

    expect(mockPage.close).toHaveBeenCalledTimes(1);
    expect(browser.releaseContext).toHaveBeenCalledWith(SocialNetwork.X, mockContext);
  });

  it('BSS-002: still closes the page when the engagement graph throws (regression: page leak on failure)', async () => {
    mockInvoke.mockRejectedValue(new Error('selector drift'));

    await expect(service.runBrowsingSession(SocialNetwork.X, 60)).rejects.toThrow('selector drift');

    expect(mockPage.close).toHaveBeenCalledTimes(1);
    expect(browser.releaseContext).toHaveBeenCalledWith(SocialNetwork.X, mockContext);
  });

  it('BSS-003: a page.close() failure does not prevent the context from being released', async () => {
    mockInvoke.mockResolvedValue({ postsProcessed: 0, results: [] });
    mockPage.close.mockRejectedValue(new Error('already closed'));

    await service.runBrowsingSession(SocialNetwork.X, 60);

    expect(browser.releaseContext).toHaveBeenCalledWith(SocialNetwork.X, mockContext);
  });
});
