/**
 * MOD-03: Posting Engine Module — PostingService unit tests.
 *
 * Traces to: REQ-016..022, REQ-NF-002, REQ-NF-003
 * Hazards: HAZ-005, HAZ-006, HAZ-007, HAZ-008, HAZ-017
 *
 * Source: packages/backend/src/modules/posting/posting.service.ts
 * Spec:   features/spa/v-model/unit-test/unit-test-cases.md (UTC-042..059)
 *
 * Mocked dependencies:
 *   - IBrowserPort (createContext, saveStorageState, randomDelay)
 *   - AccountsService (findByNetwork)
 *   - SessionsService (getOrCreateSession, updateStorageState)
 *   - PostsService (findById, updateStatus, findMany)
 *   - RateLimitService (checkRateLimit, recordPost)
 *   - SseService (publish)
 *   - XPoster / ThreadsPoster / FacebookPoster (post)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PostStatus, SocialNetwork } from '@prisma/client';

import { PostingService } from '../../../src/modules/posting/posting.service';
import {
  createMockBrowserPort,
  createMockRateLimitService,
  createMockSseService,
} from '../../mocks/index';

// ── Mock Factories ───────────────────────────────────────────────────────────

function createMockPostsService() {
  return {
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    findMany: vi.fn(),
    findDrafts: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findBySourceAndNetwork: vi.fn().mockResolvedValue([]),
  };
}

function createMockSessionsService() {
  return {
    getOrCreateSession: vi.fn(),
    updateStorageState: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockWarmupService() {
  return {
    canPost: vi.fn().mockResolvedValue(true),
    getWarmupStatus: vi.fn().mockResolvedValue(null),
    startWarmup: vi.fn().mockResolvedValue(undefined),
    completeWarmup: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAccountsService() {
  return {
    findByNetwork: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    seedFromEnv: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn(),
  };
}

function createMockPoster() {
  return {
    post: vi.fn(),
  };
}

/** A mock BrowserContext with close + newPage spies. */
function createMockContext() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn(),
      url: vi.fn().mockReturnValue('https://example.com'),
      locator: vi.fn(),
      close: vi.fn(),
      keyboard: { type: vi.fn() },
    }),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APPROVED_POST_X = {
  id: 'post-1',
  network: SocialNetwork.X,
  content: 'Mercury retrograde is coming! ♋',
  status: PostStatus.APPROVED,
  postUrl: null,
  errorMessage: null,
};

const ACTIVE_SESSION = {
  id: 'sess-001',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'auth', value: 'token' }], origins: [] },
  status: 'ACTIVE',
};

// ── Test Context Type ────────────────────────────────────────────────────────

interface TestContext {
  service: PostingService;
  browser: ReturnType<typeof createMockBrowserPort>;
  postsService: ReturnType<typeof createMockPostsService>;
  sessionsService: ReturnType<typeof createMockSessionsService>;
  warmupService: ReturnType<typeof createMockWarmupService>;
  accountsService: ReturnType<typeof createMockAccountsService>;
  rateLimitService: ReturnType<typeof createMockRateLimitService>;
  sseService: ReturnType<typeof createMockSseService>;
  xPoster: ReturnType<typeof createMockPoster>;
  threadsPoster: ReturnType<typeof createMockPoster>;
  facebookPoster: ReturnType<typeof createMockPoster>;
}

