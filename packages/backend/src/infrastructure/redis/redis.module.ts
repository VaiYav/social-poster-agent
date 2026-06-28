// Sprint L: Shared Redis module — provides a single pooled Redis connection
// that all services share, instead of each service creating its own connection.
//
// Benefits:
//   - Fewer TCP connections to Redis (connection pooling)
//   - Centralized connection management and error handling
//   - Consistent configuration (maxRetries, lazyConnect, etc.)
//   - Easier to mock in tests (inject SHARED_REDIS token)
//
// Services that need Redis should inject @Inject(SHARED_REDIS) instead of
// creating `new IORedis(...)`. For pub/sub patterns that need separate
// subscriber/publisher connections, use SHARED_REDIS_SUBSCRIBER and
// SHARED_REDIS_PUBLISHER.

import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const SHARED_REDIS = Symbol('SHARED_REDIS');
export const SHARED_REDIS_SUBSCRIBER = Symbol('SHARED_REDIS_SUBSCRIBER');
export const SHARED_REDIS_PUBLISHER = Symbol('SHARED_REDIS_PUBLISHER');

/**
 * Shared Redis connection factory — creates and manages pooled Redis connections.
 *
 * Provides three connections:
 *   1. SHARED_REDIS — general purpose (commands, checkpointing, rate limiting)
 *   2. SHARED_REDIS_SUBSCRIBER — pub/sub subscriber (SSE events)
 *   3. SHARED_REDIS_PUBLISHER — pub/sub publisher (SSE events)
 *
 * Redis requires separate connections for pub/sub because once a connection
 * enters subscriber mode, it can only send SUBSCRIBE/UNSUBSCRIBE commands.
 *
 * Note: ioredis handles reconnection automatically. Connections are created
 * with lazyConnect: true to avoid blocking module initialization if Redis
 * is unavailable. The first command will trigger connection.
 */
@Global()
@Module({
  providers: [
    {
      provide: SHARED_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6381');
        return new IORedis(url, {
          maxRetriesPerRequest: null,
          lazyConnect: true,
          retryStrategy: (times: number) => Math.min(times * 500, 5000),
        });
      },
    },
    {
      provide: SHARED_REDIS_SUBSCRIBER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6381');
        return new IORedis(url, {
          maxRetriesPerRequest: null,
          lazyConnect: true,
          retryStrategy: (times: number) => Math.min(times * 500, 5000),
        });
      },
    },
    {
      provide: SHARED_REDIS_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6381');
        return new IORedis(url, {
          maxRetriesPerRequest: null,
          lazyConnect: true,
          retryStrategy: (times: number) => Math.min(times * 500, 5000),
        });
      },
    },
  ],
  exports: [SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER],
})
export class RedisModule {}
