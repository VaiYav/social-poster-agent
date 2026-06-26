/**
 * MOD-07: Cross-Cutting Concerns — RedactInterceptor unit tests.
 *
 * Covers UTC-120 through UTC-125 (REQ-038, REQ-NF-005):
 *   UTC-120 — redacts 'password' field from response data
 *   UTC-121 — redacts all 8 sensitive keys; leaves safe fields unchanged
 *   UTC-122 — redacts nested sensitive fields in objects
 *   UTC-123 — redacts sensitive fields in arrays of objects
 *   UTC-124 — passes through data with no sensitive fields unchanged
 *   UTC-125 — handles null/undefined response data without error
 *
 * Hazards: HAZ-012 (sensitive data leakage in logs/responses)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { RedactInterceptor } from '../../src/infrastructure/logging/redact.interceptor';

describe('RedactInterceptor (MOD-07 — UTC-120..125)', () => {
  let interceptor: RedactInterceptor;

  beforeEach(() => {
    interceptor = new RedactInterceptor();
  });

  /** Builds a mock ExecutionContext + CallHandler pair. */
  function buildMockContextAndHandler(data: unknown): {
    context: ExecutionContext;
    next: CallHandler;
  } {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/v1/test' }),
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;

    const next = {
      handle: () => of(data),
    } as unknown as CallHandler;

    return { context, next };
  }

  it('UTC-120 — redacts the "password" field from response data (HAZ-012)', async () => {
    const input = { user: 'val', password: 'secret123' };
    const { context, next } = buildMockContextAndHandler(input);

    const result = await lastValueFrom(interceptor.intercept(context, next));

    expect(result).toEqual({ user: 'val', password: '[REDACTED]' });
  });

  it('UTC-121 — redacts all 8 sensitive keys and leaves safe fields unchanged (HAZ-012)', async () => {
    const input = {
      password: 'p',
      token: 't',
      authorization: 'a',
      storageState: 's',
      credentialsRef: 'c',
      cookie: 'co',
      secret: 'se',
      apiKey: 'ak',
      safe: 'ok',
    };
    const { context, next } = buildMockContextAndHandler(input);

    const result = (await lastValueFrom(interceptor.intercept(context, next))) as Record<
      string,
      unknown
    >;

    expect(result.password).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.storageState).toBe('[REDACTED]');
    expect(result.credentialsRef).toBe('[REDACTED]');
    expect(result.cookie).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.safe).toBe('ok');
  });

  it('UTC-122 — redacts nested sensitive fields in objects (HAZ-012)', async () => {
    const input = { config: { apiKey: 'key123', name: 'app' } };
    const { context, next } = buildMockContextAndHandler(input);

    const result = (await lastValueFrom(interceptor.intercept(context, next))) as {
      config: Record<string, unknown>;
    };

    expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.name).toBe('app');
  });

  it('UTC-123 — redacts sensitive fields in arrays of objects (HAZ-012)', async () => {
    const input = {
      sessions: [
        { id: '1', storageState: 'cookies' },
        { id: '2', storageState: 'cookies2' },
      ],
    };
    const { context, next } = buildMockContextAndHandler(input);

    const result = (await lastValueFrom(interceptor.intercept(context, next))) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].storageState).toBe('[REDACTED]');
    expect(result.sessions[0].id).toBe('1');
    expect(result.sessions[1].storageState).toBe('[REDACTED]');
    expect(result.sessions[1].id).toBe('2');
  });

  it('UTC-124 — passes through data with no sensitive fields unchanged', async () => {
    const input = { id: '1', content: 'hello', status: 'DRAFT' };
    const { context, next } = buildMockContextAndHandler(input);

    const result = await lastValueFrom(interceptor.intercept(context, next));

    expect(result).toEqual(input);
  });

  it('UTC-125 — handles null response data without error', async () => {
    const { context, next } = buildMockContextAndHandler(null);

    const result = await lastValueFrom(interceptor.intercept(context, next));

    expect(result).toBeNull();
  });
});
