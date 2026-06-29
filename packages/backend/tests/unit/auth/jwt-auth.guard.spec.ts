/**
 * JwtAuthGuard unit tests — global JWT cookie auth guard.
 *
 * Source: packages/backend/src/modules/auth/jwt-auth.guard.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../../src/modules/auth/jwt-auth.guard';

function cfg(values: Record<string, string>): ConfigService {
  return { get: vi.fn((k: string, d?: unknown) => values[k] ?? d) } as unknown as ConfigService;
}

function mockJwt(verifyResult: unknown = { sub: 'admin-id', username: 'admin' }): JwtService {
  return {
    verifyAsync: vi.fn().mockResolvedValue(verifyResult),
  } as unknown as JwtService;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const ENABLED = { AUTH_ENABLED: 'true', JWT_SECRET: 'super-secret-key-at-least-32-chars!!' };

describe('JwtAuthGuard', () => {
  it('passes through everything when disabled (default)', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg({}));
    expect(await guard.canActivate(ctx({ path: '/api/v1/posts', method: 'GET', headers: {} }))).toBe(true);
  });

  it('is disabled (pass-through) when constructed without deps (esbuild paramtypes trap)', async () => {
    const guard = new JwtAuthGuard(undefined, undefined);
    expect(await guard.canActivate(ctx({ path: '/api/v1/posts', method: 'GET', headers: {} }))).toBe(true);
  });

  it('allows access with valid JWT in cookie', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    const req = { path: '/api/v1/posts', method: 'GET', headers: { cookie: 'spa_token=valid-jwt' } };
    expect(await guard.canActivate(ctx(req))).toBe(true);
    expect((req as any).user).toEqual({ sub: 'admin-id', username: 'admin' });
  });

  it('allows access with valid JWT in Authorization: Bearer header', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    expect(
      await guard.canActivate(
        ctx({ path: '/api/v1/posts', method: 'GET', headers: { authorization: 'Bearer valid-jwt' } }),
      ),
    ).toBe(true);
  });

  it('rejects when no token provided', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    await expect(
      guard.canActivate(ctx({ path: '/api/v1/posts', method: 'GET', headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when token is invalid/expired', async () => {
    const jwt = mockJwt();
    (jwt.verifyAsync as any).mockRejectedValue(new Error('expired'));
    const guard = new JwtAuthGuard(jwt, cfg(ENABLED));
    await expect(
      guard.canActivate(ctx({ path: '/api/v1/posts', method: 'GET', headers: { cookie: 'spa_token=bad' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('leaves /auth/login public even when enabled', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    expect(await guard.canActivate(ctx({ path: '/api/v1/auth/login', method: 'POST', headers: {} }))).toBe(true);
  });

  it('leaves /health public even when enabled', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    expect(await guard.canActivate(ctx({ path: '/api/v1/health', method: 'GET', headers: {} }))).toBe(true);
  });

  it('still gates /health/debug-sentry (not public)', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    await expect(
      guard.canActivate(ctx({ path: '/api/v1/health/debug-sentry', method: 'GET', headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when enabled but JWT_SECRET is empty', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg({ AUTH_ENABLED: 'true', JWT_SECRET: '' }));
    await expect(
      guard.canActivate(ctx({ path: '/api/v1/posts', method: 'GET', headers: { cookie: 'spa_token=anything' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('parses cookie correctly when other cookies are present', async () => {
    const guard = new JwtAuthGuard(mockJwt(), cfg(ENABLED));
    expect(
      await guard.canActivate(
        ctx({
          path: '/api/v1/posts',
          method: 'GET',
          headers: { cookie: 'other=val; spa_token=my-jwt; theme=dark' },
        }),
      ),
    ).toBe(true);
  });
});
