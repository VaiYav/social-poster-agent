/**
 * EngagementSchedulerService unit tests.
 *
 * Tests cron scheduling, jitter application, and network rotation.
 *
 * Source: packages/backend/src/modules/engagement/engagement-scheduler.service.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EngagementSchedulerService } from '../../../src/modules/engagement/engagement-scheduler.service';
import type { QueueFactory } from '../../../src/infrastructure/queue/queue.factory';
import type { BrowsingSessionService } from '../../../src/modules/engagement/browsing-session.service';

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaultValue),
  } as unknown as ConfigService;
}

const mockQueueFactory = {
  enqueuePosting: vi.fn().mockResolvedValue(undefined),
  enqueueEngagement: vi.fn().mockResolvedValue(undefined),
} as unknown as QueueFactory;

const mockBrowsingSessionService = {
  runBrowsingSession: vi.fn().mockResolvedValue({ sessionId: 'test', postsViewed: 10, interactionsCount: 3 }),
} as unknown as BrowsingSessionService;

describe('EngagementSchedulerService', () => {
  let service: EngagementSchedulerService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SC-001: disabled by default (ENGAGEMENT_SCHEDULER_ENABLED=false)', () => {
    service = new EngagementSchedulerService(
      createMockConfigService(),
      mockQueueFactory,
    );
    service.onModuleInit();
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.pendingSessions).toBe(0);
  });

  it('SC-002: enabled when ENGAGEMENT_SCHEDULER_ENABLED=true', () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '23:59', // far future to avoid scheduling past times
      }),
      mockQueueFactory,
    );
    service.onModuleInit();
    const status = service.getStatus();
    expect(status.enabled).toBe(true);
    // Scheduler now uses BullMQ delayed jobs instead of timeouts
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
  });

  it('SC-003: schedules sessions for all configured networks', () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X,THREADS,FACEBOOK',
        ENGAGEMENT_SESSION_WINDOWS: '23:59',
        ENGAGEMENT_SESSIONS_PER_DAY: '1',
      }),
      mockQueueFactory,
    );
    service.onModuleInit();
    // 3 networks * 1 session = 3 enqueueEngagement calls
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalledTimes(3);
  });

  it('SC-004: does not schedule past times', () => {
    vi.setSystemTime(new Date('2026-06-27T23:58:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '00:01', // already past
        ENGAGEMENT_SESSIONS_PER_DAY: '1',
      }),
      mockQueueFactory,
    );
    service.onModuleInit();
    expect(service.getStatus().pendingSessions).toBe(0);
  });

  it('SC-005: clears timeouts on destroy', () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '23:59',
      }),
      mockQueueFactory,
    );
    service.onModuleInit();
    // Scheduler now uses BullMQ — verify enqueueEngagement was called
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
    service.onModuleDestroy();
    // After destroy, pendingSessions (scheduledTimeouts) should be 0
    expect(service.getStatus().pendingSessions).toBe(0);
  });

  it('SC-006: getStatus returns correct config', () => {
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_SESSIONS_PER_DAY: '2',
        ENGAGEMENT_SESSION_WINDOWS: '09:00,13:00',
        ENGAGEMENT_JITTER_MINUTES: '45',
        ENGAGEMENT_NETWORKS: 'X,THREADS',
      }),
      mockQueueFactory,
    );
    const status = service.getStatus();
    expect(status.sessionsPerDay).toBe(2);
    expect(status.windows).toEqual(['09:00', '13:00']);
    expect(status.jitterMinutes).toBe(45);
    expect(status.networks).toEqual(['X', 'THREADS']);
  });

  it('SC-007: handles no networks configured', () => {
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: '',
      }),
      mockQueueFactory,
    );
    service.onModuleInit();
    expect(service.getStatus().networks).toEqual([]);
    expect(service.getStatus().pendingSessions).toBe(0);
  });

  it('SC-008: filters invalid network names', () => {
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X,INVALID,THREADS',
      }),
      mockQueueFactory,
    );
    const status = service.getStatus();
    expect(status.networks).toEqual(['X', 'THREADS']);
  });
});
