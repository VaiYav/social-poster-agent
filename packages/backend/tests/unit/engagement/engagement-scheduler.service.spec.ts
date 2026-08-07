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
  clearCompletedAndFailedJobs: vi.fn().mockResolvedValue(0),
  clearPendingEngagementBrowsingJobs: vi.fn().mockResolvedValue(0),
} as unknown as QueueFactory;

const mockBrowsingSessionService = {
  runBrowsingSession: vi.fn().mockResolvedValue({ sessionId: 'test', postsViewed: 10, interactionsCount: 3 }),
} as unknown as BrowsingSessionService;

const mockSchedulerRegistry = {
  addCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
} as unknown as import('@nestjs/schedule').SchedulerRegistry;

describe('EngagementSchedulerService', () => {
  let service: EngagementSchedulerService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SC-001: disabled by default (ENGAGEMENT_SCHEDULER_ENABLED=false)', async () => {
    service = new EngagementSchedulerService(
      createMockConfigService(),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.pendingSessions).toBe(0);
  });

  it('SC-002: enabled when ENGAGEMENT_SCHEDULER_ENABLED=true', async () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '23:59', // far future to avoid scheduling past times
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    const status = service.getStatus();
    expect(status.enabled).toBe(true);
    // Scheduler now uses BullMQ delayed jobs instead of timeouts
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
  });

  it('SC-003: schedules sessions for all configured networks', async () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X,THREADS,FACEBOOK',
        ENGAGEMENT_SESSION_WINDOWS: '23:59',
        ENGAGEMENT_SESSIONS_PER_DAY: '1',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    // 3 networks * 1 session = 3 enqueueEngagement calls
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalledTimes(3);
  });

  it('SC-004: does not schedule past times', async () => {
    vi.setSystemTime(new Date('2026-06-27T23:58:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '00:01', // already past
        ENGAGEMENT_SESSIONS_PER_DAY: '1',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    expect(service.getStatus().pendingSessions).toBe(0);
  });

  it('SC-005: clears timeouts on destroy', async () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '23:59',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    // Scheduler now uses BullMQ — verify enqueueEngagement was called
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
    await service.onModuleDestroy();
    // After destroy, pendingSessions (scheduledTimeouts) should be 0
    expect(service.getStatus().pendingSessions).toBe(0);
    expect(mockQueueFactory.clearPendingEngagementBrowsingJobs).toHaveBeenCalled();
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
      mockSchedulerRegistry,
    );
    const status = service.getStatus();
    expect(status.sessionsPerDay).toBe(2);
    expect(status.windows).toEqual(['09:00', '13:00']);
    expect(status.jitterMinutes).toBe(45);
    expect(status.networks).toEqual(['X', 'THREADS']);
  });

  it('SC-007: handles no networks configured', async () => {
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: '',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
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
      mockSchedulerRegistry,
    );
    const status = service.getStatus();
    expect(status.networks).toEqual(['X', 'THREADS']);
  });

  it('BUG-2: scheduleDailySessions re-schedules sessions (engagement does not die after day 1)', async () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '23:59',
        ENGAGEMENT_SESSIONS_PER_DAY: '1',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    await service.onModuleInit();
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalledTimes(1); // start day
    // Simulate the next midnight cron firing — must re-populate the queue.
    await (service as unknown as { scheduleDailySessions: () => Promise<void> }).scheduleDailySessions();
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalledTimes(2);
  });

  it('BUG-2: scheduleDailySessions is a no-op when disabled', async () => {
    service = new EngagementSchedulerService(createMockConfigService(), mockQueueFactory, mockSchedulerRegistry);
    await (service as unknown as { scheduleDailySessions: () => Promise<void> }).scheduleDailySessions();
    expect(mockQueueFactory.enqueueEngagement).not.toHaveBeenCalled();
  });

  it('BUG-10: a malformed session window is dropped at parse time and never crashes the tick', async () => {
    vi.setSystemTime(new Date('2026-06-27T00:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        ENGAGEMENT_SESSION_WINDOWS: '09:00,foo,25:99,23:59', // 'foo' + out-of-range dropped
        ENGAGEMENT_SESSIONS_PER_DAY: '4',
        ENGAGEMENT_JITTER_MINUTES: '0',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    expect(service.getStatus().windows).toEqual(['09:00', '23:59']);
    // The old NaN path threw on .toISOString() and killed the whole tick.
    await service.onModuleInit();
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
  });

  it('SC-010: checkStaleAndEnqueue enqueues a session when last session failed', async () => {
    vi.setSystemTime(new Date('2026-06-27T12:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    const world = {
      timestamp: Date.now(),
      utcHour: 12,
      flowControl: { pauseAll: false, pauseEngagement: false },
      sessions: { X: { status: 'ACTIVE', lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
      engagement: {
        lastBrowseMs: { X: Date.now() - 30 * 60 * 1000 }, // 30 min ago
        uncheckedReplies: 0,
        warmupPhase: { X: 'full' },
        lastSessionStatus: { X: 'FAILED' },
        lastSessionInteractions: { X: 0 },
        engagementDebt: 0,
        commentsTargetToday: 0,
        commentsActualToday: 0,
        likesTargetToday: 0,
        likesActualToday: 0,
        debt: 0,
      },
    } as unknown as import('../../../src/modules/orchestrator/types').WorldState;
    await service.checkStaleAndEnqueue(world);
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
  });

  it('SC-011: checkStaleAndEnqueue skips when last session succeeded and is recent', async () => {
    vi.setSystemTime(new Date('2026-06-27T12:00:00Z'));
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    const world = {
      timestamp: Date.now(),
      utcHour: 12,
      flowControl: { pauseAll: false, pauseEngagement: false },
      sessions: { X: { status: 'ACTIVE', lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
      engagement: {
        lastBrowseMs: { X: Date.now() - 5 * 60 * 1000 }, // 5 min ago — not stuck
        uncheckedReplies: 0,
        warmupPhase: { X: 'full' },
        lastSessionStatus: { X: 'COMPLETED' },
        lastSessionInteractions: { X: 3 },
        engagementDebt: 0,
        commentsTargetToday: 0,
        commentsActualToday: 0,
        likesTargetToday: 0,
        likesActualToday: 0,
        debt: 0,
      },
    } as unknown as import('../../../src/modules/orchestrator/types').WorldState;
    await service.checkStaleAndEnqueue(world);
    expect(mockQueueFactory.enqueueEngagement).not.toHaveBeenCalled();
  });

  it('SC-012: checkStaleAndEnqueue enqueues a session that is ACTIVE but stuck past duration + buffer', async () => {
    vi.setSystemTime(new Date('2026-06-27T12:00:00Z'));
    // F1_BROWSING_SESSION_MINUTES = 10, so durationSec = 600; stuck threshold = 600 + 300 = 900s
    service = new EngagementSchedulerService(
      createMockConfigService({
        ENGAGEMENT_SCHEDULER_ENABLED: 'true',
        ENGAGEMENT_NETWORKS: 'X',
        F1_BROWSING_SESSION_MINUTES: '10',
      }),
      mockQueueFactory,
      mockSchedulerRegistry,
    );
    const world = {
      timestamp: Date.now(),
      utcHour: 12,
      flowControl: { pauseAll: false, pauseEngagement: false },
      sessions: { X: { status: 'ACTIVE', lastCheckMs: 0, circuitBreaker: 'closed' } },
      rateLimits: { X: { dailyRemaining: 10, weeklyRemaining: 50, minIntervalMs: 0, lastPostMs: 0 } },
      engagement: {
        lastBrowseMs: { X: Date.now() - 20 * 60 * 1000 }, // 20 min ago > 15 min threshold
        uncheckedReplies: 0,
        warmupPhase: { X: 'full' },
        lastSessionStatus: { X: 'COMPLETED' }, // previous session completed, but current is stuck
        lastSessionInteractions: { X: 3 },
        engagementDebt: 0,
        commentsTargetToday: 0,
        commentsActualToday: 0,
        likesTargetToday: 0,
        likesActualToday: 0,
        debt: 0,
      },
    } as unknown as import('../../../src/modules/orchestrator/types').WorldState;
    await service.checkStaleAndEnqueue(world);
    expect(mockQueueFactory.enqueueEngagement).toHaveBeenCalled();
  });
});
