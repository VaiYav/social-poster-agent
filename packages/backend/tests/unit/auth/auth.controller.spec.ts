/**
 * AuthController unit tests — login, logout, /me endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createControllerTestingModule } from '../../helpers/nest.js';
import { defineParamtypes } from '../../helpers/restore-paramtypes.js';
import { AuthController, COOKIE_NAME } from '../../../src/modules/auth/auth.controller';
import { AuthService } from '../../../src/modules/auth/auth.service';
import { LoginRateLimitGuard } from '../../../src/modules/auth/login-rate-limit.guard';
import { SHARED_REDIS } from '../../../src/infrastructure/redis/redis.module';
import { createMockRedis } from '../../mocks/index.js';

// vitest/esbuild does NOT emit design:paramtypes metadata, so attach it explicitly.
defineParamtypes(AuthController, [AuthService, ConfigService]);
defineParamtypes(LoginRateLimitGuard, [ConfigService, SHARED_REDIS]);

function mockConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === 'ADMIN_USERNAME') return values.ADMIN_USERNAME ?? 'admin';
      if (key === 'AUTH_ENABLED') return values.AUTH_ENABLED ?? fallback;
      if (key === 'NODE_ENV') return values.NODE_ENV ?? fallback;
      return fallback;
    }),
  } as unknown as ConfigService;
}

function mockAuthService(): AuthService {
  return {
    login: vi.fn().mockResolvedValue({
      token: 'mock-jwt',
      user: { id: 'admin-id', username: 'admin', role: 'admin' },
    }),
    getAdminById: vi.fn().mockResolvedValue({ id: 'admin-id', username: 'admin', role: 'admin' }),
  } as unknown as AuthService;
}

function mockResponse(): Record<string, unknown> & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> } {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Record<string, unknown> & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };
}

function mockRequest(user?: { sub: string; username: string }): Record<string, unknown> {
  return { user };
}

describe('AuthController', () => {
  let authService: ReturnType<typeof mockAuthService>;
  let configService: ConfigService;
  let controller: AuthController;

  beforeEach(async () => {
    authService = mockAuthService();
    configService = mockConfig({});
    const { controller: ctrl } = await createControllerTestingModule(AuthController, [
      { provide: AuthService, useValue: authService },
      { provide: ConfigService, useValue: configService },
      { provide: SHARED_REDIS, useValue: createMockRedis() },
    ]);
    controller = ctrl;
  });

  it('login() returns user and sets httpOnly cookie', async () => {
    const res = mockResponse();
    const result = await controller.login({ username: 'admin', password: 'secret' }, res as unknown as any);

    expect(authService.login).toHaveBeenCalledWith('admin', 'secret');
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'mock-jwt',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
    expect(result.user.username).toBe('admin');
  });

  it('logout() clears the auth cookie', async () => {
    const res = mockResponse();
    const result = await controller.logout(res as unknown as any);

    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, { path: '/' });
    expect(result.success).toBe(true);
  });

  it('me() returns default admin when AUTH_ENABLED=false', async () => {
    const { controller: ctrl } = await createControllerTestingModule(AuthController, [
      { provide: AuthService, useValue: authService },
      { provide: ConfigService, useValue: mockConfig({ AUTH_ENABLED: 'false' }) },
      { provide: SHARED_REDIS, useValue: createMockRedis() },
    ]);

    const result = await ctrl.me(mockRequest() as unknown as any);
    expect(result.user.username).toBe('admin');
    expect(result.user.role).toBe('admin');
  });

  it('me() throws Unauthorized when AUTH_ENABLED=true and no user', async () => {
    const { controller: ctrl } = await createControllerTestingModule(AuthController, [
      { provide: AuthService, useValue: authService },
      { provide: ConfigService, useValue: mockConfig({ AUTH_ENABLED: 'true' }) },
      { provide: SHARED_REDIS, useValue: createMockRedis() },
    ]);

    await expect(ctrl.me(mockRequest() as unknown as any)).rejects.toThrow(UnauthorizedException);
  });

  it('me() returns admin by id when AUTH_ENABLED=true and user is present', async () => {
    const { controller: ctrl } = await createControllerTestingModule(AuthController, [
      { provide: AuthService, useValue: authService },
      { provide: ConfigService, useValue: mockConfig({ AUTH_ENABLED: 'true' }) },
      { provide: SHARED_REDIS, useValue: createMockRedis() },
    ]);

    const result = await ctrl.me(mockRequest({ sub: 'admin-id', username: 'admin' }) as unknown as any);
    expect(authService.getAdminById).toHaveBeenCalledWith('admin-id');
    expect(result.user.username).toBe('admin');
  });
});
