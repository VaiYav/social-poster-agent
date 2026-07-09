/**
 * MOD-05: Infrastructure Adapters Module — RateLimitService unit tests.
 *
 * Covers UTC-075 through UTC-088 (14 test cases).
 *
 * Source: packages/backend/src/modules/rate-limit/rate-limit.service.ts
 * Traces to: REQ-018, REQ-019, REQ-NF-003
 * Hazards: HAZ-006, HAZ-011
 *
 * NOTE: A1 refactor — checkRateLimit() is now read-only (uses redis.get, not incr).
 *       recordPost() does the incr. Env vars changed to RATE_LIMIT_{NET}_MAX_PER_DAY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ConfigService } from '@nestjs/config';
import { RateLimitService } from '../../../src/modules/rate-limit/rate-limit.service';
import { createMockRedis } from '../../mocks/index';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    REDIS_URL: 'redis://localhost:6380',
    RATE_LIMIT_PREFIX: 'spa:ratelimit',
    RATE_LIMIT_X_MAX_PER_DAY: 50,
    RATE_LIMIT_THREADS_MAX_PER_DAY: 75,
    RATE_LIMIT_FACEBOOK_MAX_PER_DAY: 25,
    RATE_LIMIT_X_MAX_PER_WEEK: 10,
    RATE_LIMIT_THREADS_MAX_PER_WEEK: 15,
    RATE_LIMIT_FACEBOOK_MAX_PER_WEEK: 5,
    RATE_LIMIT_MIN_DELAY_MS: 300_000,
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

// ── Tests ──

describe('RateLimitService (MOD-05 — Infrastructure Adapters)', () => {
  let service: RateLimitService;
  let configService: ConfigService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = createMockRedis();
    configService = createMockConfigService();
    // Sprint L: RateLimitService now receives Redis via DI (SHARED_REDIS token)
    service = new RateLimitService(configService, mockRedis as never);
  });

  // ── UTC-075 ──
  it('UTC-075: checkRateLimit() fails open (allowed:true) when Redis not connected', async () => {
    (service as unknown).redis = null;

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('Redis not connected');
  });

  // ── UTC-076 ──
  it('UTC-076: checkRateLimit() allows post when under daily limit and interval OK', async () => {
    // checkRateLimit uses redis.mget (read-only): daily='0', weekly='0', interval=null
    mockRedis.mget.mockResolvedValue(['0', '0', null]);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(true);
  });

  // ── UTC-077 ──
  it('UTC-077: checkRateLimit() blocks post when daily count reaches limit (boundary: count = limit)', async () => {
    // X daily limit is 50; daily count = 50 → blocked (>= check)
    mockRedis.mget.mockResolvedValue(['50', '0', null]);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily limit reached for X (50/50)');
  });

  // ── UTC-078 ──
  it('UTC-078: checkRateLimit() allows post when daily count is under limit (boundary: count = limit-1)', async () => {
    // X daily limit is 50; daily count = 49 → allowed
    mockRedis.mget.mockResolvedValue(['49', '0', null]);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(true);
  });

  // ── UTC-079 ──
  it('UTC-079: checkRateLimit() blocks post when minimum interval not elapsed', async () => {
    // 1 minute ago — X needs 5 min (300000ms)
    const oneMinAgo = (Date.now() - 60_000).toString();
    mockRedis.mget.mockResolvedValue(['0', '0', oneMinAgo]);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('wait');
    expect(result.reason).toContain('X');
  });

  // ── UTC-080 ──
  it('UTC-080: checkRateLimit() allows post when minimum interval has elapsed', async () => {
    // 301 seconds ago — X needs 300 seconds (300000ms)
    const overFiveMinAgo = (Date.now() - 301_000).toString();
    mockRedis.mget.mockResolvedValue(['0', '0', overFiveMinAgo]);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(true);
  });

  // ── UTC-081 ──
  it('UTC-081: recordPost() sets TTL on daily key only when count is 1 (first post of day)', async () => {
    mockRedis.incr.mockResolvedValue(1);

    await service.recordPost('THREADS');

    // expire called for daily key with TTL 86400 + 3600 = 90000 (25h)
    expect(mockRedis.expire).toHaveBeenCalled();
    const dailyExpire = mockRedis.expire.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes(':daily:'),
    );
    expect(dailyExpire).toBeDefined();
    expect(dailyExpire![1]).toBe(86400 + 3600);
  });

  // ── UTC-082 ──
  it('UTC-082: recordPost() does NOT set TTL when count > 1 (subsequent posts)', async () => {
    mockRedis.incr.mockResolvedValue(5);

    await service.recordPost('THREADS');

    // expire should NOT be called for daily key (count > 1)
    const dailyExpire = mockRedis.expire.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes(':daily:'),
    );
    expect(dailyExpire).toBeUndefined();
  });

  // ── UTC-083 ──
  it('UTC-083: checkRateLimit() uses default daily limit (1) for unknown network', async () => {
    // Unknown network — default limit is 1
    mockRedis.mget.mockResolvedValue(['1', '0', null]); // daily key — count=1 >= limit=1

    const result = await service.checkRateLimit('UNKNOWN');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('1/1');
  });

  // ── UTC-084 ──
  it('UTC-084: recordPost() sets interval timestamp with PX TTL when Redis connected', async () => {
    mockRedis.incr.mockResolvedValue(1);

    await service.recordPost('X');

    expect(mockRedis.set).toHaveBeenCalled();
    const setCall = mockRedis.set.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes(':interval'),
    );
    expect(setCall).toBeDefined();
    expect(setCall![0]).toContain('spa:ratelimit:X:interval');
    expect(setCall![1]).toMatch(/^\d+$/); // timestamp as string
    expect(setCall![2]).toBe('PX');
    expect(setCall![3]).toBe(300_000); // X interval is 300000ms
  });

  // ── UTC-085 ──
  it('UTC-085: recordPost() does nothing when Redis not connected', async () => {
    (service as unknown).redis = null;

    await service.recordPost('X');

    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  // ── UTC-086 ──
  it('UTC-086: getStatus() returns zeroed values when Redis not connected', async () => {
    (service as unknown).redis = null;

    const status = await service.getStatus('X');

    expect(status.dailyCount).toBe(0);
    expect(status.dailyLimit).toBe(50);
    expect(status.lastPostAt).toBeNull();
    expect(status.minIntervalMs).toBe(300_000);
  });

  // ── UTC-087 ──
  it('UTC-087: getStatus() returns current counts and limits when Redis connected', async () => {
    // redis.get returns '25' for daily, '10' for weekly, '1234567890' for interval
    mockRedis.get
      .mockResolvedValueOnce('25')       // daily key
      .mockResolvedValueOnce('10')       // weekly key
      .mockResolvedValueOnce('1234567890'); // interval key

    const status = await service.getStatus('X');

    expect(status.dailyCount).toBe(25);
    expect(status.dailyLimit).toBe(50);
    expect(status.lastPostAt).toBe(1234567890);
    expect(status.minIntervalMs).toBe(300_000);
  });

  // ── UTC-088 ──
  it('UTC-088: getStatus() returns null lastPostAt when no interval key set', async () => {
    mockRedis.get
      .mockResolvedValueOnce('10')   // daily key
      .mockResolvedValueOnce('0')    // weekly key
      .mockResolvedValueOnce(null);  // interval key — no last post

    const status = await service.getStatus('X');

    expect(status.lastPostAt).toBeNull();
    expect(status.dailyCount).toBe(10);
  });
});
