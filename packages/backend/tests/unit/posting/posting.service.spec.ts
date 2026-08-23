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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { PostStatus, SocialNetwork, ContentType } from "../../../src/generated/prisma/client.js";
import type { ModuleRef } from "@nestjs/core";

import { PostingService } from "../../../src/modules/posting/posting.service.js";
import { PostingGuardChain } from "../../../src/modules/posting/posting-guards.service.js";
import { PostingDispatcher } from "../../../src/modules/posting/poster-registry.service.js";
import { PostVerificationService } from "../../../src/modules/posting/post-verification.service.js";
import { ThreadOrchestrator } from "../../../src/modules/posting/thread-posting.service.js";
import { PostSideEffectsService } from "../../../src/modules/posting/post-side-effects.service.js";
import { CtaAttributionService } from "../../../src/modules/posting/cta-attribution.service.js";
import { PostEvents } from "../../../src/events/enums/post-events.enum.js";
import {
  createMockBrowserPort,
  createMockRateLimitService,
  createMockEventEmitter,
  createMockThreadProgressService,
  createMockConfigService,
} from "../../mocks/index.js";

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
    findThreadRoot: vi.fn().mockResolvedValue(null),
    findByThreadPosition: vi.fn().mockResolvedValue(null),
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
      if (typeof raw === "string") return raw;
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
    findFirstActiveByNetwork: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    seedFromEnv: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn(),
  };
}

function createMockPoster() {
  return {
    post: vi.fn(),
    postThreadReply: vi.fn(),
  };
}

function createMockTelegramAdapter() {
  return {
    postMessage: vi.fn(),
  };
}

function createMockQueueFactory() {
  return {
    enqueuePosting: vi.fn().mockResolvedValue(undefined),
    getQueue: vi.fn(),
  };
}

/** A mock BrowserContext with close + newPage spies. */
function createMockContext() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://example.com"),
      locator: vi.fn(),
      close: vi.fn(),
      keyboard: { type: vi.fn() },
    }),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APPROVED_POST_X = {
  id: "post-1",
  accountId: "acc-001",
  network: SocialNetwork.X,
  content: "Workflow trends are here! 🎯",
  contentType: ContentType.SOCIAL_POST,
  status: PostStatus.APPROVED,
  postUrl: null,
  errorMessage: null,
};

const ACTIVE_SESSION = {
  id: "sess-001",
  accountId: "acc-001",
  storageState: { cookies: [{ name: "auth", value: "token" }], origins: [] },
  status: "ACTIVE",
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
  eventEmitter: ReturnType<typeof createMockEventEmitter>;
  threadProgressService: ReturnType<typeof createMockThreadProgressService>;
  xPoster: ReturnType<typeof createMockPoster>;
  threadsPoster: ReturnType<typeof createMockPoster>;
  facebookPoster: ReturnType<typeof createMockPoster>;
  blueskyPoster: ReturnType<typeof createMockPoster>;
  mastodonPoster: ReturnType<typeof createMockPoster>;
  linkedinSocialPoster: ReturnType<typeof createMockPoster>;
  telegramAdapter: ReturnType<typeof createMockTelegramAdapter>;
  configService: ReturnType<typeof createMockConfigService>;
  queueFactory?: ReturnType<typeof createMockQueueFactory>;
  devtoPoster: { postArticle: ReturnType<typeof vi.fn>; verifyPosted: ReturnType<typeof vi.fn> };
}

