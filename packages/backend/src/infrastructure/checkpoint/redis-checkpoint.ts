import { Injectable, Logger, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type ChannelVersions,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { SHARED_REDIS } from '../redis/redis.module.js';

/**
 * Redis checkpoint saver for LangGraph — persists workflow state to Redis.
 *
 * This enables:
 * - Resume after crash (B6 mitigation — LangGraph checkpoint in Redis)
 * - Human-in-the-loop: pause generation, operator reviews, resume
 * - Time travel: inspect intermediate states for debugging
 *
 * Storage format (Redis keys):
 * - spa:checkpoint:{thread_id} → latest checkpoint tuple (JSON)
 * - spa:checkpoint:{thread_id}:{checkpoint_id} → specific checkpoint
 * - spa:checkpoint:writes:{thread_id}:{checkpoint_id} → pending writes
 *
 * TTL: 7 days (env: CHECKPOINT_TTL_SECONDS)
 *
 * Sprint L: Uses shared Redis connection from RedisModule.
 */
@Injectable()
export class RedisCheckpointSaver
  extends BaseCheckpointSaver
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisCheckpointSaver.name);
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {
    super(); // BaseCheckpointSaver creates default JsonPlusSerializer
    this.ttlSeconds = this.configService.get<number>('CHECKPOINT_TTL_SECONDS', 604800); // 7 days
    this.prefix = this.configService.get<string>('CHECKPOINT_PREFIX', 'spa:checkpoint');
  }

  onModuleInit(): void {
    this.logger.log(`Redis checkpoint saver initialized (TTL=${this.ttlSeconds}s, shared connection)`);
  }

  onModuleDestroy(): void {
    // Sprint L: Redis connection is managed by RedisModule — don't close here
  }

  private getThreadKey(threadId: string, checkpointId?: string): string {
    return checkpointId
      ? `${this.prefix}:${threadId}:${checkpointId}`
      : `${this.prefix}:${threadId}`;
  }

  private getWritesKey(threadId: string, checkpointId: string): string {
    return `${this.prefix}:writes:${threadId}:${checkpointId}`;
  }

  /**
   * SCAN-based key collection — O(1) per cursor step, non-blocking.
   * Replaces KEYS which is O(N) and blocks Redis on large datasets.
   */
  private async scanKeys(pattern: string, count = 100): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (!this.redis) return undefined;

    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return undefined;

    const checkpointId = config.configurable?.checkpoint_id as string | undefined;

    if (checkpointId) {
      // Get specific checkpoint
      const data = await this.redis.get(this.getThreadKey(threadId, checkpointId));
      if (!data) return undefined;
      return JSON.parse(data) as CheckpointTuple;
    }

    // Get latest checkpoint for this thread — use the pointer key (no SCAN needed)
    const latestData = await this.redis.get(this.getThreadKey(threadId));
    if (latestData) {
      return JSON.parse(latestData) as CheckpointTuple;
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    if (!this.redis) return;

    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return;

    // SCAN instead of KEYS — non-blocking, cursor-based
    const keys = await this.scanKeys(`${this.prefix}:${threadId}:*`);
    const limit = options?.limit ?? 10;

    for (const key of keys.slice(0, limit)) {
      if (key === this.getThreadKey(threadId)) continue; // skip pointer
      const data = await this.redis.get(key);
      if (data) {
        yield JSON.parse(data) as CheckpointTuple;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (!this.redis) return config;

    const threadId = config.configurable?.thread_id as string;
    const checkpointId = checkpoint.id;

    const tuple: CheckpointTuple = {
      config: {
        ...config,
        configurable: {
          ...config.configurable,
          thread_id: threadId,
          checkpoint_id: checkpointId,
        },
      },
      checkpoint,
      metadata,
      parentConfig: config,
    };

    const key = this.getThreadKey(threadId, checkpointId);
    const data = JSON.stringify(tuple);

    // Store specific checkpoint
    await this.redis.set(key, data, 'EX', this.ttlSeconds);
    // Update latest pointer
    await this.redis.set(this.getThreadKey(threadId), data, 'EX', this.ttlSeconds);

    this.logger.debug(`Checkpoint saved: ${threadId}/${checkpointId}`);
    return tuple.config;
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (!this.redis) return;

    const threadId = config.configurable?.thread_id as string;
    const checkpointId = config.configurable?.checkpoint_id as string;
    if (!threadId || !checkpointId) return;

    const key = this.getWritesKey(threadId, checkpointId);
    const data = JSON.stringify({ taskId, writes });
    await this.redis.rpush(key, data);
    await this.redis.expire(key, this.ttlSeconds);
  }

  /**
   * Sprint I: List checkpoint keys for a thread — enables checkpoint inspection API.
   * Returns array of checkpoint IDs (sorted newest first).
   */
  async listKeysForThread(threadIdPrefix: string, limit = 10): Promise<string[]> {
    if (!this.redis) return [];
    // LangGraph stores checkpoints with thread_id = `${runId}:${topic}`.
    // We search for all keys matching the runId prefix using SCAN (non-blocking).
    const pattern = `${this.prefix}:${threadIdPrefix}:*`;
    const keys = await this.scanKeys(pattern);
    // Filter out the pointer keys and writes keys
    const checkpointKeys = keys.filter(
      (k) => !k.includes(':writes:') && k !== `${this.prefix}:${threadIdPrefix}`,
    );
    // Extract checkpoint IDs from keys: spa:checkpoint:{threadId}:{checkpointId}
    const checkpointIds = checkpointKeys.map((k) => {
      const parts = k.split(':');
      return parts[parts.length - 1] ?? k;
    });
    return checkpointIds.slice(0, limit);
  }
}
