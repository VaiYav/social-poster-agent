/**
 * MOD-07: Cross-Cutting Concerns — HealthController unit tests.
 *
 * Covers UTC-115 through UTC-119 (REQ-036):
 *   UTC-115 — ok response (both DB + Redis connected)
 *   UTC-116 — degraded response (DB down)
 *   UTC-117 — degraded response (Redis down)
 *   UTC-118 — degraded response (both DB + Redis down)
 *   UTC-119 — valid ISO-8601 timestamp
 *
 * Hazards: HAZ-010 (DB down), HAZ-011 (Redis down)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createMockPrismaService } from '../mocks/index';
import { createControllerTestingModule } from '../helpers/nest';
import { defineParamtypes } from '../helpers/restore-paramtypes';
import { HealthController } from '../../src/modules/health/health.controller';
import { AdminGuard } from '../../src/modules/auth/admin.guard';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { SHARED_REDIS } from '../../src/infrastructure/redis/redis.module';

// vitest transpiles via esbuild which does NOT emit `design:paramtypes` metadata,
// so NestJS DI-by-type fails. We attach it explicitly to the controller class.
defineParamtypes(HealthController, [PrismaService, Object, ConfigService]);

// Sprint L: Redis is now injected via SHARED_REDIS token instead of created locally.
// Mock the shared Redis instance.
const { mockRedisInstance } = vi.hoisted(() => ({
  mockRedisInstance: { ping: vi.fn() },
}));

describe('HealthController (MOD-07 — UTC-115..119)', () => {
  let prismaMock: ReturnType<typeof createMockPrismaService>;
  let configService: Record<string, unknown>;
  let controller: HealthController;

  beforeEach(async () => {
    prismaMock = createMockPrismaService();
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    configService = {
      get: vi.fn((key: string, fallback?: string) => {
        if (key === 'REDIS_URL') return 'redis://localhost:6381';
        return fallback;
      }),
    };

    // Fresh redis ping mock per test
    mockRedisInstance.ping = vi.fn().mockResolvedValue('PONG');

    const { controller: ctrl } = await createControllerTestingModule(HealthController, [
      { provide: PrismaService, useValue: prismaMock },
      { provide: ConfigService, useValue: configService },
      { provide: SHARED_REDIS, useValue: mockRedisInstance },
      AdminGuard,
    ]);
    controller = ctrl;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('UTC-115 — returns status "ok" when both DB and Redis are connected', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('connected');
    expect(result.redis).toBe('connected');
    expect(prismaMock.$queryRaw).toHaveBeenCalledOnce();
    expect(mockRedisInstance.ping).toHaveBeenCalledOnce();
  });

  it('UTC-116 — returns status "degraded" when DB is disconnected (HAZ-010)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB down'));
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('disconnected');
    expect(result.redis).toBe('connected');
  });

  it('UTC-117 — returns status "degraded" when Redis is disconnected (HAZ-011)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockRejectedValue(new Error('Redis down'));

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('connected');
    expect(result.redis).toBe('disconnected');
  });

  it('UTC-118 — returns status "degraded" when both DB and Redis are down (HAZ-010)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB down'));
    mockRedisInstance.ping.mockRejectedValue(new Error('Redis down'));

    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('disconnected');
    expect(result.redis).toBe('disconnected');
  });

  it('UTC-119 — returns a valid ISO-8601 timestamp when both healthy', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const result = await controller.check();

    expect(result.timestamp).toBeDefined();
    expect(typeof result.timestamp).toBe('string');
    // Date.parse returns NaN for invalid date strings
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});
