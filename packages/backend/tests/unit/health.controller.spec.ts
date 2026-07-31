/**
 * MOD-07: Cross-Cutting Concerns — HealthController unit tests.
 *
 * Covers UTC-115 through UTC-120 (REQ-036):
 *   UTC-115 — ok response (all dependencies connected)
 *   UTC-116 — degraded response (DB down)
 *   UTC-117 — degraded response (Redis down)
 *   UTC-118 — degraded response (both DB + Redis down)
 *   UTC-119 — valid ISO-8601 timestamp
 *   UTC-120 — degraded response (BullMQ queue down)
 *
 * Hazards: HAZ-010 (DB down), HAZ-011 (Redis down)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createMockPrismaService } from '../mocks/index.js';
import { createControllerTestingModule } from '../helpers/nest.js';
import { defineParamtypes } from '../helpers/restore-paramtypes.js';
import { HealthController } from '../../src/modules/health/health.controller';
import { AdminGuard } from '../../src/modules/auth/admin.guard';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { SHARED_REDIS } from '../../src/infrastructure/redis/redis.module';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';

// vitest transpiles via esbuild which does NOT emit `design:paramtypes` metadata,
// so NestJS DI-by-type fails. We attach it explicitly to the controller class.
defineParamtypes(HealthController, [PrismaService, Object, ConfigService, QueueFactory]);

// Sprint L: Redis is now injected via SHARED_REDIS token instead of created locally.
// Mock the shared Redis instance.
const { mockRedisInstance, mockQueueFactory } = vi.hoisted(() => ({
  mockRedisInstance: { ping: vi.fn() },
  mockQueueFactory: { getJobCounts: vi.fn() },
}));

function mockResponse() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json, data: null as unknown };
}

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
    mockQueueFactory.getJobCounts = vi.fn().mockResolvedValue({});

    const { controller: ctrl } = await createControllerTestingModule(HealthController, [
      { provide: PrismaService, useValue: prismaMock },
      { provide: ConfigService, useValue: configService },
      { provide: SHARED_REDIS, useValue: mockRedisInstance },
      { provide: QueueFactory, useValue: mockQueueFactory },
      AdminGuard,
    ]);
    controller = ctrl;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('UTC-115 — /health/ready returns status "ok" (200) when all dependencies are connected', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const res = mockResponse();
    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('connected');
    expect(body.queue).toBe('connected');
    expect(prismaMock.$queryRaw).toHaveBeenCalledOnce();
    expect(mockRedisInstance.ping).toHaveBeenCalledOnce();
    expect(mockQueueFactory.getJobCounts).toHaveBeenCalledWith('x', 'posting');
  });

  it('UTC-116 — /health/ready returns 503 "degraded" when DB is disconnected (HAZ-010)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB down'));
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const res = mockResponse();
    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');
    expect(body.redis).toBe('connected');
    expect(body.queue).toBe('connected');
  });

  it('UTC-117 — /health/ready returns 503 "degraded" when Redis is disconnected (HAZ-011)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockRejectedValue(new Error('Redis down'));

    const res = mockResponse();
    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('disconnected');
    expect(body.queue).toBe('connected');
  });

  it('UTC-118 — /health/ready returns 503 "degraded" when both DB and Redis are down (HAZ-010)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB down'));
    mockRedisInstance.ping.mockRejectedValue(new Error('Redis down'));

    const res = mockResponse();
    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('disconnected');
    expect(body.redis).toBe('disconnected');
    expect(body.queue).toBe('connected');
  });

  it('UTC-120 — /health/ready returns 503 "degraded" when BullMQ queue is unavailable', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockResolvedValue('PONG');
    mockQueueFactory.getJobCounts.mockRejectedValue(new Error('queue down'));

    const res = mockResponse();
    await controller.ready(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('connected');
    expect(body.queue).toBe('disconnected');
  });

  it('UTC-119 — /health/ready returns a valid ISO-8601 timestamp when healthy', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisInstance.ping.mockResolvedValue('PONG');

    const res = mockResponse();
    await controller.ready(res as any);

    const body = res.json.mock.calls[0][0];
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');
    // Date.parse returns NaN for invalid date strings
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('/health/live always returns 200', () => {
    const res = mockResponse();
    controller.live(res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});
