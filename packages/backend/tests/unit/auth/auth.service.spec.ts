/**
 * AuthService unit tests — login, bootstrap, password hashing (scrypt).
 *
 * Source: packages/backend/src/modules/auth/auth.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../../src/modules/auth/auth.service';

function cfg(values: Record<string, string>): ConfigService {
  return { get: vi.fn((k: string, d?: unknown) => values[k] ?? d) } as unknown as ConfigService;
}

function mockJwt(): JwtService {
  return {
    signAsync: vi.fn().mockResolvedValue('mock-jwt-token'),
    verifyAsync: vi.fn().mockResolvedValue({ sub: 'admin-id', username: 'admin' }),
  } as unknown as JwtService;
}

function mockPrisma(adminRow: { id: string; username: string; passwordHash: string } | null) {
  return {
    admin: {
      findUnique: vi.fn().mockResolvedValue(adminRow),
      create: vi.fn().mockResolvedValue({ id: 'new-id', username: 'admin' }),
      update: vi.fn().mockResolvedValue({ id: 'admin-id', username: 'admin' }),
    },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof mockPrisma>;
  let jwt: JwtService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createService(
    configValues: Record<string, string> = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test123' },
    adminRow: { id: string; username: string; passwordHash: string } | null = null,
  ): AuthService {
    prisma = mockPrisma(adminRow);
    jwt = mockJwt();
    service = new AuthService(prisma as any, jwt, cfg(configValues));
    return service;
  }

  // ── Password hashing ──────────────────────────────────────────

  it('hashPassword produces a salt:hash string that differs per call', () => {
    createService();
    const h1 = service.hashPassword('password');
    const h2 = service.hashPassword('password');
    expect(h1).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    expect(h1).not.toBe(h2); // different salts
  });

  it('verifyPassword returns true for correct password', () => {
    createService();
    const hash = service.hashPassword('my-secret');
    expect(service.verifyPassword('my-secret', hash)).toBe(true);
  });

  it('verifyPassword returns false for wrong password', () => {
    createService();
    const hash = service.hashPassword('correct');
    expect(service.verifyPassword('wrong', hash)).toBe(false);
  });

  it('verifyPassword returns false for malformed hash', () => {
    createService();
    expect(service.verifyPassword('pw', 'not-a-valid-hash')).toBe(false);
    expect(service.verifyPassword('pw', '')).toBe(false);
    expect(service.verifyPassword('pw', 'onlyonepart')).toBe(false);
  });

  // ── Login ─────────────────────────────────────────────────────

  it('login succeeds with correct credentials and returns token + user', async () => {
    const hash = require('node:crypto').scryptSync; // use real scrypt via service
    createService(
      { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '' }, // skip bootstrap
      { id: 'admin-1', username: 'admin', passwordHash: service.hashPassword('test123') },
    );
    // Recreate with the hash we just generated
    prisma.admin.findUnique.mockResolvedValue({ id: 'admin-1', username: 'admin', passwordHash: service.hashPassword('test123') });

    const result = await service.login('admin', 'test123');
    expect(result.token).toBe('mock-jwt-token');
    expect(result.user).toEqual({ id: 'admin-1', username: 'admin', role: 'admin' });
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'admin-1', username: 'admin', role: 'admin' });
  });

  it('login throws UnauthorizedException for wrong password', async () => {
    createService(
      { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '' },
      { id: 'admin-1', username: 'admin', passwordHash: service.hashPassword('correct') },
    );
    prisma.admin.findUnique.mockResolvedValue({ id: 'admin-1', username: 'admin', passwordHash: service.hashPassword('correct') });

    await expect(service.login('admin', 'wrong')).rejects.toThrow(UnauthorizedException);
  });

  it('login throws UnauthorizedException for non-existent user', async () => {
    createService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '' });
    prisma.admin.findUnique.mockResolvedValue(null);

    await expect(service.login('nobody', 'pw')).rejects.toThrow(UnauthorizedException);
  });

  // ── Bootstrap ─────────────────────────────────────────────────

  it('bootstrap creates admin if not exists and ADMIN_PASSWORD is set', async () => {
    createService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret123' });
    prisma.admin.findUnique.mockResolvedValue(null);

    await service.onModuleInit();

    expect(prisma.admin.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ username: 'admin', passwordHash: expect.any(String) }),
    });
  });

  it('bootstrap updates password if env password differs from stored hash', async () => {
    createService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'newpass' });
    const oldHash = service.hashPassword('oldpass');
    prisma.admin.findUnique.mockResolvedValue({ id: 'a1', username: 'admin', passwordHash: oldHash });

    await service.onModuleInit();

    expect(prisma.admin.update).toHaveBeenCalledWith({
      where: { username: 'admin' },
      data: { passwordHash: expect.any(String) },
    });
  });

  it('bootstrap skips when ADMIN_PASSWORD is empty', async () => {
    createService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '' });

    await service.onModuleInit();

    expect(prisma.admin.findUnique).not.toHaveBeenCalled();
    expect(prisma.admin.create).not.toHaveBeenCalled();
  });

  it('bootstrap does not update if env password matches stored hash', async () => {
    createService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'samepass' });
    const matchingHash = service.hashPassword('samepass');
    prisma.admin.findUnique.mockResolvedValue({ id: 'a1', username: 'admin', passwordHash: matchingHash });

    await service.onModuleInit();

    expect(prisma.admin.update).not.toHaveBeenCalled();
  });

  // ── verifyToken ───────────────────────────────────────────────

  it('verifyToken returns payload for valid token', async () => {
    createService();
    const payload = await service.verifyToken('valid-token');
    expect(payload).toEqual({ sub: 'admin-id', username: 'admin' });
  });

  it('verifyToken returns null for invalid token', async () => {
    createService();
    (jwt.verifyAsync as any).mockRejectedValue(new Error('invalid'));
    const payload = await service.verifyToken('bad-token');
    expect(payload).toBeNull();
  });
});