function buildContext(): TestContext {
  const browser = createMockBrowserPort();
  const postsService = createMockPostsService();
  const sessionsService = createMockSessionsService();
  const warmupService = createMockWarmupService();
  const accountsService = createMockAccountsService();
  const rateLimitService = createMockRateLimitService();
  const sseService = createMockSseService();
  const xPoster = createMockPoster();
  const threadsPoster = createMockPoster();
  const facebookPoster = createMockPoster();

  // Override checkRateLimit to return { allowed: true } by default
  // (the shared mock returns undefined which doesn't match the service contract)
  rateLimitService.checkRateLimit = vi.fn().mockResolvedValue({ allowed: true });

  const service = new PostingService(
    browser as any,
    accountsService as any,
    sessionsService as any,
    warmupService as any,
    postsService as any,
    rateLimitService as any,
    sseService as any,
    xPoster as any,
    threadsPoster as any,
    facebookPoster as any,
  );

  return {
    service,
    browser,
    postsService,
    sessionsService,
    warmupService,
    accountsService,
    rateLimitService,
    sseService,
    xPoster,
    threadsPoster,
    facebookPoster,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MOD-03: PostingService', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = buildContext();
  });

  // ── postById() — Idempotency ───────────────────────────────────────────────

  it('UTC-042: postById() returns success with url when post already POSTED (idempotency)', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-1',
      status: PostStatus.POSTED,
      postUrl: 'https://x.com/user/status/123',
    });

    const result = await ctx.service.postById('post-1');

    expect(result).toEqual({ success: true, url: 'https://x.com/user/status/123' });
    // No rate limit check, no browser, no SSE
    expect(ctx.rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.browser.createContext).not.toHaveBeenCalled();
    expect(ctx.sseService.publish).not.toHaveBeenCalled();
  });

  it('UTC-043: postById() returns failure when post already POSTING (idempotency)', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-2',
      status: PostStatus.POSTING,
    });

    const result = await ctx.service.postById('post-2');

    expect(result.success).toBe(false);
    expect(result.error).toContain('already being posted');
    // No further processing
    expect(ctx.rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.browser.createContext).not.toHaveBeenCalled();
  });

  it('UTC-044: postById() throws NotFoundException when post status is not APPROVED', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-3',
      status: PostStatus.DRAFT,
      network: SocialNetwork.X,
    });

    await expect(ctx.service.postById('post-3')).rejects.toThrow(NotFoundException);
    await expect(ctx.service.postById('post-3')).rejects.toThrow('not approved');
  });

  // ── postById() — Rate Limiting ─────────────────────────────────────────────

  it('UTC-045: postById() throws Error when rate limit exceeded (BullMQ retry trigger)', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-4',
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.rateLimitService.checkRateLimit.mockResolvedValue({
      allowed: false,
      reason: 'Daily limit reached',
    });

    await expect(ctx.service.postById('post-4')).rejects.toThrow('Rate limited: Daily limit reached');
    // updateStatus NOT called (deferred, not started)
    expect(ctx.postsService.updateStatus).not.toHaveBeenCalled();
  });

  // ── postById() — POSTING status + SSE event ────────────────────────────────

  it('UTC-046: postById() marks POSTING and emits SSE POSTING event before browser automation', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-5',
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });

    await ctx.service.postById('post-5');

    // updateStatus called with POSTING
    const postingCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.POSTING,
    );
    expect(postingCall).toBeDefined();
    expect(postingCall[0]).toBe('post-5');

    // SSE publish called with POSTING event
    const postingEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'POSTING',
    );
    expect(postingEvent).toBeDefined();
    expect(postingEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-5',
      status: 'POSTING',
      network: 'X',
    });
  });

  // ── postById() — Network Routing ───────────────────────────────────────────

  it('UTC-047: postById() posts to X via XPoster when network is X', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-x',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });

    await ctx.service.postById('post-x');

    expect(ctx.xPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.threadsPoster.post).not.toHaveBeenCalled();
    expect(ctx.facebookPoster.post).not.toHaveBeenCalled();
  });

  it('UTC-048: postById() posts to Threads via ThreadsPoster when network is THREADS', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-t',
      network: SocialNetwork.THREADS,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.threadsPoster.post.mockResolvedValue({ url: 'https://www.threads.com/@user/post/abc' });

    await ctx.service.postById('post-t');

    expect(ctx.threadsPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    expect(ctx.facebookPoster.post).not.toHaveBeenCalled();
  });

  it('UTC-049: postById() posts to Facebook via FacebookPoster when network is FACEBOOK', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-f',
      network: SocialNetwork.FACEBOOK,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.facebookPoster.post.mockResolvedValue({ url: 'https://www.facebook.com/page/posts/123' });

    await ctx.service.postById('post-f');

    expect(ctx.facebookPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    expect(ctx.threadsPoster.post).not.toHaveBeenCalled();
  });

  it('UTC-050: postById() throws Error for unknown network (caught → FAILED)', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-unknown',
      network: 'UNKNOWN' as SocialNetwork,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    const result = await ctx.service.postById('post-unknown');

    // The throw in the switch default is caught by the catch block
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown network');

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();

    // SSE FAILED event emitted
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
  });

  // ── postById() — Success Path ──────────────────────────────────────────────

  it('UTC-051: postById() on success updates POSTED, records rate, emits SSE POSTED with url', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-success',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });

    const result = await ctx.service.postById('post-success');

    // Returns success
    expect(result).toEqual({ success: true, url: 'https://x.com/user/status/123' });

    // updateStatus called with POSTED + postUrl
    const postedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.POSTED,
    );
    expect(postedCall).toBeDefined();
    expect(postedCall[0]).toBe('post-success');
    expect(postedCall[1].postUrl).toBe('https://x.com/user/status/123');

    // rateLimitService.recordPost called
    expect(ctx.rateLimitService.recordPost).toHaveBeenCalledWith('X');

    // SSE POSTED event with url
    const postedEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'POSTED',
    );
    expect(postedEvent).toBeDefined();
    expect(postedEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-success',
      status: 'POSTED',
      network: 'X',
      url: 'https://x.com/user/status/123',
    });
  });

  // ── postById() — Poster Error (result.error) ───────────────────────────────

  it('UTC-052: postById() on poster error (result.error) updates FAILED, emits SSE FAILED, no rate record', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-err',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ error: 'navigation timeout' });

    const result = await ctx.service.postById('post-err');

    expect(result).toEqual({ success: false, error: 'navigation timeout' });

    // updateStatus called with FAILED + errorMessage
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe('navigation timeout');

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0]).toMatchObject({
      type: 'post_status',
      postId: 'post-err',
      status: 'FAILED',
      error: 'navigation timeout',
    });

    // recordPost NOT called (only on success)
    expect(ctx.rateLimitService.recordPost).not.toHaveBeenCalled();
  });

  // ── postById() — Exception (session null) ──────────────────────────────────

  it('UTC-053: postById() on exception (session null) catches, updates FAILED, emits SSE FAILED', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-nosession',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(null);

    const result = await ctx.service.postById('post-nosession');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No active session');

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0].error).toContain('No active session');

    // recordPost NOT called
    expect(ctx.rateLimitService.recordPost).not.toHaveBeenCalled();
  });

  // ── postById() — Session State Saving ──────────────────────────────────────

  it('UTC-054: postById() saves updated storageState and closes context after posting', async () => {
    const mockContext = createMockContext();
    ctx.browser.createContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-save',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });

    await ctx.service.postById('post-save');

    // browser.saveStorageState called with context
    expect(ctx.browser.saveStorageState).toHaveBeenCalledWith(mockContext);

    // sessionsService.updateStorageState called with session.id and state
    expect(ctx.sessionsService.updateStorageState).toHaveBeenCalledWith(
      ACTIVE_SESSION.id,
      '{"cookies":[]}',
    );

    // context.close called
    expect(mockContext.close).toHaveBeenCalledTimes(1);
  });

  // ── postById() — Catch Block (browser crash) ───────────────────────────────

  it('UTC-055: postById() catches any thrown error in try block, sets FAILED, emits SSE, returns failure', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-crash',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.browser.createContext.mockRejectedValue(new Error('browser crash'));

    const result = await ctx.service.postById('post-crash');

    expect(result).toEqual({ success: false, error: 'browser crash' });

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: any[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe('browser crash');

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: any[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0].error).toBe('browser crash');
  });

  // ── postAllApproved() — Batch Mode ─────────────────────────────────────────

  it('UTC-056: postAllApproved() fetches approved posts and calls postById for each with delays', async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: 'p1' },
        { ...APPROVED_POST_X, id: 'p2' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    // Spy on postById to avoid full pipeline
    const postByIdSpy = vi.spyOn(ctx.service, 'postById');
    postByIdSpy.mockResolvedValue({ success: true });

    const result = await ctx.service.postAllApproved();

    // findMany called with correct params
    const findManyArg = ctx.postsService.findMany.mock.calls[0][0];
    expect(findManyArg).toEqual({
      status: PostStatus.APPROVED,
      limit: 50,
      offset: 0,
    });

    // postById called twice
    expect(postByIdSpy).toHaveBeenCalledTimes(2);
    expect(postByIdSpy).toHaveBeenCalledWith('p1');
    expect(postByIdSpy).toHaveBeenCalledWith('p2');

    // randomDelay called between posts
    expect(ctx.browser.randomDelay).toHaveBeenCalled();

    // Returns correct counts (D1: now includes skipped)
    expect(result).toEqual({ posted: 2, failed: 0, skipped: 0 });
  });

  it('UTC-057: postAllApproved() counts failures correctly when postById returns failure', async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: 'p1' },
        { ...APPROVED_POST_X, id: 'p2' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    const postByIdSpy = vi.spyOn(ctx.service, 'postById');
    postByIdSpy.mockResolvedValue({ success: true });
    postByIdSpy.mockResolvedValueOnce({ success: false, error: 'err' });

    const result = await ctx.service.postAllApproved();

    expect(result).toEqual({ posted: 1, failed: 1, skipped: 0 });
  });

  it('UTC-058: postAllApproved() returns {posted:0, failed:0, skipped:0} when no approved posts', async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [],
      total: 0,
      limit: 50,
      offset: 0,
    });

    const postByIdSpy = vi.spyOn(ctx.service, 'postById');

    const result = await ctx.service.postAllApproved();

    expect(result).toEqual({ posted: 0, failed: 0, skipped: 0 });
    // postById NOT called
    expect(postByIdSpy).not.toHaveBeenCalled();
    // randomDelay NOT called
    expect(ctx.browser.randomDelay).not.toHaveBeenCalled();
  });

  it('UTC-059: postAllApproved() applies human-like delay (10000-30000ms) between posts', async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: 'p1' },
        { ...APPROVED_POST_X, id: 'p2' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    vi.spyOn(ctx.service, 'postById').mockResolvedValue({ success: true });

    await ctx.service.postAllApproved();

    // randomDelay called with (10000, 30000)
    const delayCalls = ctx.browser.randomDelay.mock.calls.filter(
      (c: any[]) => c[0] === 10000 && c[1] === 30000,
    );
    expect(delayCalls.length).toBeGreaterThan(0);
    expect(delayCalls[0]).toEqual([10000, 30000]);
  });
});
