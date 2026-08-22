/**
 * B10 Graceful Shutdown tests — verify that all services with onModuleDestroy
 * properly clean up their resources when the application shuts down.
 *
 * The app uses `app.enableShutdownHooks()` in main.ts, which means NestJS
 * will call onModuleDestroy() on all providers when SIGTERM/SIGINT is received.
 *
 * Services tested:
 *   - QueueFactory: closes all BullMQ workers and queues
 *   - BrowserFactory: closes all pooled contexts and the browser
 *   - SseService: ends all SSE client connections, unsubscribes from Redis
 *   - PrismaService: disconnects from PostgreSQL
 *   - RateLimitService: no-op (Redis managed by RedisModule)
 *   - RedisCheckpointSaver: no-op (Redis managed by RedisModule)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { QueueFactory } from "../../../src/infrastructure/queue/queue.factory";
import { BrowserFactory } from "../../../src/infrastructure/browser/browser.factory";
import { SseService } from "../../../src/infrastructure/sse/sse.service";
import { PrismaService } from "../../../src/infrastructure/prisma/prisma.service";
import { RateLimitService } from "../../../src/modules/rate-limit/rate-limit.service";
import { RedisCheckpointSaver } from "../../../src/infrastructure/checkpoint/redis-checkpoint.js";

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    REDIS_URL: "redis://localhost:6382",
    BULLMQ_MAX_RETRIES: "3",
    BULLMQ_RETRY_DELAY_MS: "60000",
    BULLMQ_QUEUE_PREFIX: "spa",
    BULLMQ_CONCURRENCY_PER_QUEUE: "1",
    CAMOUFOX_HEADLESS: "true",
    CAMOUFOX_HUMANIZE: "true",
    CAMOUFOX_GEOIP: "true",
    CAMOUFOX_LOCALE: "en-US",
    CAMOUFOX_OS: "windows",
    SPA_SCREENSHOT_DIR: "/tmp/spa-screenshots",
    BROWSER_POOL_SIZE: 3,
    SSE_CHANNEL: "spa:sse",
    RATE_LIMIT_PREFIX: "spa:ratelimit",
    RATE_LIMIT_MIN_DELAY_MS: 300000,
    CHECKPOINT_TTL_SECONDS: 604800,
    CHECKPOINT_PREFIX: "spa:checkpoint",
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

// ── QueueFactory ──

describe("B10: QueueFactory graceful shutdown", () => {
  it("B10-QF-001: onModuleDestroy closes all workers", async () => {
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const queueClose = vi.fn().mockResolvedValue(undefined);
    const fakeWorker = { close: workerClose };
    const fakeQueue = { close: queueClose };

    const factory = new QueueFactory(createMockConfigService());
    (factory as any).workers.set("x:posting", fakeWorker);
    (factory as any).workers.set("threads:posting", fakeWorker);
    (factory as any).queues.set("x:posting", fakeQueue);
    (factory as any).queues.set("threads:posting", fakeQueue);

    await factory.onModuleDestroy();

    expect(workerClose).toHaveBeenCalledTimes(2);
    expect(queueClose).toHaveBeenCalledTimes(2);
  });

  it("B10-QF-002: onModuleDestroy handles empty workers/queues", async () => {
    const factory = new QueueFactory(createMockConfigService());

    await expect(factory.onModuleDestroy()).resolves.not.toThrow();
  });

  it("B10-QF-003: onModuleDestroy closes workers before queues", async () => {
    const callOrder: string[] = [];
    const workerClose = vi.fn().mockImplementation(async () => {
      callOrder.push("worker");
    });
    const queueClose = vi.fn().mockImplementation(async () => {
      callOrder.push("queue");
    });

    const factory = new QueueFactory(createMockConfigService());
    (factory as any).workers.set("test", { close: workerClose });
    (factory as any).queues.set("test", { close: queueClose });

    await factory.onModuleDestroy();

    // Workers should be closed first (await loop), then queues
    expect(callOrder).toEqual(["worker", "queue"]);
  });
});

// ── BrowserFactory ──

describe("B10: BrowserFactory graceful shutdown", () => {
  it("B10-BF-001: onModuleDestroy closes all idle contexts", async () => {
    const ctxClose = vi.fn().mockResolvedValue(undefined);
    const fakeCtx = { close: ctxClose };

    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).idleContexts.set("X", [
      { context: fakeCtx, releasedAt: Date.now() },
      { context: fakeCtx, releasedAt: Date.now() },
    ]);
    (factory as any).idleContexts.set("THREADS", [{ context: fakeCtx, releasedAt: Date.now() }]);

    await factory.onModuleDestroy();

    expect(ctxClose).toHaveBeenCalledTimes(3);
  });

  it("B10-BF-002: onModuleDestroy closes all in-use contexts", async () => {
    const ctxClose = vi.fn().mockResolvedValue(undefined);
    const fakeCtx = { close: ctxClose };

    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).inUseContexts.set("X", new Set([fakeCtx]));

    await factory.onModuleDestroy();

    expect(ctxClose).toHaveBeenCalledTimes(1);
  });

  it("B10-BF-003: onModuleDestroy closes the browser", async () => {
    const browserClose = vi.fn().mockResolvedValue(undefined);
    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).browser = { close: browserClose };

    await factory.onModuleDestroy();

    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("B10-BF-004: onModuleDestroy handles context close errors gracefully", async () => {
    const ctxClose = vi.fn().mockRejectedValue(new Error("already closed"));
    const fakeCtx = { close: ctxClose };

    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).idleContexts.set("X", [{ context: fakeCtx, releasedAt: Date.now() }]);

    // Should not throw — errors are caught with .catch(() => {})
    await expect(factory.onModuleDestroy()).resolves.not.toThrow();
  });

  it("B10-BF-005: onModuleDestroy clears context maps", async () => {
    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).idleContexts.set("X", [
      { context: { close: vi.fn().mockResolvedValue(undefined) }, releasedAt: Date.now() },
    ]);
    (factory as any).inUseContexts.set(
      "X",
      new Set([{ close: vi.fn().mockResolvedValue(undefined) }]),
    );

    await factory.onModuleDestroy();

    expect((factory as any).idleContexts.size).toBe(0);
    expect((factory as any).inUseContexts.size).toBe(0);
  });

  it("B10-BF-006: onModuleDestroy handles no browser (null)", async () => {
    const factory = new BrowserFactory(createMockConfigService());
    (factory as any).browser = null;

    await expect(factory.onModuleDestroy()).resolves.not.toThrow();
  });
});

// ── SseService ──

describe("B10: SseService graceful shutdown", () => {
  function createSseService(redis: any = null, publisher: any = null) {
    return new SseService(createMockConfigService(), redis, publisher);
  }

  it("B10-SSE-001: onModuleDestroy ends all SSE client connections", () => {
    const resEnd = vi.fn();
    const fakeRes1 = { end: resEnd };
    const fakeRes2 = { end: resEnd };

    const redis = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    const service = createSseService(redis, { publish: vi.fn() });
    (service as any).clients.set("client-1", fakeRes1);
    (service as any).clients.set("client-2", fakeRes2);

    service.onModuleDestroy();

    expect(resEnd).toHaveBeenCalledTimes(2);
  });

  it("B10-SSE-002: onModuleDestroy clears clients map", () => {
    const service = createSseService(
      { unsubscribe: vi.fn().mockResolvedValue(undefined) },
      { publish: vi.fn() },
    );
    (service as any).clients.set("client-1", { end: vi.fn() });

    service.onModuleDestroy();

    expect((service as any).clients.size).toBe(0);
  });

  it("B10-SSE-003: onModuleDestroy unsubscribes from Redis channel", () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const service = createSseService({ unsubscribe }, { publish: vi.fn() });

    service.onModuleDestroy();

    expect(unsubscribe).toHaveBeenCalledWith("spa:sse");
  });

  it("B10-SSE-004: onModuleDestroy handles res.end() errors gracefully", () => {
    const service = createSseService(
      { unsubscribe: vi.fn().mockResolvedValue(undefined) },
      { publish: vi.fn() },
    );
    (service as any).clients.set("client-1", {
      end: vi.fn().mockImplementation(() => {
        throw new Error("already closed");
      }),
    });

    // Should not throw
    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it("B10-SSE-005: onModuleDestroy handles no clients", () => {
    const service = createSseService(
      { unsubscribe: vi.fn().mockResolvedValue(undefined) },
      { publish: vi.fn() },
    );

    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it("B10-SSE-006: onModuleDestroy handles null redis (optional chaining)", () => {
    const service = createSseService(null, { publish: vi.fn() });

    // redis?.unsubscribe() — optional chaining, should not throw
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});

// ── PrismaService ──

describe("B10: PrismaService graceful shutdown", () => {
  it("B10-PRISMA-001: onModuleDestroy calls $disconnect", async () => {
    const service = new PrismaService(createMockConfigService());
    const disconnectSpy = vi.spyOn(service, "$disconnect").mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    disconnectSpy.mockRestore();
  });
});

// ── RateLimitService ──

describe("B10: RateLimitService graceful shutdown", () => {
  it("B10-RL-001: onModuleDestroy is a no-op (Redis managed by RedisModule)", () => {
    const service = new RateLimitService(createMockConfigService(), {} as any);

    // Should not throw and should not close any Redis connections
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});

// ── RedisCheckpointSaver ──

describe("B10: RedisCheckpointSaver graceful shutdown", () => {
  it("B10-RC-001: onModuleDestroy is a no-op (Redis managed by RedisModule)", () => {
    const service = new RedisCheckpointSaver(createMockConfigService(), {} as any);

    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});

// ── Integration: shutdown order ──

describe("B10: Graceful shutdown integration — all services shut down", () => {
  it("B10-INT-001: All services can be shut down in sequence without errors", async () => {
    const queueFactory = new QueueFactory(createMockConfigService());
    const browserFactory = new BrowserFactory(createMockConfigService());
    const sseService = new SseService(
      createMockConfigService(),
      { unsubscribe: vi.fn().mockResolvedValue(undefined) },
      { publish: vi.fn() },
    );
    const prismaService = new PrismaService(createMockConfigService());
    vi.spyOn(prismaService, "$disconnect").mockResolvedValue(undefined);

    await expect(
      Promise.all([
        queueFactory.onModuleDestroy(),
        browserFactory.onModuleDestroy(),
        sseService.onModuleDestroy(),
        prismaService.onModuleDestroy(),
      ]),
    ).resolves.not.toThrow();
  });

  it("B10-INT-002: SSE clients are disconnected before Redis unsubscribe", () => {
    const callOrder: string[] = [];
    const resEnd = vi.fn().mockImplementation(() => callOrder.push("res.end"));

    const service = new SseService(
      createMockConfigService(),
      {
        unsubscribe: vi.fn().mockImplementation(async () => callOrder.push("unsubscribe")),
      },
      { publish: vi.fn() },
    );
    (service as any).clients.set("client-1", { end: resEnd });

    service.onModuleDestroy();

    // res.end() is called synchronously in the loop, unsubscribe is async
    expect(callOrder[0]).toBe("res.end");
  });
});
