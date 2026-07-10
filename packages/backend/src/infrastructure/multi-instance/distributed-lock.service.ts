import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { SHARED_REDIS } from '../redis/redis.module.js';

export const DISTRIBUTED_LOCK_SERVICE = Symbol('DISTRIBUTED_LOCK_SERVICE');

export interface DistributedLock {
  release(): Promise<void>;
  extend(ttlMs: number): Promise<boolean>;
}

const RELEASE_SCRIPT = `
  local val = redis.call('get', KEYS[1])
  if val == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;

const EXTEND_SCRIPT = `
  local val = redis.call('get', KEYS[1])
  if val == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  else
    return 0
  end
`;

class RedisLock implements DistributedLock {
  private readonly logger = new Logger(RedisLock.name);

  constructor(
    private readonly redis: IORedis,
    private readonly key: string,
    private readonly token: string,
    private readonly onRelease?: () => void,
  ) {}

  async release(): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.token);
    } catch (err) {
      this.logger.warn(`Failed to release lock ${this.key}: ${(err as Error).message}`);
    } finally {
      this.onRelease?.();
    }
  }

  async extend(ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(EXTEND_SCRIPT, 1, this.key, this.token, ttlMs);
    return result === 1;
  }
}

@Injectable()
export class DistributedLockService implements OnModuleDestroy {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly activeLocks = new Set<RedisLock>();

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {}

  async tryAcquire(key: string, ttlMs: number): Promise<DistributedLock | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null;

    const lock = new RedisLock(this.redis, key, token, () => this.activeLocks.delete(lock));
    this.activeLocks.add(lock);
    return lock;
  }

  async acquire(
    key: string,
    ttlMs: number,
    timeoutMs: number,
    retryMs = 500,
  ): Promise<DistributedLock> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const lock = await this.tryAcquire(key, ttlMs);
      if (lock) return lock;

      const now = Date.now();
      if (now >= deadline) {
        throw new Error(`Failed to acquire lock ${key} within ${timeoutMs}ms`);
      }
      const delayMs = Math.min(retryMs, deadline - now);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.activeLocks.size === 0) return;
    this.logger.log(`Releasing ${this.activeLocks.size} distributed lock(s) on shutdown`);
    await Promise.allSettled([...this.activeLocks].map((lock) => lock.release()));
    this.activeLocks.clear();
  }
}
