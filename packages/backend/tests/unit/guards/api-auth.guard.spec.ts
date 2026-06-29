/**
 * ApiAuthGuard — global deny-by-default API key auth.
 *
 * Source: packages/backend/src/infrastructure/guards/api-auth.guard.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiAuthGuard } from '../../../src/infrastructure/guards/api-auth.guard';

function cfg(values: Record<string, string>): ConfigService {
  return { get: vi.fn((k: string, d?: unknown) => values[k] ?? d) } as unknown as ConfigService;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const ENABLED = { API_AUTH_ENABLED: 'true', API_KEY: 'secret-key' };

describe('ApiAuthGuard', () => {
  it('passes through everything when disabled (default)', () => {
    const guard = new ApiAuthGuard(cfg({}));
    expect(guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: {} }))).toBe(true);
  });

  it('allows a valid key via x-api-key header', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(
      guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: { 'x-api-key': 'secret-key' } })),
    ).toBe(true);
  });

  it('allows a valid key via Authorization: Bearer', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(
      guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: { authorization: 'Bearer secret-key' } })),
    ).toBe(true);
  });

  it('allows a valid key via ?api_key query param (for SSE/EventSource)', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(
      guard.canActivate(ctx({ path: '/api/v1/events/sse', method: 'GET', headers: {}, query: { api_key: 'secret-key' } })),
    ).toBe(true);
  });

  it('rejects a missing key', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(() => guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: {} }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong key', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(() =>
      guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: { 'x-api-key': 'nope' } })),
    ).toThrow(UnauthorizedException);
  });

  it('leaves liveness /health public even when enabled', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(guard.canActivate(ctx({ path: '/api/v1/health', method: 'GET', headers: {} }))).toBe(true);
  });

  it('still gates /health/debug-sentry (not public)', () => {
    const guard = new ApiAuthGuard(cfg(ENABLED));
    expect(() => guard.canActivate(ctx({ path: '/api/v1/health/debug-sentry', method: 'GET', headers: {} }))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when enabled but API_KEY is empty', () => {
    const guard = new ApiAuthGuard(cfg({ API_AUTH_ENABLED: 'true', API_KEY: '' }));
    expect(() =>
      guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: { 'x-api-key': 'anything' } })),
    ).toThrow(UnauthorizedException);
  });

  it('is disabled (pass-through) when constructed without a ConfigService (esbuild paramtypes trap)', () => {
    const guard = new ApiAuthGuard(undefined);
    expect(guard.canActivate(ctx({ path: '/api/v1/posting/p1', method: 'POST', headers: {} }))).toBe(true);
  });
});
