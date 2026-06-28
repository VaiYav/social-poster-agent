/**
 * MOD-03: Posting Engine Module — PostingService unit tests.
 *
 * Traces to: REQ-016..022, REQ-NF-002, REQ-NF-003
 * Hazards: HAZ-005, HAZ-006, HAZ-007, HAZ-008, HAZ-017
 *
 * Source: packages/backend/src/modules/posting/posting.service.ts
 * Spec:   CONSTITUTION.md §14 (Testing) — test case IDs are inline (UTC-042..059)
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
  createMockThreadProgressService,
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
    findThreadContinuations: vi.fn().mockResolvedValue([]),
  };
}

function createMockSessionsService() {
  return {
    getOrCreateSession: vi.fn(),
    updateStorageState: vi.fn().mockResolvedValue(undefined),
    markSessionExpired: vi.fn().mockResolvedValue(undefined),
    // P0-H3: decryptStorageState — mirrors SessionsService behavior for tests.
    // Passthrough: if raw is a string, return as-is; if object, JSON.stringify.
    decryptStorageState: vi.fn((session: { storageState: unknown }) => {
      const raw = session.storageState;
      if (typeof raw === 'string') return raw;
      return JSON.stringify(raw);
    }),
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
  threadProgressService: ReturnType<typeof createMockThreadProgressService>;
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
  const threadProgressService = createMockThreadProgressService();
  const xPoster = createMockPoster();
  const threadsPoster = createMockPoster();
  const facebookPoster = createMockPoster();

  // Override checkRateLimit to return { allowed: true } by default
  // (the shared mock returns undefined which doesn't match the service contract)
  rateLimitService.checkRateLimit = vi.fn().mockResolvedValue({ allowed: true });

  const service = new PostingService(
    browser as unknown,
    accountsService as unknown,
    sessionsService as unknown,
    warmupService as unknown,
    postsService as unknown,
    rateLimitService as unknown,
    sseService as unknown,
    threadProgressService as unknown,
    xPoster as unknown,
    threadsPoster as unknown,
    facebookPoster as unknown,
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
    threadProgressService,
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
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
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
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
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
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
      (c: unknown[]) => c[1]?.status === PostStatus.POSTING,
    );
    expect(postingCall).toBeDefined();
    expect(postingCall[0]).toBe('post-5');

    // SSE publish called with POSTING event
    const postingEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'POSTING',
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

  it('M1-P3: self-recovery does NOT re-post when the original attempt already published (dup guard)', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-dup',
      network: SocialNetwork.X,
    });
    // 1st session resolve → active; recovery resolve → a *fresh* session (different id).
    ctx.sessionsService.getOrCreateSession
      .mockResolvedValueOnce(ACTIVE_SESSION)
      .mockResolvedValueOnce({ ...ACTIVE_SESSION, id: 'sess-fresh' });
    // The post attempt reports a session-expired error → triggers self-recovery…
    ctx.xPoster.post.mockResolvedValue({ error: 'Not logged in — session expired, relogin needed' });
    // …but verification finds the post is already live → must NOT re-post (avoid duplicate).
    ctx.xPoster.verifyPosted = vi.fn().mockResolvedValue('https://x.com/user/status/999');

    const result = await ctx.service.postById('post-dup');

    expect(ctx.xPoster.verifyPosted).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).toHaveBeenCalledTimes(1); // no duplicate re-post
    expect(result).toEqual({ success: true, url: 'https://x.com/user/status/999' });
    const postedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: PostStatus })?.status === PostStatus.POSTED,
    );
    expect(postedCall).toBeDefined();
    expect((postedCall![1] as { postUrl?: string }).postUrl).toBe('https://x.com/user/status/999');
  });

  it('UTC-047: postById() posts to X via XPoster when network is X', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();

    // SSE FAILED event emitted
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
  });

  // ── postById() — Success Path ──────────────────────────────────────────────

  it('UTC-051: postById() on success updates POSTED, records rate, emits SSE POSTED with url', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
      (c: unknown[]) => c[1]?.status === PostStatus.POSTED,
    );
    expect(postedCall).toBeDefined();
    expect(postedCall[0]).toBe('post-success');
    expect(postedCall[1].postUrl).toBe('https://x.com/user/status/123');

    // rateLimitService.recordPost called
    expect(ctx.rateLimitService.recordPost).toHaveBeenCalledWith('X');

    // SSE POSTED event with url
    const postedEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'POSTED',
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
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe('navigation timeout');

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'FAILED',
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
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'FAILED',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[0].error).toContain('No active session');

    // recordPost NOT called
    expect(ctx.rateLimitService.recordPost).not.toHaveBeenCalled();
  });

  // ── postById() — Session State Saving ──────────────────────────────────────

  it('UTC-054: postById() saves updated storageState and closes context after posting', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
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

    // releaseContext called (Sprint K: context pool replaces context.close)
    expect(ctx.browser.releaseContext).toHaveBeenCalledTimes(1);
  });

  // ── postById() — Catch Block (browser crash) ───────────────────────────────

  it('UTC-055: postById() catches any thrown error in try block, sets FAILED, emits SSE, returns failure', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-crash',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.browser.acquireContext.mockRejectedValue(new Error('browser crash'));

    const result = await ctx.service.postById('post-crash');

    expect(result).toEqual({ success: false, error: 'browser crash' });

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe('browser crash');

    // SSE FAILED event
    const failedEvent = ctx.sseService.publish.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'FAILED',
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
      (c: unknown[]) => c[0] === 10000 && c[1] === 30000,
    );
    expect(delayCalls.length).toBeGreaterThan(0);
    expect(delayCalls[0]).toEqual([10000, 30000]);
  });

  // ── P0-H3: Encryption passthrough round-trip ──────────────────────────────

  it('UTC-075: postById() correctly handles passthrough string storageState (no double-encoding)', async () => {
    // Simulate what real Prisma returns when encrypt() stored a JSON string
    // in a Json column: the value comes back as a JavaScript string.
    const passthroughSession = {
      ...ACTIVE_SESSION,
      storageState: '{"cookies":[{"name":"auth","value":"token"}],"origins":[]}',
    };
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-enc-1',
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(passthroughSession);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });

    await ctx.service.postById('post-enc-1');

    // acquireContext should receive the raw JSON string, NOT double-encoded
    expect(ctx.browser.acquireContext).toHaveBeenCalledWith(
      SocialNetwork.X,
      '{"cookies":[{"name":"auth","value":"token"}],"origins":[]}',
    );
  });

  // ── F2: Multi-Stage Delayed Scheduling ─────────────────────────────────────

  it('F2-001: scheduleMultiStagePosting() throws if post is not a thread root', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      threadId: null,
      threadPosition: 0,
    });
    await expect(ctx.service.scheduleMultiStagePosting('post-not-root')).rejects.toThrow(
      'not a thread root',
    );
  });

  it('F2-002: scheduleMultiStagePosting() falls back to immediate postById when no QueueFactory', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-root',
      threadId: 'thread-1',
      threadPosition: 0,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/123' });
    ctx.postsService.findThreadContinuations.mockResolvedValue([]);

    const result = await ctx.service.scheduleMultiStagePosting('post-root');
    expect(result.immediate).toBe(true);
    expect(result.scheduled).toBe(0);
  });

  // ── P0-H2: Thread with continuations ───────────────────────────────────────

  it('UTC-076: postById() thread root with 3 continuations — loads continuations, posts root + replies, tracks via ThreadProgressService', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-thread-root',
      threadId: 'thread-xyz',
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    // 3 continuation posts
    const continuations = [
      { id: 'reply-1', content: 'Reply 1', threadPosition: 1, status: PostStatus.APPROVED },
      { id: 'reply-2', content: 'Reply 2', threadPosition: 2, status: PostStatus.APPROVED },
      { id: 'reply-3', content: 'Reply 3', threadPosition: 3, status: PostStatus.APPROVED },
    ];
    ctx.postsService.findThreadContinuations.mockResolvedValue(continuations);

    // Poster returns URL + all replies succeeded
    ctx.xPoster.post.mockResolvedValue({
      url: 'https://x.com/user/status/123',
      threadReplyResults: [
        { index: 0, success: true },
        { index: 1, success: true },
        { index: 2, success: true },
      ],
    });

    const result = await ctx.service.postById('post-thread-root');

    // Success
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://x.com/user/status/123');

    // findThreadContinuations called for thread root
    expect(ctx.postsService.findThreadContinuations).toHaveBeenCalledWith('thread-xyz');

    // ThreadProgressService.initThread called with root post ID and all replies
    expect(ctx.threadProgressService.initThread).toHaveBeenCalledWith(
      'post-thread-root',
      [
        { id: 'reply-1', threadPosition: 1 },
        { id: 'reply-2', threadPosition: 2 },
        { id: 'reply-3', threadPosition: 3 },
      ],
    );

    // Each reply marked as POSTED via ThreadProgressService
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledTimes(3);
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledWith(
      'post-thread-root',
      'reply-1',
      'https://x.com/user/status/123',
    );

    // Each reply also gets updateStatus POSTED
    const replyPostedCalls = ctx.postsService.updateStatus.mock.calls.filter(
      (c: unknown[]) => c[1]?.status === PostStatus.POSTED && c[0] !== 'post-thread-root',
    );
    expect(replyPostedCalls).toHaveLength(3);

    // SSE POSTED events for root + 3 replies
    const postedEvents = ctx.sseService.publish.mock.calls.filter(
      (c: unknown[]) => c[0]?.status === 'POSTED',
    );
    expect(postedEvents.length).toBeGreaterThanOrEqual(4);
  });

  it('UTC-077: postById() thread partial failure — reply 1 POSTED, reply 2 FAILED → only reply 2 retried on resume', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-thread-partial',
      threadId: 'thread-partial',
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    const continuations = [
      { id: 'reply-1', content: 'Reply 1', threadPosition: 1, status: PostStatus.APPROVED },
      { id: 'reply-2', content: 'Reply 2', threadPosition: 2, status: PostStatus.APPROVED },
    ];
    ctx.postsService.findThreadContinuations.mockResolvedValue(continuations);

    // Poster returns URL + reply 1 succeeded, reply 2 failed
    ctx.xPoster.post.mockResolvedValue({
      url: 'https://x.com/user/status/456',
      threadReplyResults: [
        { index: 0, success: true },
        { index: 1, success: false, error: 'Reply button not found' },
      ],
    });

    const result = await ctx.service.postById('post-thread-partial');

    // Root post still succeeds
    expect(result.success).toBe(true);

    // Reply 1 marked POSTED
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledWith(
      'post-thread-partial',
      'reply-1',
      'https://x.com/user/status/456',
    );

    // Reply 2 marked FAILED
    expect(ctx.threadProgressService.markReplyFailed).toHaveBeenCalledWith(
      'post-thread-partial',
      'reply-2',
      'Reply button not found',
    );

    // Reply 2 updateStatus called with FAILED
    const replyFailedCalls = ctx.postsService.updateStatus.mock.calls.filter(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED && c[0] === 'reply-2',
    );
    expect(replyFailedCalls).toHaveLength(1);
    expect(replyFailedCalls[0][1].errorMessage).toBe('Reply button not found');
  });

  // ── Self-recovery on session expiry ────────────────────────────────────────

  it('UTC-078: postById() self-recovery — poster returns session_expired → getOrCreateSession → retry post', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-recovery',
      network: SocialNetwork.X,
    });

    // First session (expired), second session (fresh)
    const expiredSession = { ...ACTIVE_SESSION, id: 'sess-old' };
    const freshSession = { ...ACTIVE_SESSION, id: 'sess-new' };
    ctx.sessionsService.getOrCreateSession
      .mockResolvedValueOnce(expiredSession)
      .mockResolvedValueOnce(freshSession);

    // First post attempt returns session expired error
    ctx.xPoster.post
      .mockResolvedValueOnce({ error: 'Not logged in — session expired, relogin needed' })
      .mockResolvedValueOnce({ url: 'https://x.com/user/status/789' });

    const result = await ctx.service.postById('post-recovery');

    // Recovery succeeded
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://x.com/user/status/789');

    // getOrCreateSession called twice (original + recovery)
    expect(ctx.sessionsService.getOrCreateSession).toHaveBeenCalledTimes(2);

    // markSessionExpired called for the old session
    expect(ctx.sessionsService.markSessionExpired).toHaveBeenCalledWith(
      SocialNetwork.X,
      'sess-old',
    );

    // Poster called twice (original failed + retry succeeded)
    expect(ctx.xPoster.post).toHaveBeenCalledTimes(2);
  });

  // ── Warmup check defers ────────────────────────────────────────────────────

  it('UTC-079: postById() warmup check defers — canPost=false → throw Error (deferred)', async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-warmup',
      network: SocialNetwork.X,
    });
    ctx.warmupService.canPost.mockResolvedValue(false);

    await expect(ctx.service.postById('post-warmup')).rejects.toThrow('warm-up');

    // No posting attempted
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    // No SSE events
    expect(ctx.sseService.publish).not.toHaveBeenCalled();
  });

  // ── Post not found ─────────────────────────────────────────────────────────

  it('UTC-080: postById() throws NotFoundException when post not found (findById returns null)', async () => {
    ctx.postsService.findById.mockResolvedValue(null);

    await expect(ctx.service.postById('nonexistent-post')).rejects.toThrow();
    // Should not attempt any posting
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
  });

  // ── SSE events at correct stages ───────────────────────────────────────────

  it('UTC-081: postById() publishes SSE events POSTING_STARTED, POSTED at correct stages', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-sse',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/sse' });

    await ctx.service.postById('post-sse');

    // SSE events published in order: POSTING → POSTED
    const events = ctx.sseService.publish.mock.calls.map((c: unknown[]) => c[0]);
    const statuses = events.map((e: any) => e.status);

    // POSTING event comes before POSTED event
    const postingIdx = statuses.indexOf('POSTING');
    const postedIdx = statuses.indexOf('POSTED');
    expect(postingIdx).toBeGreaterThanOrEqual(0);
    expect(postedIdx).toBeGreaterThan(postingIdx);

    // POSTING event has correct fields
    expect(events[postingIdx]).toMatchObject({
      type: 'post_status',
      postId: 'post-sse',
      status: 'POSTING',
      network: 'X',
    });

    // POSTED event has correct fields
    expect(events[postedIdx]).toMatchObject({
      type: 'post_status',
      postId: 'post-sse',
      status: 'POSTED',
      network: 'X',
      url: 'https://x.com/user/status/sse',
    });
  });

  it('UTC-082: postById() publishes SSE FAILED event when poster returns error', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-sse-fail',
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ error: 'compose dialog failed' });

    await ctx.service.postById('post-sse-fail');

    // SSE events: POSTING → FAILED
    const events = ctx.sseService.publish.mock.calls.map((c: unknown[]) => c[0]);
    const statuses = events.map((e: any) => e.status);

    const postingIdx = statuses.indexOf('POSTING');
    const failedIdx = statuses.indexOf('FAILED');
    expect(postingIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(postingIdx);

    // FAILED event has error field
    expect(events[failedIdx]).toMatchObject({
      type: 'post_status',
      postId: 'post-sse-fail',
      status: 'FAILED',
      error: 'compose dialog failed',
    });
  });

  // ── Thread continuation loading ────────────────────────────────────────────

  it('UTC-083: postById() calls findThreadContinuations for thread root posts (threadPosition=0)', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-thread-load',
      threadId: 'thread-load-test',
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/load' });
    ctx.postsService.findThreadContinuations.mockResolvedValue([]);

    await ctx.service.postById('post-thread-load');

    // findThreadContinuations called with the threadId
    expect(ctx.postsService.findThreadContinuations).toHaveBeenCalledWith('thread-load-test');
  });

  it('UTC-084: postById() does NOT call findThreadContinuations for non-thread posts (threadId=null)', async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: 'post-no-thread',
      threadId: null,
      threadPosition: null,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: 'https://x.com/user/status/nothread' });

    await ctx.service.postById('post-no-thread');

    // findThreadContinuations NOT called (no threadId)
    expect(ctx.postsService.findThreadContinuations).not.toHaveBeenCalled();
  });
});
