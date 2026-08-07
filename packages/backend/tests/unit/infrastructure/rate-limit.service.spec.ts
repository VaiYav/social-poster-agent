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
import { RateLimitService, RECORD_POST_SCRIPT } from '../../../src/modules/rate-limit/rate-limit.service';
import { createMockRedis } from '../../mocks/index.js';

// ── Helpers ──

/**
 * In-test mirror of the Redis Lua script in RECORD_POST_SCRIPT.
 * Uses the same logic so unit tests can exercise the atomic
 * check-and-increment path without a live Redis server.
 */
function executeRecordPostScript(
  keys: string[],
  args: string[],
  store: Map<string, string>,
): [number, number, number] {
  const [dailyKey, weeklyKey, intervalKey, lastPostAtKey] = keys;
  const [dailyLimitStr, weeklyLimitStr, intervalMsStr, nowStr] = args;
  const dailyLimit = Number(dailyLimitStr);
  const weeklyLimit = Number(weeklyLimitStr);
  const intervalMs = Number(intervalMsStr);
  const now = Number(nowStr);

  const dailyCount = Number(store.get(dailyKey) ?? '0');
  if (dailyLimit > 0 && dailyCount >= dailyLimit) {
    return [0, dailyCount, Number(store.get(weeklyKey) ?? '0')];
  }

  const weeklyCount = Number(store.get(weeklyKey) ?? '0');
  if (weeklyLimit > 0 && weeklyCount >= weeklyLimit) {
    return [0, dailyCount, weeklyCount];
  }

  const intervalTs = Number(store.get(intervalKey) ?? '0');
  if (intervalMs > 0 && intervalTs > 0 && now - intervalTs < intervalMs) {
    return [0, dailyCount, weeklyCount];
  }

  const newDaily = String(dailyCount + 1);
  const newWeekly = String(weeklyCount + 1);
  store.set(dailyKey, newDaily);
  store.set(weeklyKey, newWeekly);
  store.set(lastPostAtKey, nowStr);
  if (intervalMs > 0) {
    store.set(intervalKey, nowStr);
  }

  return [1, Number(newDaily), Number(newWeekly)];
}

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
    // Wire the mock eval to execute the rate-limit Lua script in JS.
    mockRedis.eval.mockImplementation((script: string, numKeys: number, ...rest: unknown[]) => {
      if (script !== RECORD_POST_SCRIPT) {
        return Promise.resolve(undefined);
      }
      const keys = rest.slice(0, Number(numKeys)) as string[];
      const args = rest.slice(Number(numKeys)) as string[];
      const result = executeRecordPostScript(keys, args, mockRedis._store);
      return Promise.resolve(result);
    });
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
  it('UTC-081: recordPost() increments daily and weekly counters on first post', async () => {
    const result = await service.recordPost('THREADS');

    expect(result.allowed).toBe(true);
    expect(result.dailyCount).toBe(1);
    expect(result.weeklyCount).toBe(1);
    expect(mockRedis.eval).toHaveBeenCalled();
    const scriptCall = mockRedis.eval.mock.calls[0];
    expect(scriptCall![0]).toBe(RECORD_POST_SCRIPT);
    expect(scriptCall![1]).toBe(4); // 4 keys
    expect(
      mockRedis._store.get('spa:ratelimit:THREADS:daily:' + new Date().toISOString().slice(0, 10)),
    ).toBe('1');
    expect(
      mockRedis._store.get(
        'spa:ratelimit:THREADS:weekly:' + (service as unknown as { getWeekStart(): Date }).getWeekStart().toISOString().slice(0, 10),
      ),
    ).toBe('1');
  });

  // ── UTC-082 ──
  it('UTC-082: recordPost() increments counters for subsequent posts', async () => {
    mockRedis._store.set('spa:ratelimit:THREADS:daily:' + new Date().toISOString().slice(0, 10), '5');
    mockRedis._store.set(
      'spa:ratelimit:THREADS:weekly:' + (service as unknown as { getWeekStart(): Date }).getWeekStart().toISOString().slice(0, 10),
      '2',
    );

    const result = await service.recordPost('THREADS');

    expect(result.allowed).toBe(true);
    expect(result.dailyCount).toBe(6);
    expect(result.weeklyCount).toBe(3);
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
  it('UTC-084: recordPost() sets interval and lastPostAt timestamps when Redis connected', async () => {
    const result = await service.recordPost('X');

    expect(result.allowed).toBe(true);
    expect(mockRedis._store.get('spa:ratelimit:X:interval')).toMatch(/^\d+$/);
    expect(mockRedis._store.get('spa:ratelimit:X:lastPostAt')).toMatch(/^\d+$/);
  });

  // ── UTC-085 ──
  it('UTC-085: recordPost() does nothing when Redis not connected', async () => {
    (service as unknown).redis = null;

    const result = await service.recordPost('X');

    expect(result.allowed).toBe(true);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  // ── UTC-091 ──
  it('UTC-091: recordPost() refuses to increment when daily limit already reached', async () => {
    mockRedis._store.set('spa:ratelimit:X:daily:' + new Date().toISOString().slice(0, 10), '50');

    const result = await service.recordPost('X');

    expect(result.allowed).toBe(false);
    expect(result.dailyCount).toBe(50);
    expect(result.weeklyCount).toBe(0);
  });

  // ── UTC-092 ──
  it('UTC-092: recordPost() refuses to increment when weekly limit already reached', async () => {
    mockRedis._store.set(
      'spa:ratelimit:X:weekly:' + (service as unknown as { getWeekStart(): Date }).getWeekStart().toISOString().slice(0, 10),
      '10',
    );

    const result = await service.recordPost('X');

    expect(result.allowed).toBe(false);
    expect(result.dailyCount).toBe(0);
    expect(result.weeklyCount).toBe(10);
  });

  // ── UTC-093 ──
  it('UTC-093: recordPost() refuses to increment when minimum interval not elapsed', async () => {
    const now = Date.now();
    mockRedis._store.set('spa:ratelimit:X:interval', String(now - 60_000));

    const result = await service.recordPost('X');

    expect(result.allowed).toBe(false);
  });

  // ── UTC-094 ──
  it('UTC-094: recordPost() is atomic under concurrent calls — only one post passes the daily limit', async () => {
    configService = createMockConfigService({ RATE_LIMIT_X_MAX_PER_DAY: 1 });
    service = new RateLimitService(configService, mockRedis as never);

    const results = await Promise.all(Array.from({ length: 10 }, () => service.recordPost('X')));

    const allowedCount = results.filter((r) => r.allowed).length;
    const dailyCount = Number(
      mockRedis._store.get('spa:ratelimit:X:daily:' + new Date().toISOString().slice(0, 10)) ?? '0',
    );

    expect(allowedCount).toBe(1);
    expect(dailyCount).toBe(1);
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

  it('UTC-089: limit of 0 is treated as unlimited (not replaced with default)', async () => {
    configService = createMockConfigService({ RATE_LIMIT_X_MAX_PER_DAY: '0' });
    service = new RateLimitService(configService, mockRedis as never);
    mockRedis.mget.mockResolvedValue(['100', '0', null]); // count > 0 but limit is 0

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(true);
  });

  it('UTC-090: RATE_LIMIT_FAIL_CLOSED=true blocks posts when Redis is unavailable', async () => {
    configService = createMockConfigService({ RATE_LIMIT_FAIL_CLOSED: 'true' });
    service = new RateLimitService(configService, null as never);

    const result = await service.checkRateLimit('X');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('failed closed');
  });

  it('UTC-095: per-account interaction keys are separate per action and account', async () => {
    configService = createMockConfigService({
      RATE_LIMIT_INTERACTION_LIKE_MAX_PER_DAY: '1',
    });
    service = new RateLimitService(configService, mockRedis as never);

    // First like for acc-001 is allowed and recorded
    await service.recordPost('X', 'acc-001', 'like');
    const first = await service.checkRateLimit('X', 'acc-001', 'like');
    expect(first.allowed).toBe(false);
    expect(first.reason).toContain('Daily limit reached for X like (1/1)');

    // A different action on the same account is still allowed
    const comment = await service.checkRateLimit('X', 'acc-001', 'comment');
    expect(comment.allowed).toBe(true);

    // The same action on a different account is allowed
    const otherAccount = await service.checkRateLimit('X', 'acc-002', 'like');
    expect(otherAccount.allowed).toBe(true);

    // The Redis keys include account and action
    const today = new Date().toISOString().slice(0, 10);
    expect(mockRedis._store.has(`spa:ratelimit:X:acc-001:like:daily:${today}`)).toBe(true);
  });
});
