/**
 * EngagementService unit tests — performInteraction resource cleanup.
 *
 * Source: packages/backend/src/modules/engagement/engagement.service.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client";
import { EngagementService } from "../../../src/modules/engagement/engagement.service";
import { createMockPrismaService } from "../../mocks/index.js";

describe("EngagementService — performInteraction cleanup", () => {
  let service: EngagementService;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let browser: {
    acquireContext: ReturnType<typeof vi.fn>;
    releaseContext: ReturnType<typeof vi.fn>;
    saveStorageState: ReturnType<typeof vi.fn>;
  };
  let sessionsService: {
    getOrCreateSession: ReturnType<typeof vi.fn>;
    decryptStorageState: ReturnType<typeof vi.fn>;
    updateStorageState: ReturnType<typeof vi.fn>;
  };
  let sseService: { publish: ReturnType<typeof vi.fn> };
  let rateLimitService: {
    checkRateLimit: ReturnType<typeof vi.fn>;
    recordPost: ReturnType<typeof vi.fn>;
  };
  let flowControlService: { isPaused: ReturnType<typeof vi.fn> };
  let xEngager: { like: ReturnType<typeof vi.fn> };
  let threadsEngager: { like: ReturnType<typeof vi.fn> };
  let facebookEngager: { like: ReturnType<typeof vi.fn> };
  let warmupService: { canInteract: ReturnType<typeof vi.fn> };
  let mockPage: { close: ReturnType<typeof vi.fn> };
  let mockContext: { newPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPage = { close: vi.fn().mockResolvedValue(undefined) };
    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    prisma = createMockPrismaService() as never;
    (prisma as any).interaction.create.mockResolvedValue({
      id: "interaction-1",
      accountId: "acc-1",
    });
    (prisma as any).interaction.update.mockResolvedValue({ id: "interaction-1" });

    browser = {
      acquireContext: vi.fn().mockResolvedValue(mockContext),
      releaseContext: vi.fn(),
      saveStorageState: vi.fn().mockResolvedValue(JSON.stringify({ cookies: [], origins: [] })),
    };

    sessionsService = {
      getOrCreateSession: vi
        .fn()
        .mockResolvedValue({ id: "sess-1", accountId: "acc-1", storageState: null }),
      decryptStorageState: vi.fn().mockReturnValue("{}"),
      updateStorageState: vi.fn().mockResolvedValue(undefined),
    };

    sseService = { publish: vi.fn().mockResolvedValue(undefined) };
    rateLimitService = {
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
      recordPost: vi.fn().mockResolvedValue(undefined),
    };
    flowControlService = { isPaused: vi.fn().mockResolvedValue(false) };

    xEngager = { like: vi.fn() };
    threadsEngager = { like: vi.fn() };
    facebookEngager = { like: vi.fn() };
    warmupService = { canInteract: vi.fn().mockResolvedValue(true) };

    service = new EngagementService(
      prisma as never,
      sessionsService as never,
      browser as never,
      sseService as never,
      rateLimitService as never,
      flowControlService as never,
      xEngager as never,
      threadsEngager as never,
      facebookEngager as never,
      undefined,
      warmupService as never,
    );
  });

  it("P1-1.2: closes page and releases pooled context when the engager action throws", async () => {
    xEngager.like.mockRejectedValue(new Error("like selector missing"));

    const result = await service.like(SocialNetwork.X, "https://x.com/post/1");

    expect(result.success).toBe(false);
    expect(result.error).toBe("like selector missing");
    expect(mockPage.close).toHaveBeenCalled();
    expect(browser.releaseContext).toHaveBeenCalledWith(SocialNetwork.X, mockContext, undefined);
    const pageCloseLast =
      mockPage.close.mock.invocationCallOrder[mockPage.close.mock.invocationCallOrder.length - 1];
    const releaseContextFirst = (browser.releaseContext as any).mock.invocationCallOrder[0];
    expect(pageCloseLast).toBeLessThan(releaseContextFirst);
    expect((prisma as any).interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("P1-1.3: acquires context, saves storage state, and releases it on success", async () => {
    xEngager.like.mockResolvedValue({ success: true });

    const result = await service.like(SocialNetwork.X, "https://x.com/post/1");

    expect(result.success).toBe(true);
    expect(browser.acquireContext).toHaveBeenCalledWith(SocialNetwork.X, undefined, undefined);
    expect(browser.saveStorageState).toHaveBeenCalledWith(mockContext);
    expect(sessionsService.updateStorageState).toHaveBeenCalledWith("sess-1", expect.any(String));
    expect(mockPage.close).toHaveBeenCalled();
    expect(browser.releaseContext).toHaveBeenCalledWith(SocialNetwork.X, mockContext, undefined);
  });

  it("P1-1.4: skips interaction when account is in warm-up browse-only phase", async () => {
    warmupService.canInteract.mockResolvedValue(false);

    const result = await service.like(SocialNetwork.X, "https://x.com/post/1");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Account is in warm-up browse-only phase");
    expect(browser.acquireContext).not.toHaveBeenCalled();
    expect((prisma as any).interaction.create).not.toHaveBeenCalled();
  });

  it("SF-001: blocks engagement with a non-platform URL", async () => {
    const result = await service.like(SocialNetwork.X, "https://evil.example.com/phishing");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
    expect(browser.acquireContext).not.toHaveBeenCalled();
    expect((prisma as any).interaction.create).not.toHaveBeenCalled();
  });

  it("SF-002: blocks engagement with unsafe user-supplied comment text", async () => {
    const result = await service.comment(
      SocialNetwork.X,
      "https://x.com/post/1",
      "Follow me for more productivity!",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Follow/subscribe bait");
    expect(browser.acquireContext).not.toHaveBeenCalled();
    expect((prisma as any).interaction.create).not.toHaveBeenCalled();
  });

  it("SF-003: blocks engagement with a URL from the wrong network", async () => {
    const result = await service.like(SocialNetwork.THREADS, "https://x.com/post/1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
    expect(browser.acquireContext).not.toHaveBeenCalled();
  });
});
