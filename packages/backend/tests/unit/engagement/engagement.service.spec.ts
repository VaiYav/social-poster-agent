/**
 * EngagementService unit tests — performInteraction resource cleanup.
 *
 * Source: packages/backend/src/modules/engagement/engagement.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocialNetwork } from '@prisma/client';
import { EngagementService } from '../../../src/modules/engagement/engagement.service';
import { createMockPrismaService } from '../../mocks/index';

describe('EngagementService — performInteraction cleanup', () => {
  let service: EngagementService;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let browser: {
    createContext: ReturnType<typeof vi.fn>;
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
  let mockPage: { close: ReturnType<typeof vi.fn> };
  let mockContext: { newPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPage = { close: vi.fn().mockResolvedValue(undefined) };
    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    prisma = createMockPrismaService() as never;
    (prisma as any).interaction.create.mockResolvedValue({ id: 'interaction-1', accountId: 'acc-1' });
    (prisma as any).interaction.update.mockResolvedValue({ id: 'interaction-1' });

    browser = {
      createContext: vi.fn().mockResolvedValue(mockContext),
      saveStorageState: vi.fn().mockResolvedValue(JSON.stringify({ cookies: [], origins: [] })),
    };

    sessionsService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ id: 'sess-1', accountId: 'acc-1', storageState: null }),
      decryptStorageState: vi.fn().mockReturnValue('{}'),
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
    );
  });

  it('P1-1.2: closes page and context when the engager action throws', async () => {
    xEngager.like.mockRejectedValue(new Error('like selector missing'));

    const result = await service.like(SocialNetwork.X, 'https://x.com/post/1');

    expect(result.success).toBe(false);
    expect(result.error).toBe('like selector missing');
    expect(mockPage.close).toHaveBeenCalled();
    expect(mockContext.close).toHaveBeenCalled();
    const pageCloseLast = mockPage.close.mock.invocationCallOrder[mockPage.close.mock.invocationCallOrder.length - 1];
    const contextCloseFirst = mockContext.close.mock.invocationCallOrder[0];
    expect(pageCloseLast).toBeLessThan(contextCloseFirst);
    expect((prisma as any).interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });
});
