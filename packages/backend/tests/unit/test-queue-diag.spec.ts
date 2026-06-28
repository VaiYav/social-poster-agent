import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueModule } from '../../src/modules/queue/queue.module';
import { RedisModule } from '../../src/infrastructure/redis/redis.module';
import { NotificationsModule } from '../../src/infrastructure/notifications/notifications.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { ModuleRef } from '@nestjs/core';
import { PostingService } from '../../src/modules/posting/posting.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';

// Restore design:paramtypes metadata (esbuild doesn't emit it)
const defineParamtypes = (target: unknown, types: unknown[]) => Reflect.defineMetadata('design:paramtypes', types, target);
defineParamtypes(SseService, [ConfigService, Object, Object]);
defineParamtypes(QueueFactory, [ConfigService, DiscordNotificationService]);
defineParamtypes(DiscordNotificationService, [ConfigService]);
defineParamtypes(QueueModule, [QueueFactory, PostingService, ModuleRef, ConfigService]);
defineParamtypes(SessionsService, [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService]);
defineParamtypes(AccountsService, [PrismaService, ConfigService, WarmupService]);
defineParamtypes(EncryptionService, [ConfigService]);
defineParamtypes(WarmupService, [PrismaService, ConfigService]);
defineParamtypes(RateLimitService, [ConfigService, Object]);
defineParamtypes(PostingService, [Object, AccountsService, SessionsService, WarmupService, Object, RateLimitService, SseService, ThreadProgressService, XPoster, ThreadsPoster, FacebookPoster, Object]);
defineParamtypes(ThreadProgressService, [PrismaService]);
defineParamtypes(BrowserFactory, [ConfigService]);
defineParamtypes(XPoster, [Object]);
defineParamtypes(ThreadsPoster, [Object]);
defineParamtypes(FacebookPoster, [Object, ConfigService]);

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string | string[]>();
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
      del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
      keys: vi.fn(async (p: string) => Array.from(store.keys()).filter(k => k.startsWith(p.replace('*','')))),
      hget: vi.fn(async () => null),
      hset: vi.fn(async () => 1),
      hgetall: vi.fn(async () => ({})),
      hdel: vi.fn(async () => 1),
      ping: vi.fn(async () => 'PONG'),
      disconnect: vi.fn(),
      on: vi.fn(),
    })),
  };
});

// Mock bullmq
vi.mock('bullmq', () => {
  const Queue = vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    getJob: vi.fn().mockResolvedValue(null),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0, completed: 0, failed: 0 }),
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  }));
  const Worker = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  }));
  return { Queue, Worker };
});

describe('QueueModule DI diagnostic', () => {
  it('QueueModule should get ConfigService injected', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RedisModule,
        NotificationsModule,
        EventEmitterModule.forRoot(),
        QueueModule,
      ],
    })
      .overrideProvider(PostingService)
      .useValue({ postById: vi.fn() })
      .compile();

    const cs = ref.get(ConfigService);
    expect(cs).toBeDefined();
    expect(typeof cs.get).toBe('function');
  });
});
