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
  type CheckpointPendingWrite,
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
 * TTL: 1 hour (env: CHECKPOINT_TTL_SECONDS). Crash-resume/pause is usually
 * handled within minutes; longer manual resume can be tuned with the env var.
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
  private readonly redis: IORedis;
  private readonly ownsConnection: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly sharedRedis: IORedis,
  ) {
    super(); // BaseCheckpointSaver creates default JsonPlusSerializer
    this.ttlSeconds = this.configService.get<number>('CHECKPOINT_TTL_SECONDS', 3600); // 1 hour
    this.prefix = this.configService.get<string>('CHECKPOINT_PREFIX', 'spa:checkpoint');

    const checkpointUrl = this.configService.get<string>('CHECKPOINT_REDIS_URL');
    if (checkpointUrl && checkpointUrl !== this.configService.get<string>('REDIS_URL')) {
      this.redis = this.createCheckpointRedis(checkpointUrl);
      this.ownsConnection = true;
      this.logger.log(`Using dedicated checkpoint Redis: ${checkpointUrl.replace(/:\/\/.*@/, '://***@')}`);
    } else {
      this.redis = this.sharedRedis;
      this.ownsConnection = false;
    }
  }

  onModuleInit(): void {
    this.logger.log(`Redis checkpoint saver initialized (TTL=${this.ttlSeconds}s, ${this.ownsConnection ? 'dedicated' : 'shared'} connection)`);
  }

  onModuleDestroy(): void {
    // Sprint L: only close the dedicated checkpoint connection; the shared
    // connection is managed by RedisModule.
    if (this.ownsConnection && this.redis) {
      this.redis.quit().catch(() => void 0);
    }
  }

  private createCheckpointRedis(url: string): IORedis {
    const client = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      connectionName: 'checkpoint',
    });
    client.on('error', (err) => this.logger.error(`Checkpoint Redis error: ${err.message}`));
    client.on('reconnecting', (delayMs: number) => this.logger.warn(`Checkpoint Redis reconnecting in ${delayMs}ms`));
    return client;
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
      const tuple = JSON.parse(data) as CheckpointTuple;
      // BUG-9: attach persisted pending writes so a resume does NOT re-execute a
      // task whose writes were already recorded (which would duplicate its side
      // effects, e.g. a node that persisted a post).
      tuple.pendingWrites = await this.loadPendingWrites(threadId, checkpointId);
      return tuple;
    }

    // Get latest checkpoint for this thread — use the pointer key (no SCAN needed)
    const latestData = await this.redis.get(this.getThreadKey(threadId));
    if (latestData) {
      const tuple = JSON.parse(latestData) as CheckpointTuple;
      // BUG-9: same — the latest pointer must also carry its pending writes.
      const latestId =
        (tuple.config?.configurable?.checkpoint_id as string | undefined) ?? tuple.checkpoint?.id;
      if (latestId) {
        tuple.pendingWrites = await this.loadPendingWrites(threadId, latestId);
      }
      return tuple;
    }

    return undefined;
  }

  /**
   * BUG-9: load the pending writes recorded by putWrites() for a checkpoint and
   * flatten them to LangGraph's `[taskId, channel, value]` shape so `getTuple`
   * can return them. Malformed entries are skipped, never thrown.
   */
  private async loadPendingWrites(
    threadId: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    if (!this.redis) return [];
    const entries = await this.redis.lrange(this.getWritesKey(threadId, checkpointId), 0, -1);
    const pending: CheckpointPendingWrite[] = [];
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(entry) as { taskId: string; writes: PendingWrite[] };
        for (const [channel, value] of parsed.writes) {
          pending.push([parsed.taskId, channel, value]);
        }
      } catch {
        // skip a malformed write entry rather than failing the whole resume
      }
    }
    return pending;
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
    _newVersions: ChannelVersions,
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

    // Shallow-saver cleanup: keep only the latest checkpoint and its writes per thread.
    // This prevents the orchestrator from accumulating one checkpoint per cycle
    // and the Redis keyspace from growing unbounded.
    await this.cleanupOldThreadCheckpoints(threadId, checkpointId);

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
   * Shallow-saver cleanup: after a new checkpoint is written, remove all older
   * checkpoint and pending-write keys for the same thread. Keeps the latest
   * pointer (`prefix:threadId`), the current checkpoint blob, and the current
   * writes list. Uses SCAN + UNLINK in batches so it is non-blocking on Redis.
   */
  private async cleanupOldThreadCheckpoints(
    threadId: string,
    currentCheckpointId: string,
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const pointerKey = this.getThreadKey(threadId);
      const currentKey = this.getThreadKey(threadId, currentCheckpointId);
      const currentWritesKey = this.getWritesKey(threadId, currentCheckpointId);

      const toDelete: string[] = [];

      const checkpointKeys = await this.scanKeys(`${this.prefix}:${threadId}:*`, 1000);
      for (const key of checkpointKeys) {
        if (key !== pointerKey && key !== currentKey) {
          toDelete.push(key);
        }
      }

      const writesKeys = await this.scanKeys(`${this.prefix}:writes:${threadId}:*`, 1000);
      for (const key of writesKeys) {
        if (key !== currentWritesKey) {
          toDelete.push(key);
        }
      }

      if (toDelete.length === 0) return;

      const batchSize = 5000;
      for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize);
        await this.redis.unlink(...batch);
      }

      this.logger.debug(
        `Cleaned up ${toDelete.length} old checkpoint key(s) for thread ${threadId}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to cleanup old checkpoints for thread ${threadId}: ${(err as Error).message}`,
      );
    }
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

  /**
   * Delete all checkpoint keys for a completed generation run.
   * LangGraph thread_id for generation is `${runId}:${topic}`, so all run keys
   * match `prefix:{runId}:*` and `prefix:writes:{runId}:*`.
   *
   * Uses UNLINK (non-blocking) and ignores errors — cleanup is best-effort.
   * Do NOT call this for failed or paused runs; the checkpoint may be needed for resume.
   */
  async deleteRunCheckpoints(runId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const patterns = [
        `${this.prefix}:${runId}`,
        `${this.prefix}:${runId}:*`,
        `${this.prefix}:writes:${runId}:*`,
      ];
      const keys: string[] = [];
      for (const pattern of patterns) {
        keys.push(...(await this.scanKeys(pattern)));
      }
      if (keys.length === 0) return;
      await this.redis.unlink(...keys);
      this.logger.log(`Deleted ${keys.length} checkpoint key(s) for run ${runId}`);
    } catch (err) {
      this.logger.warn(`Failed to delete checkpoints for run ${runId}: ${(err as Error).message}`);
    }
  }
}
