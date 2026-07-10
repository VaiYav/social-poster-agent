import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { SHARED_REDIS } from '../redis/redis.module.js';

@Injectable()
export class InstanceHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InstanceHeartbeatService.name);
  private readonly instanceId: string;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private interval: NodeJS.Timeout | null = null;
  private isDestroyed = false;
  private beatPending = false;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {
    this.instanceId = this.configService.get<string>('INSTANCE_ID', '').trim() || randomUUID();
    this.ttlMs = this.configService.get<number>('INSTANCE_HEARTBEAT_TTL_MS', 30_000);
    this.intervalMs = this.configService.get<number>('INSTANCE_HEARTBEAT_INTERVAL_MS', 10_000);
    this.key = `spa:instance:${this.instanceId}`;
  }

  onModuleInit(): void {
    this.logger.log(`Instance heartbeat started: ${this.instanceId}`);
    void this.beat();
    this.interval = setInterval(() => void this.beat(), this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    try {
      await this.redis.del(this.key);
      this.logger.log(`Instance heartbeat removed: ${this.instanceId}`);
    } catch (err) {
      this.logger.warn(`Failed to delete instance heartbeat ${this.key}: ${(err as Error).message}`);
    }
  }

  private async beat(): Promise<void> {
    if (this.isDestroyed || this.beatPending) return;
    this.beatPending = true;
    try {
      const payload = JSON.stringify({
        instanceId: this.instanceId,
        hostname: hostname(),
        pid: process.pid,
        beatAt: Date.now(),
      });
      await this.redis.set(this.key, payload, 'PX', this.ttlMs);
    } catch (err) {
      this.logger.warn(`Instance heartbeat failed: ${(err as Error).message}`);
    } finally {
      this.beatPending = false;
    }
  }
}
