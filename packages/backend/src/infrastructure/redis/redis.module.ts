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

import {
  Inject,
  Injectable,
  Logger,
  Module,
  Global,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";

export const SHARED_REDIS = Symbol("SHARED_REDIS");
export const SHARED_REDIS_SUBSCRIBER = Symbol("SHARED_REDIS_SUBSCRIBER");
export const SHARED_REDIS_PUBLISHER = Symbol("SHARED_REDIS_PUBLISHER");

function createRedisClient(config: ConfigService, connectionName: string): IORedis {
  const url = config.get<string>("REDIS_URL", "redis://localhost:6381");
  const client = new IORedis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
    connectionName,
  });

  client.on("error", (err) => {
    Logger.error(
      `Redis ${connectionName} connection error: ${err.message}`,
      err.stack,
      "RedisModule",
    );
  });
  client.on("reconnecting", (delayMs: number) => {
    Logger.warn(`Redis ${connectionName} reconnecting in ${delayMs}ms`, "RedisModule");
  });

  return client;
}

@Injectable()
export class RedisLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycleService.name);

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    @Inject(SHARED_REDIS_SUBSCRIBER) private readonly subscriber: IORedis,
    @Inject(SHARED_REDIS_PUBLISHER) private readonly publisher: IORedis,
  ) {}

  onModuleInit(): void {
    // connection-level error listeners are registered in createRedisClient;
    // this hook is reserved for any additional startup diagnostics if needed.
    this.logger.log("Redis lifecycle service initialized");
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.redis.quit(), this.subscriber.quit(), this.publisher.quit()]);
    this.logger.log("Redis connections closed");
  }
}

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
      useFactory: (config: ConfigService) => createRedisClient(config, "shared"),
    },
    {
      provide: SHARED_REDIS_SUBSCRIBER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createRedisClient(config, "subscriber"),
    },
    {
      provide: SHARED_REDIS_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createRedisClient(config, "publisher"),
    },
    RedisLifecycleService,
  ],
  exports: [SHARED_REDIS, SHARED_REDIS_SUBSCRIBER, SHARED_REDIS_PUBLISHER, RedisLifecycleService],
})
export class RedisModule {}