function buildContext(
  queueFactory: ReturnType<typeof createMockQueueFactory> | null = createMockQueueFactory(),
): TestContext {
  const browser = createMockBrowserPort();
  const postsService = createMockPostsService();
  const sessionsService = createMockSessionsService();
  const warmupService = createMockWarmupService();
  const accountsService = createMockAccountsService();
  const rateLimitService = createMockRateLimitService();
  const eventEmitter = createMockEventEmitter();
  const threadProgressService = createMockThreadProgressService();
  const xPoster = createMockPoster();
  const threadsPoster = createMockPoster();
  const facebookPoster = createMockPoster();
  const blueskyPoster = createMockPoster();
  const mastodonPoster = createMockPoster();
  const linkedinSocialPoster = createMockPoster();
  const telegramAdapter = createMockTelegramAdapter();
  const configService = createMockConfigService({
    BLUESKY_TRANSPORT: "browser",
    MASTODON_TRANSPORT: "browser",
  });

  // P1-10: syndication article poster resolved lazily via ModuleRef
  const devtoPoster = {
    postArticle: vi.fn(),
    verifyPosted: vi.fn(),
  };
  const hashnodePoster = {
    postArticle: vi.fn(),
    verifyPosted: vi.fn(),
  };
  const linkedinArticlePoster = {
    postArticle: vi.fn(),
    verifyPosted: vi.fn(),
  };
  const moduleRef = {
    get: vi.fn((token: unknown) => {
      if (token?.name === "DevtoPoster") return devtoPoster;
      if (token?.name === "HashnodePoster") return hashnodePoster;
      if (token?.name === "LinkedinPoster") return linkedinArticlePoster;
      return undefined;
    }),
  } as unknown as ModuleRef;

  // Override checkRateLimit to return { allowed: true } by default
  // (the shared mock returns undefined which doesn't match the service contract)
  rateLimitService.checkRateLimit = vi.fn().mockResolvedValue({ allowed: true });

  const guards = new PostingGuardChain(
    postsService as never,
    rateLimitService as never,
    warmupService as never,
  );
  const posterRegistry = new PostingDispatcher(
    xPoster as never,
    threadsPoster as never,
    facebookPoster as never,
    configService as never,
    moduleRef,
    blueskyPoster as never,
    mastodonPoster as never,
    linkedinSocialPoster as never,
    telegramAdapter as never,
  );
  const sideEffects = new PostSideEffectsService();
  const ctaAttribution = new CtaAttributionService(posterRegistry);
  const verification = new PostVerificationService(
    postsService as never,
    sessionsService as never,
    posterRegistry,
    eventEmitter as never,
    browser as never,
  );
  const threads = new ThreadOrchestrator(
    postsService as never,
    threadProgressService as never,
    posterRegistry,
    sideEffects,
    eventEmitter as never,
    configService as never,
    queueFactory as never,
  );

  const service = new PostingService(
    browser as unknown,
    sessionsService as unknown,
    postsService as unknown,
    rateLimitService as unknown,
    eventEmitter as unknown,
    configService as unknown,
    guards,
    posterRegistry,
    verification,
    threads,
    sideEffects,
    ctaAttribution,
    undefined,
    undefined,
    queueFactory as unknown,
    undefined,
  );

  return {
    service,
    browser,
    postsService,
    sessionsService,
    warmupService,
    accountsService,
    rateLimitService,
    eventEmitter,
    threadProgressService,
    xPoster,
    threadsPoster,
    facebookPoster,
    blueskyPoster,
    mastodonPoster,
    linkedinSocialPoster,
    telegramAdapter,
    configService,
    queueFactory,
    moduleRef,
    devtoPoster,
    hashnodePoster,
    linkedinArticlePoster,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MOD-03: PostingService", () => {
  let ctx: TestContext;

  beforeEach(() => {
    // Enable all networks for tests (production default is X,THREADS only)
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK";
    ctx = buildContext();
  });

  // ── postById() — Idempotency ───────────────────────────────────────────────

  it("UTC-042: postById() returns success with url when post already POSTED (idempotency)", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-1",
      status: PostStatus.POSTED,
      postUrl: "https://x.com/user/status/123",
    });

    const result = await ctx.service.postById("post-1");

    expect(result).toEqual({ success: true, url: "https://x.com/user/status/123" });
    // No rate limit check, no browser session needed for already-verified short-form posts
    expect(ctx.rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
    expect(ctx.eventEmitter.emit).toHaveBeenCalledWith(
      PostEvents.VERIFIED,
      expect.objectContaining({
        postId: "post-1",
        network: "X",
        postUrl: "https://x.com/user/status/123",
      }),
    );
  });

  it("UTC-043: postById() returns failure when post already POSTING (idempotency)", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-2",
      status: PostStatus.POSTING,
    });

    const result = await ctx.service.postById("post-2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already being posted");
    // Not retryable: with concurrency=1 + jobId=postId, this branch is only reached via
    // BullMQ's stalled-job recovery re-dispatching a job whose original worker died
    // mid-post — nothing will ever move the post out of POSTING from outside, so retrying
    // would just burn the full retry budget returning this exact result every time.
    expect(result.retryable).toBe(false);
    // No further processing
    expect(ctx.rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
  });

  it("UTC-044: postById() throws NotFoundException when post status is not APPROVED", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-3",
      status: PostStatus.DRAFT,
      network: SocialNetwork.X,
    });

    await expect(ctx.service.postById("post-3")).rejects.toThrow(NotFoundException);
    await expect(ctx.service.postById("post-3")).rejects.toThrow("not approved");
  });

  it("UTC-044b: postById() returns retryable:false (not a throw) when post is already FAILED", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-3b",
      status: PostStatus.FAILED,
      network: SocialNetwork.X,
    });

    const result = await ctx.service.postById("post-3b");

    expect(result).toEqual({
      success: false,
      error: "Post post-3b is FAILED, not retryable",
      retryable: false,
    });
    expect(ctx.rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
  });

  it("UTC-044c: postById() returns retryable:false when post is already REJECTED", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-3c",
      status: PostStatus.REJECTED,
      network: SocialNetwork.X,
    });

    const result = await ctx.service.postById("post-3c");

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  // ── postById() — Rate Limiting ─────────────────────────────────────────────

  it("UTC-045: postById() returns rate-limit result so BullMQ can trigger a queue delay", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-4",
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.rateLimitService.checkRateLimit.mockResolvedValue({
      allowed: false,
      reason: "Daily limit reached",
    });

    const result = await ctx.service.postById("post-4");
    expect(result.success).toBe(false);
    expect(result.rateLimit).toBe(true);
    expect(result.error).toContain("Daily limit reached");
    // updateStatus NOT called (deferred, not started)
    expect(ctx.postsService.updateStatus).not.toHaveBeenCalled();
  });

  // ── postById() — POSTING status + SSE event ────────────────────────────────

  it("UTC-046: postById() marks POSTING and emits SSE POSTING event before browser automation", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-5",
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    await ctx.service.postById("post-5");

    // updateStatus called with POSTING
    const postingCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.POSTING,
    );
    expect(postingCall).toBeDefined();
    expect(postingCall[0]).toBe("post-5");

    // SSE publish called with POSTING event
    const postingEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.POSTING_STARTED && c[1]?.postId === "post-5",
    );
    expect(postingEvent).toBeDefined();
    expect(postingEvent[1]).toMatchObject({
      postId: "post-5",
      network: "X",
    });
  });

  // ── postById() — Network Routing ───────────────────────────────────────────

  it("M1-P3: self-recovery does NOT re-post when the original attempt already published (dup guard)", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-dup",
      network: SocialNetwork.X,
    });
    // 1st session resolve → active; recovery resolve → a *fresh* session (different id).
    ctx.sessionsService.getOrCreateSession
      .mockResolvedValueOnce(ACTIVE_SESSION)
      .mockResolvedValueOnce({ ...ACTIVE_SESSION, id: "sess-fresh" });
    // The post attempt reports a session-expired error → triggers self-recovery…
    ctx.xPoster.post.mockResolvedValue({
      error: "Not logged in — session expired, relogin needed",
    });
    // …but verification finds the post is already live → must NOT re-post (avoid duplicate).
    ctx.xPoster.verifyPosted = vi.fn().mockResolvedValue("https://x.com/user/status/999");

    const result = await ctx.service.postById("post-dup");

    expect(ctx.xPoster.verifyPosted).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).toHaveBeenCalledTimes(1); // no duplicate re-post
    expect(result).toEqual({ success: true, url: "https://x.com/user/status/999" });
    const postedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: PostStatus })?.status === PostStatus.POSTED,
    );
    expect(postedCall).toBeDefined();
    expect((postedCall![1] as { postUrl?: string }).postUrl).toBe("https://x.com/user/status/999");
  });

  it("H2: pre-retry verify skips a duplicate re-submit when a network error strikes after the post went live", async () => {
    vi.useFakeTimers();
    try {
      const mockContext = createMockContext();
      ctx.browser.acquireContext.mockResolvedValue(mockContext);
      ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
      ctx.postsService.findById.mockResolvedValue({
        ...APPROVED_POST_X,
        id: "post-h2",
        network: SocialNetwork.X,
      });
      ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

      // 1st attempt: post is submitted, then a retryable network error strikes during
      // permalink capture (after submit) → withRetry will retry.
      ctx.xPoster.post.mockRejectedValueOnce(new Error("Navigation Timeout 30000ms exceeded"));
      // On the retry, the profile check finds the post is already live → must NOT re-submit.
      ctx.xPoster.verifyPosted = vi.fn().mockResolvedValue("https://x.com/user/status/777");

      const promise = ctx.service.postById("post-h2");
      await vi.advanceTimersByTimeAsync(60000); // drive the retry backoff
      const result = await promise;

      expect(ctx.xPoster.post).toHaveBeenCalledTimes(1); // only the first (thrown) attempt — no duplicate
      expect(ctx.xPoster.verifyPosted).toHaveBeenCalledTimes(1); // pre-retry verify ran
      expect(result).toEqual({ success: true, url: "https://x.com/user/status/777" });
      const postedCall = ctx.postsService.updateStatus.mock.calls.find(
        (c: unknown[]) => (c[1] as { status?: PostStatus })?.status === PostStatus.POSTED,
      );
      expect((postedCall?.[1] as { postUrl?: string })?.postUrl).toBe(
        "https://x.com/user/status/777",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("H2: when the post is NOT already live, the retry proceeds and re-posts (guard does not block legitimate retries)", async () => {
    vi.useFakeTimers();
    try {
      const mockContext = createMockContext();
      ctx.browser.acquireContext.mockResolvedValue(mockContext);
      ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
      ctx.postsService.findById.mockResolvedValue({
        ...APPROVED_POST_X,
        id: "post-h2b",
        network: SocialNetwork.X,
      });
      ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

      ctx.xPoster.post
        .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"))
        .mockResolvedValueOnce({ url: "https://x.com/user/status/888" });
      ctx.xPoster.verifyPosted = vi.fn().mockResolvedValue(null); // nothing live → retry must re-post

      const promise = ctx.service.postById("post-h2b");
      await vi.advanceTimersByTimeAsync(60000);
      const result = await promise;

      expect(ctx.xPoster.verifyPosted).toHaveBeenCalledTimes(1); // verify attempted before retry
      expect(ctx.xPoster.post).toHaveBeenCalledTimes(2); // re-posted — guard did not block
      expect(result).toEqual({ success: true, url: "https://x.com/user/status/888" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("UTC-047: postById() posts to X via XPoster when network is X", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-x",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    await ctx.service.postById("post-x");

    expect(ctx.xPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.threadsPoster.post).not.toHaveBeenCalled();
    expect(ctx.facebookPoster.post).not.toHaveBeenCalled();
  });

  it("UTC-048: postById() posts to Threads via ThreadsPoster when network is THREADS", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-t",
      network: SocialNetwork.THREADS,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.threadsPoster.post.mockResolvedValue({ url: "https://www.threads.com/@user/post/abc" });

    await ctx.service.postById("post-t");

    expect(ctx.threadsPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    expect(ctx.facebookPoster.post).not.toHaveBeenCalled();
  });

  it("UTC-049: postById() posts to Facebook via FacebookPoster when network is FACEBOOK", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-f",
      network: SocialNetwork.FACEBOOK,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.facebookPoster.post.mockResolvedValue({ url: "https://www.facebook.com/page/posts/123" });

    await ctx.service.postById("post-f");

    expect(ctx.facebookPoster.post).toHaveBeenCalledTimes(1);
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    expect(ctx.threadsPoster.post).not.toHaveBeenCalled();
  });

  it("UTC-050: postById() throws Error for unknown network (caught → FAILED)", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-unknown",
      network: "UNKNOWN" as SocialNetwork,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    const result = await ctx.service.postById("post-unknown");

    // The throw in the switch default is caught by the catch block
    expect(result.success).toBe(false);
    expect(result.error).toContain("not yet implemented for network");

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();

    // SSE FAILED event emitted
    const failedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.FAILED && c[1]?.postId === "post-unknown",
    );
    expect(failedEvent).toBeDefined();
  });

  // ── postById() — Success Path ──────────────────────────────────────────────

  it("UTC-051: postById() on success updates POSTED, records rate, emits SSE POSTED with url", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-success",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    const result = await ctx.service.postById("post-success");

    // Returns success
    expect(result).toEqual({ success: true, url: "https://x.com/user/status/123" });

    // updateStatus called with POSTED + postUrl
    const postedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.POSTED,
    );
    expect(postedCall).toBeDefined();
    expect(postedCall[0]).toBe("post-success");
    expect(postedCall[1].postUrl).toBe("https://x.com/user/status/123");

    // rateLimitService.recordPost called
    expect(ctx.rateLimitService.recordPost).toHaveBeenCalledWith("X", "acc-001");

    // SSE POSTED event with url
    const postedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.POSTED && c[1]?.postId === "post-success",
    );
    expect(postedEvent).toBeDefined();
    expect(postedEvent[1]).toMatchObject({
      postId: "post-success",
      network: "X",
      postUrl: "https://x.com/user/status/123",
    });
  });

  it("P1-04a: postById() on success marks VERIFIED and emits POST_VERIFIED for verifiable networks", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-verified",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    const result = await ctx.service.postById("post-verified");

    expect(result).toEqual({ success: true, url: "https://x.com/user/status/123" });

    // updateStatus called with VERIFIED + postUrl
    const verifiedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[0] === "post-verified" && c[1]?.status === PostStatus.VERIFIED,
    );
    expect(verifiedCall).toBeDefined();
    expect(verifiedCall[1].postUrl).toBe("https://x.com/user/status/123");

    // POST_VERIFIED event emitted after POSTED
    const verifiedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.VERIFIED && c[1]?.postId === "post-verified",
    );
    expect(verifiedEvent).toBeDefined();
    expect(verifiedEvent[1]).toMatchObject({
      postId: "post-verified",
      network: "X",
      postUrl: "https://x.com/user/status/123",
    });
  });

  it("P1-10: postById() posts and verifies a Dev.to article via the article poster", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,DEVTO";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-devto-1",
      network: SocialNetwork.DEVTO,
      contentType: ContentType.ARTICLE,
      content: JSON.stringify({
        title: "Test Dev.to Article",
        bodyMarkdown: "# Hello\n\nThis is a test article.",
        tags: ["test", "spa"],
        slug: "test-devto-article",
        excerpt: "A test article for Dev.to syndication.",
      }),
      canonicalUrl: "https://example.com/blog/test-devto-article",
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.devtoPoster.postArticle.mockResolvedValue({
      success: true,
      url: "https://dev.to/testuser/test-devto-article-123",
      canonicalUrl: "https://example.com/blog/test-devto-article",
    });
    ctx.devtoPoster.verifyPosted.mockResolvedValue(
      "https://dev.to/testuser/test-devto-article-123",
    );

    const result = await ctx.service.postById("post-devto-1");

    expect(result).toEqual({
      success: true,
      url: "https://dev.to/testuser/test-devto-article-123",
    });

    // updateStatus called with VERIFIED + postUrl
    const verifiedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[0] === "post-devto-1" && c[1]?.status === PostStatus.VERIFIED,
    );
    expect(verifiedCall).toBeDefined();
    expect(verifiedCall[1].postUrl).toBe("https://dev.to/testuser/test-devto-article-123");

    // POST_VERIFIED event emitted with canonical + syndicated URL
    const verifiedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.VERIFIED && c[1]?.postId === "post-devto-1",
    );
    expect(verifiedEvent).toBeDefined();
    expect(verifiedEvent[1]).toMatchObject({
      postId: "post-devto-1",
      network: "DEVTO",
      postUrl: "https://dev.to/testuser/test-devto-article-123",
      canonicalUrl: "https://example.com/blog/test-devto-article",
      syndicatedUrl: "https://dev.to/testuser/test-devto-article-123",
      contentType: "ARTICLE",
    });
    expect(ctx.devtoPoster.verifyPosted).toHaveBeenCalledWith(
      mockContext,
      "https://dev.to/testuser/test-devto-article-123",
      "https://example.com/blog/test-devto-article",
    );
  });

  it("P1-10: canonical mismatch keeps article unverified and requests re-verification", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,DEVTO";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-devto-canonical-mismatch",
      network: SocialNetwork.DEVTO,
      contentType: ContentType.ARTICLE,
      content: JSON.stringify({
        title: "Test Dev.to Article",
        bodyMarkdown: "# Hello\n\nThis is a test article.",
        tags: ["test"],
        slug: "test-devto-article",
        excerpt: "A test article.",
      }),
      canonicalUrl: "https://example.com/blog/test-devto-article",
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.devtoPoster.postArticle.mockResolvedValue({
      success: true,
      url: "https://dev.to/testuser/test-devto-article-123",
    });
    ctx.devtoPoster.verifyPosted.mockResolvedValue(null);

    const result = await ctx.service.postById("post-devto-canonical-mismatch");

    expect(result).toEqual({
      success: false,
      error: "Post verification failed",
      retryable: true,
    });
    expect(ctx.devtoPoster.verifyPosted).toHaveBeenCalledWith(
      mockContext,
      "https://dev.to/testuser/test-devto-article-123",
      "https://example.com/blog/test-devto-article",
    );
    expect(ctx.eventEmitter.emit).not.toHaveBeenCalledWith(
      PostEvents.VERIFIED,
      expect.objectContaining({ postId: "post-devto-canonical-mismatch" }),
    );
  });

  // ── postById() — Poster Error (result.error) ───────────────────────────────

  it("UTC-052: postById() on poster error (result.error) updates FAILED, emits SSE FAILED, no rate record", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-err",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ error: "navigation timeout" });

    const result = await ctx.service.postById("post-err");

    expect(result).toEqual({ success: false, error: "navigation timeout", retryable: false });

    // updateStatus called with FAILED + errorMessage
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe("navigation timeout");

    // SSE FAILED event
    const failedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.FAILED && c[1]?.postId === "post-err",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[1]).toMatchObject({
      postId: "post-err",
      network: "X",
      error: "navigation timeout",
    });

    // recordPost NOT called (only on success)
    expect(ctx.rateLimitService.recordPost).not.toHaveBeenCalled();
  });

  // ── postById() — Exception (session null) ──────────────────────────────────

  it("UTC-053: postById() on session null returns retryable deferral and emits FAILED(retryable=true)", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-nosession",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(null);

    const result = await ctx.service.postById("post-nosession");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No active session");
    expect(result.retryable).toBe(true);

    // No FAILED status update for a retryable deferral
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeUndefined();

    // Post reverted to APPROVED so BullMQ can retry cleanly
    const approvedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.APPROVED,
    );
    expect(approvedCall).toBeDefined();

    // SSE FAILED event with retryable flag (UI distinguishes terminal vs. retry)
    const failedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.FAILED,
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[1]).toMatchObject({
      postId: "post-nosession",
      network: "X",
      error: expect.stringContaining("No active session"),
      retryable: true,
    });

    // recordPost NOT called
    expect(ctx.rateLimitService.recordPost).not.toHaveBeenCalled();
  });

  // ── postById() — Session State Saving ──────────────────────────────────────

  it("UTC-054: postById() saves updated storageState and closes context after posting", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-save",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    await ctx.service.postById("post-save");

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

  it("UTC-055: postById() catches any thrown error in try block, sets FAILED, emits SSE, returns failure", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-crash",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.browser.acquireContext.mockRejectedValue(new Error("browser crash"));

    const result = await ctx.service.postById("post-crash");

    expect(result).toEqual({ success: false, error: "browser crash", retryable: false });

    // FAILED status set
    const failedCall = ctx.postsService.updateStatus.mock.calls.find(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toBe("browser crash");

    // SSE FAILED event
    const failedEvent = ctx.eventEmitter.emit.mock.calls.find(
      (c: unknown[]) => c[0] === PostEvents.FAILED && c[1]?.postId === "post-crash",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent[1].error).toBe("browser crash");
  });

  // ── postAllApproved() — Batch Mode ─────────────────────────────────────────

  it("UTC-056: postAllApproved() fetches approved posts and calls postById for each with delays", async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: "p1" },
        { ...APPROVED_POST_X, id: "p2" },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    // Spy on postById to avoid full pipeline
    const postByIdSpy = vi.spyOn(ctx.service, "postById");
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
    expect(postByIdSpy).toHaveBeenCalledWith("p1");
    expect(postByIdSpy).toHaveBeenCalledWith("p2");

    // randomDelay called between posts
    expect(ctx.browser.randomDelay).toHaveBeenCalled();

    // Returns correct counts (D1: now includes skipped)
    expect(result).toEqual({ posted: 2, failed: 0, skipped: 0 });
  });

  it("UTC-057: postAllApproved() counts failures correctly when postById returns failure", async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: "p1" },
        { ...APPROVED_POST_X, id: "p2" },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    const postByIdSpy = vi.spyOn(ctx.service, "postById");
    postByIdSpy.mockResolvedValue({ success: true });
    postByIdSpy.mockResolvedValueOnce({ success: false, error: "err" });

    const result = await ctx.service.postAllApproved();

    expect(result).toEqual({ posted: 1, failed: 1, skipped: 0 });
  });

  it("UTC-058: postAllApproved() returns {posted:0, failed:0, skipped:0} when no approved posts", async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [],
      total: 0,
      limit: 50,
      offset: 0,
    });

    const postByIdSpy = vi.spyOn(ctx.service, "postById");

    const result = await ctx.service.postAllApproved();

    expect(result).toEqual({ posted: 0, failed: 0, skipped: 0 });
    // postById NOT called
    expect(postByIdSpy).not.toHaveBeenCalled();
    // randomDelay NOT called
    expect(ctx.browser.randomDelay).not.toHaveBeenCalled();
  });

  it("UTC-059: postAllApproved() applies human-like delay (10000-30000ms) between posts", async () => {
    ctx.postsService.findMany.mockResolvedValue({
      posts: [
        { ...APPROVED_POST_X, id: "p1" },
        { ...APPROVED_POST_X, id: "p2" },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    vi.spyOn(ctx.service, "postById").mockResolvedValue({ success: true });

    await ctx.service.postAllApproved();

    // randomDelay called with (10000, 30000)
    const delayCalls = ctx.browser.randomDelay.mock.calls.filter(
      (c: unknown[]) => c[0] === 10000 && c[1] === 30000,
    );
    expect(delayCalls.length).toBeGreaterThan(0);
    expect(delayCalls[0]).toEqual([10000, 30000]);
  });

  // ── P0-H3: Encryption passthrough round-trip ──────────────────────────────

  it("UTC-075: postById() correctly handles passthrough string storageState (no double-encoding)", async () => {
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
      id: "post-enc-1",
      status: PostStatus.APPROVED,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(passthroughSession);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });

    await ctx.service.postById("post-enc-1");

    // acquireContext should receive the raw JSON string, NOT double-encoded
    expect(ctx.browser.acquireContext).toHaveBeenCalledWith(
      SocialNetwork.X,
      '{"cookies":[{"name":"auth","value":"token"}],"origins":[]}',
      "acc-001",
    );
  });

  // ── F2: Multi-Stage Delayed Scheduling ─────────────────────────────────────

  it("F2-001: scheduleMultiStagePosting() throws if post is not a thread root", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      threadId: null,
      threadPosition: 0,
    });
    await expect(ctx.service.scheduleMultiStagePosting("post-not-root")).rejects.toThrow(
      "not a thread root",
    );
  });

  it("F2-002: scheduleMultiStagePosting() falls back to immediate postById when no QueueFactory", async () => {
    ctx = buildContext(null);
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-root",
      threadId: "thread-1",
      threadPosition: 0,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });
    ctx.postsService.findThreadContinuations.mockResolvedValue([]);

    const result = await ctx.service.scheduleMultiStagePosting("post-root");
    expect(result.immediate).toBe(true);
    expect(result.scheduled).toBe(0);
  });

  it("F2-003: postById() multi-stage root posts only root (not continuations)", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-ms-root",
      threadId: "thread-ms",
      threadPosition: 0,
      llmMetadata: { multiStage: true, threadDepth: 2, model: "gpt-5-nano" },
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/123" });
    ctx.postsService.findThreadContinuations.mockResolvedValue([
      {
        id: "post-ms-cont",
        content: "Continuation",
        threadPosition: 1,
        status: PostStatus.APPROVED,
      },
    ]);

    const result = await ctx.service.postById("post-ms-root");

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://x.com/user/status/123");
    // Root was posted with empty thread items — continuation is NOT in the same browser session
    expect(ctx.xPoster.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      undefined,
    );
  });

  it("F2-004: postById() multi-stage root schedules the next continuation after success", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-ms-root-2",
      threadId: "thread-ms-2",
      threadPosition: 0,
      llmMetadata: { multiStage: true, threadDepth: 2, model: "gpt-5-nano" },
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/456" });
    ctx.postsService.findThreadContinuations.mockResolvedValue([
      {
        id: "post-ms-cont-2",
        content: "Continuation",
        threadPosition: 1,
        status: PostStatus.APPROVED,
      },
    ]);
    ctx.configService.get.mockImplementation((key: string) =>
      key === "THREAD_CONTINUATION_DELAY_MS" ? "1800000" : undefined,
    );

    await ctx.service.postById("post-ms-root-2");

    expect(ctx.queueFactory.enqueuePosting).toHaveBeenCalledWith(
      "post-ms-cont-2",
      "X",
      expect.objectContaining({ delay: 1800000, priority: 5 }),
      "acc-001",
    );
  });

  it("F2-005: postById() multi-stage continuation posts as a reply to the root", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    const continuation = {
      ...APPROVED_POST_X,
      id: "post-ms-cont-3",
      threadId: "thread-ms-3",
      threadPosition: 1,
      content: "Reply text",
      llmMetadata: { multiStage: true, threadDepth: 2, model: "gpt-5-nano" },
    };
    ctx.postsService.findById.mockResolvedValue(continuation);
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.postsService.findThreadRoot.mockResolvedValue({
      id: "post-ms-root-3",
      postUrl: "https://x.com/user/status/789",
      status: PostStatus.POSTED,
    });
    ctx.xPoster.postThreadReply.mockResolvedValue({ url: "https://x.com/user/status/789" });

    const result = await ctx.service.postById("post-ms-cont-3");

    expect(result.success).toBe(true);
    expect(ctx.xPoster.postThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "https://x.com/user/status/789",
      "Reply text",
    );
  });

  it("F2-006: postById() multi-stage continuation defers when root is not yet posted", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-ms-cont-4",
      threadId: "thread-ms-4",
      threadPosition: 1,
      llmMetadata: { multiStage: true, threadDepth: 2, model: "gpt-5-nano" },
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.postsService.findThreadRoot.mockResolvedValue({
      id: "post-ms-root-4",
      postUrl: null,
      status: PostStatus.POSTING,
    });

    vi.useFakeTimers();
    try {
      const promise = ctx.service.postById("post-ms-cont-4");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain("Root post not yet published");
      expect(ctx.xPoster.postThreadReply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── P0-H2: Thread with continuations ───────────────────────────────────────

  it("UTC-076: postById() thread root with 3 continuations — loads continuations, posts root + replies, tracks via ThreadProgressService", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-thread-root",
      threadId: "thread-xyz",
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    // 3 continuation posts
    const continuations = [
      { id: "reply-1", content: "Reply 1", threadPosition: 1, status: PostStatus.APPROVED },
      { id: "reply-2", content: "Reply 2", threadPosition: 2, status: PostStatus.APPROVED },
      { id: "reply-3", content: "Reply 3", threadPosition: 3, status: PostStatus.APPROVED },
    ];
    ctx.postsService.findThreadContinuations.mockResolvedValue(continuations);

    // Poster returns URL + all replies succeeded
    ctx.xPoster.post.mockResolvedValue({
      url: "https://x.com/user/status/123",
      threadReplyResults: [
        { index: 0, success: true },
        { index: 1, success: true },
        { index: 2, success: true },
      ],
    });

    const result = await ctx.service.postById("post-thread-root");

    // Success
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://x.com/user/status/123");

    // findThreadContinuations called for thread root
    expect(ctx.postsService.findThreadContinuations).toHaveBeenCalledWith("thread-xyz");

    // ThreadProgressService.initThread called with root post ID and all replies
    expect(ctx.threadProgressService.initThread).toHaveBeenCalledWith("post-thread-root", [
      { id: "reply-1", threadPosition: 1 },
      { id: "reply-2", threadPosition: 2 },
      { id: "reply-3", threadPosition: 3 },
    ]);

    // Each reply marked as POSTED via ThreadProgressService
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledTimes(3);
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledWith(
      "post-thread-root",
      "reply-1",
      "https://x.com/user/status/123",
    );

    // Each reply also gets updateStatus POSTED
    const replyPostedCalls = ctx.postsService.updateStatus.mock.calls.filter(
      (c: unknown[]) => c[1]?.status === PostStatus.POSTED && c[0] !== "post-thread-root",
    );
    expect(replyPostedCalls).toHaveLength(3);

    // SSE POSTED events for root + 3 replies
    const postedEvents = ctx.eventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === PostEvents.POSTED,
    );
    expect(postedEvents.length).toBeGreaterThanOrEqual(4);

    // P1-04a: successful replies are also marked VERIFIED and emit POST_VERIFIED
    const replyVerifiedCalls = ctx.postsService.updateStatus.mock.calls.filter(
      (c: unknown[]) => c[1]?.status === PostStatus.VERIFIED && c[0] !== "post-thread-root",
    );
    expect(replyVerifiedCalls).toHaveLength(3);

    const verifiedEvents = ctx.eventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === PostEvents.VERIFIED,
    );
    expect(verifiedEvents.length).toBeGreaterThanOrEqual(4); // root + 3 replies
  });

  it("UTC-077: postById() thread partial failure — reply 1 POSTED, reply 2 FAILED → only reply 2 retried on resume", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-thread-partial",
      threadId: "thread-partial",
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);

    const continuations = [
      { id: "reply-1", content: "Reply 1", threadPosition: 1, status: PostStatus.APPROVED },
      { id: "reply-2", content: "Reply 2", threadPosition: 2, status: PostStatus.APPROVED },
    ];
    ctx.postsService.findThreadContinuations.mockResolvedValue(continuations);

    // Poster returns URL + reply 1 succeeded, reply 2 failed
    ctx.xPoster.post.mockResolvedValue({
      url: "https://x.com/user/status/456",
      threadReplyResults: [
        { index: 0, success: true },
        { index: 1, success: false, error: "Reply button not found" },
      ],
    });

    const result = await ctx.service.postById("post-thread-partial");

    // Root post still succeeds
    expect(result.success).toBe(true);

    // Reply 1 marked POSTED
    expect(ctx.threadProgressService.markReplyPosted).toHaveBeenCalledWith(
      "post-thread-partial",
      "reply-1",
      "https://x.com/user/status/456",
    );

    // Reply 2 marked FAILED
    expect(ctx.threadProgressService.markReplyFailed).toHaveBeenCalledWith(
      "post-thread-partial",
      "reply-2",
      "Reply button not found",
    );

    // Reply 2 updateStatus called with FAILED
    const replyFailedCalls = ctx.postsService.updateStatus.mock.calls.filter(
      (c: unknown[]) => c[1]?.status === PostStatus.FAILED && c[0] === "reply-2",
    );
    expect(replyFailedCalls).toHaveLength(1);
    expect(replyFailedCalls[0][1].errorMessage).toBe("Reply button not found");
  });

  // ── Self-recovery on session expiry ────────────────────────────────────────

  it("UTC-078: postById() self-recovery — poster returns session_expired → getOrCreateSession → retry post", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-recovery",
      network: SocialNetwork.X,
    });

    // First session (expired), second session (fresh)
    const expiredSession = { ...ACTIVE_SESSION, id: "sess-old" };
    const freshSession = { ...ACTIVE_SESSION, id: "sess-new" };
    ctx.sessionsService.getOrCreateSession
      .mockResolvedValueOnce(expiredSession)
      .mockResolvedValueOnce(freshSession);

    // First post attempt returns session expired error
    ctx.xPoster.post
      .mockResolvedValueOnce({ error: "Not logged in — session expired, relogin needed" })
      .mockResolvedValueOnce({ url: "https://x.com/user/status/789" });

    const result = await ctx.service.postById("post-recovery");

    // Recovery succeeded
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://x.com/user/status/789");

    // getOrCreateSession called twice (original + recovery)
    expect(ctx.sessionsService.getOrCreateSession).toHaveBeenCalledTimes(2);

    // markSessionExpired called for the old session
    expect(ctx.sessionsService.markSessionExpired).toHaveBeenCalledWith(
      SocialNetwork.X,
      "sess-old",
    );

    // Poster called twice (original failed + retry succeeded)
    expect(ctx.xPoster.post).toHaveBeenCalledTimes(2);
  });

  // ── Warmup check defers ────────────────────────────────────────────────────

  it("UTC-079: postById() warmup check defers — canPost=false → throw Error (deferred)", async () => {
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-warmup",
      network: SocialNetwork.X,
    });
    ctx.warmupService.canPost.mockResolvedValue(false);

    await expect(ctx.service.postById("post-warmup")).rejects.toThrow("warm-up");

    // No posting attempted
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
    expect(ctx.xPoster.post).not.toHaveBeenCalled();
    // No SSE events
    expect(ctx.eventEmitter.emit).not.toHaveBeenCalled();
  });

  // ── Post not found ─────────────────────────────────────────────────────────

  it("UTC-080: postById() throws NotFoundException when post not found (findById returns null)", async () => {
    ctx.postsService.findById.mockResolvedValue(null);

    await expect(ctx.service.postById("nonexistent-post")).rejects.toThrow();
    // Should not attempt any posting
    expect(ctx.browser.acquireContext).not.toHaveBeenCalled();
  });

  // ── SSE events at correct stages ───────────────────────────────────────────

  it("UTC-081: postById() publishes SSE events POSTING_STARTED, POSTED at correct stages", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-sse",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/sse" });

    await ctx.service.postById("post-sse");

    // SSE events published in order: POSTING → POSTED
    const events = ctx.eventEmitter.emit.mock.calls.map((c: unknown[]) => c[1]);
    const eventNames = ctx.eventEmitter.emit.mock.calls.map((c: unknown[]) => c[0]);

    // POSTING event comes before POSTED event
    const postingIdx = eventNames.indexOf(PostEvents.POSTING_STARTED);
    const postedIdx = eventNames.indexOf(PostEvents.POSTED);
    expect(postingIdx).toBeGreaterThanOrEqual(0);
    expect(postedIdx).toBeGreaterThan(postingIdx);

    // POSTING event has correct fields
    expect(events[postingIdx]).toMatchObject({
      postId: "post-sse",
      network: "X",
    });

    // POSTED event has correct fields
    expect(events[postedIdx]).toMatchObject({
      postId: "post-sse",
      network: "X",
      postUrl: "https://x.com/user/status/sse",
    });
  });

  it("UTC-082: postById() publishes SSE FAILED event when poster returns error", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-sse-fail",
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ error: "compose dialog failed" });

    await ctx.service.postById("post-sse-fail");

    // SSE events: POSTING → FAILED
    const events = ctx.eventEmitter.emit.mock.calls.map((c: unknown[]) => c[1]);
    const eventNames = ctx.eventEmitter.emit.mock.calls.map((c: unknown[]) => c[0]);

    const postingIdx = eventNames.indexOf(PostEvents.POSTING_STARTED);
    const failedIdx = eventNames.indexOf(PostEvents.FAILED);
    expect(postingIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(postingIdx);

    // FAILED event has error field
    expect(events[failedIdx]).toMatchObject({
      postId: "post-sse-fail",
      network: "X",
      error: "compose dialog failed",
    });
  });

  // ── Thread continuation loading ────────────────────────────────────────────

  it("UTC-083: postById() calls findThreadContinuations for thread root posts (threadPosition=0)", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-thread-load",
      threadId: "thread-load-test",
      threadPosition: 0,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/load" });
    ctx.postsService.findThreadContinuations.mockResolvedValue([]);

    await ctx.service.postById("post-thread-load");

    // findThreadContinuations called with the threadId
    expect(ctx.postsService.findThreadContinuations).toHaveBeenCalledWith("thread-load-test");
  });

  it("UTC-084: postById() does NOT call findThreadContinuations for non-thread posts (threadId=null)", async () => {
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-no-thread",
      threadId: null,
      threadPosition: null,
      network: SocialNetwork.X,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.xPoster.post.mockResolvedValue({ url: "https://x.com/user/status/nothread" });

    await ctx.service.postById("post-no-thread");

    // findThreadContinuations NOT called (no threadId)
    expect(ctx.postsService.findThreadContinuations).not.toHaveBeenCalled();
  });

  // ── Phase 2 social syndication networks ─────────────────────────────────────

  it("UTC-085: postById() calls BlueskyPoster and emits POSTED + VERIFIED for Bluesky", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,BLUESKY";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-bluesky",
      network: SocialNetwork.BLUESKY,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.blueskyPoster.post.mockResolvedValue({
      url: "https://bsky.app/profile/handle.bsky.social/post/3k2",
    });

    const result = await ctx.service.postById("post-bluesky");

    expect(result.success).toBe(true);
    expect(ctx.blueskyPoster.post).toHaveBeenCalledWith(
      mockContext,
      ctx.browser,
      "Workflow trends are here! 🎯",
    );
    expect(ctx.postsService.updateStatus).toHaveBeenCalledWith("post-bluesky", {
      status: PostStatus.VERIFIED,
      postUrl: "https://bsky.app/profile/handle.bsky.social/post/3k2",
    });
  });

  it("UTC-086: postById() calls MastodonPoster and emits POSTED + VERIFIED for Mastodon", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,MASTODON";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-mastodon",
      network: SocialNetwork.MASTODON,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.mastodonPoster.post.mockResolvedValue({ url: "https://mastodon.social/@user/123456" });

    const result = await ctx.service.postById("post-mastodon");

    expect(result.success).toBe(true);
    expect(ctx.mastodonPoster.post).toHaveBeenCalledWith(
      mockContext,
      ctx.browser,
      "Workflow trends are here! 🎯",
    );
    expect(ctx.postsService.updateStatus).toHaveBeenCalledWith("post-mastodon", {
      status: PostStatus.VERIFIED,
      postUrl: "https://mastodon.social/@user/123456",
    });
  });

  it("UTC-087: postById() calls TelegramAdapter.postMessage and emits POSTED + VERIFIED for Telegram", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,TELEGRAM";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-telegram",
      network: SocialNetwork.TELEGRAM,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.telegramAdapter.postMessage.mockResolvedValue({ url: "https://t.me/channel/123" });

    const result = await ctx.service.postById("post-telegram");

    expect(result.success).toBe(true);
    expect(ctx.telegramAdapter.postMessage).toHaveBeenCalledWith("Workflow trends are here! 🎯");
    expect(ctx.postsService.updateStatus).toHaveBeenCalledWith("post-telegram", {
      status: PostStatus.VERIFIED,
      postUrl: "https://t.me/channel/123",
    });
  });

  it("UTC-088: postById() calls LinkedinSocialPoster and emits POSTED + VERIFIED for LinkedIn SOCIAL_POST", async () => {
    process.env.ENABLED_NETWORKS = "X,THREADS,FACEBOOK,LINKEDIN";
    const mockContext = createMockContext();
    ctx.browser.acquireContext.mockResolvedValue(mockContext);
    ctx.browser.saveStorageState.mockResolvedValue('{"cookies":[]}');
    ctx.postsService.findById.mockResolvedValue({
      ...APPROVED_POST_X,
      id: "post-linkedin-social",
      network: SocialNetwork.LINKEDIN,
      contentType: ContentType.SOCIAL_POST,
    });
    ctx.sessionsService.getOrCreateSession.mockResolvedValue(ACTIVE_SESSION);
    ctx.linkedinSocialPoster.post.mockResolvedValue({
      url: "https://www.linkedin.com/feed/update/urn:li:activity:123456",
    });

    const result = await ctx.service.postById("post-linkedin-social");

    expect(result.success).toBe(true);
    expect(ctx.linkedinSocialPoster.post).toHaveBeenCalledWith(
      mockContext,
      ctx.browser,
      "Workflow trends are here! 🎯",
    );
    expect(ctx.postsService.updateStatus).toHaveBeenCalledWith("post-linkedin-social", {
      status: PostStatus.VERIFIED,
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123456",
    });
  });
});
