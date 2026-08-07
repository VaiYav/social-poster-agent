/**
 * F1: EngagementController unit tests.
 *
 * Covers REST endpoints for engagement actions, browsing sessions, and scheduler status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { EngagementController } from '../../../src/modules/engagement/engagement.controller';
import type { EngagementService } from '../../../src/modules/engagement/engagement.service';
import type { BrowsingSessionService } from '../../../src/modules/engagement/browsing-session.service';
import type { EngagementSchedulerService } from '../../../src/modules/engagement/engagement-scheduler.service';
import { EngagementSafetyService } from '../../../src/modules/engagement/engagement-safety.service';
import { AdminGuard } from '../../../src/modules/auth/admin.guard';
import { SocialNetwork } from '@prisma/client';

describe('F1: EngagementController', () => {
  let controller: EngagementController;
  let engagementService: {
    like: ReturnType<typeof vi.fn>;
    comment: ReturnType<typeof vi.fn>;
    follow: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    repost: ReturnType<typeof vi.fn>;
    quote: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
  };
  let browsingSessionService: {
    runBrowsingSession: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findInteractions: ReturnType<typeof vi.fn>;
  };
  let engagementSchedulerService: {
    getStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    engagementService = {
      like: vi.fn().mockResolvedValue({ success: true }),
      comment: vi.fn().mockResolvedValue({ success: true }),
      follow: vi.fn().mockResolvedValue({ success: true }),
      reply: vi.fn().mockResolvedValue({ success: true }),
      repost: vi.fn().mockResolvedValue({ success: true }),
      quote: vi.fn().mockResolvedValue({ success: true }),
      getStats: vi.fn().mockResolvedValue({ total: 5, completed: 4, failed: 1, byType: {} }),
    };
    browsingSessionService = {
      runBrowsingSession: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      findAll: vi.fn().mockResolvedValue([]),
      findInteractions: vi.fn().mockResolvedValue([]),
    };
    engagementSchedulerService = {
      getStatus: vi.fn().mockReturnValue({
        enabled: true,
        sessionsPerDay: 3,
        windows: ['09:00'],
        networks: ['X'],
        jitterMinutes: 30,
        pendingSessions: 0,
      }),
    };

    const engagementSafetyService = new EngagementSafetyService();
    const adminGuard = new AdminGuard({ get: vi.fn().mockReturnValue('false') } as never);

    controller = new EngagementController(
      engagementService as unknown as EngagementService,
      browsingSessionService as unknown as BrowsingSessionService,
      engagementSchedulerService as unknown as EngagementSchedulerService,
      engagementSafetyService,
      adminGuard,
    );
  });

  it('getSchedulerStatus() returns scheduler status', async () => {
    const result = await controller.getSchedulerStatus();

    expect(result).toEqual({
      enabled: true,
      sessionsPerDay: 3,
      windows: ['09:00'],
      networks: ['X'],
      jitterMinutes: 30,
      pendingSessions: 0,
    });
    expect(engagementSchedulerService.getStatus).toHaveBeenCalled();
  });

  it('getStats() returns stats for a network', async () => {
    const result = await controller.getStats('X');

    expect(result).toEqual({ total: 5, completed: 4, failed: 1, byType: {} });
    expect(engagementService.getStats).toHaveBeenCalledWith(SocialNetwork.X);
  });

  it('getStats() returns stats without network', async () => {
    await controller.getStats();

    expect(engagementService.getStats).toHaveBeenCalledWith(undefined);
  });

  it('startBrowsingSession() delegates to BrowsingSessionService', async () => {
    const body = { network: 'X', durationSec: 600 };
    const result = await controller.startBrowsingSession(body);

    expect(result).toEqual({ sessionId: 's1' });
    expect(browsingSessionService.runBrowsingSession).toHaveBeenCalledWith(SocialNetwork.X, 600);
  });

  it('like() validates and delegates to EngagementService', async () => {
    const body = { network: 'X', postUrl: 'https://x.com/user/status/123' };
    const result = await controller.like(body);

    expect(result).toEqual({ success: true });
    expect(engagementService.like).toHaveBeenCalledWith(SocialNetwork.X, body.postUrl);
  });

  it('like() throws BadRequestException for invalid body', async () => {
    await expect(controller.like({ network: 'X' })).rejects.toThrow(BadRequestException);
  });

  it('getBrowsingSessions() delegates to BrowsingSessionService with filters', async () => {
    await controller.getBrowsingSessions('X', 'COMPLETED', '5');

    expect(browsingSessionService.findAll).toHaveBeenCalledWith({
      network: SocialNetwork.X,
      status: 'COMPLETED',
      limit: 5,
    });
  });
});
