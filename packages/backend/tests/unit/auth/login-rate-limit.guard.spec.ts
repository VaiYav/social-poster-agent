/**
 * LoginRateLimitGuard unit tests — brute-force protection on POST /auth/login.
 */
import { describe, it, expect, vi } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginRateLimitGuard } from '../../../src/modules/auth/login-rate-limit.guard';

function cfg(values: Record<string, string | number> = {}): ConfigService {
  return { get: vi.fn((k: string, d?: unknown) => values[k] ?? d) } as unknown as ConfigService;
}

function mockRedis(execResult: unknown[][] = [[null, 0], [null, 1]]) {
  return {
    multi: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResult),
  } as unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('LoginRateLimitGuard', () => {
  it('allows the first login attempts up to the limit', async () => {
    const guard = new LoginRateLimitGuard(cfg({}), mockRedis([[null, 1], [null, 1]]));
    expect(await guard.canActivate(ctx({ ip: '1.1.1.1', body: {} }))).toBe(true);
  });

  it('throws 429 when attempts exceed the limit', async () => {
    const guard = new LoginRateLimitGuard(cfg({}), mockRedis([[null, 6], [null, 1]]));
    await expect(guard.canActivate(ctx({ ip: '1.1.1.1', body: {} }))).rejects.toThrow(HttpException);
  });

  it('uses socket.remoteAddress when ip is missing', async () => {
    const guard = new LoginRateLimitGuard(cfg({}), mockRedis([[null, 1], [null, 1]]));
    expect(
      await guard.canActivate(
        ctx({ body: {}, socket: { remoteAddress: '2.2.2.2' } }),
      ),
    ).toBe(true);
  });

  it('falls open when Redis errors to avoid locking users out', async () => {
    const redis = mockRedis();
    (redis as { exec: ReturnType<typeof vi.fn> }).exec.mockRejectedValue(new Error('Redis down'));
    const guard = new LoginRateLimitGuard(cfg({}), redis);
    expect(await guard.canActivate(ctx({ ip: '1.1.1.1', body: {} }))).toBe(true);
  });
});
