/**
 * OrchestratorHistoryService — persists cycle history to Redis.
 *
 * Extracted from OrchestratorService (X16) — keeps a bounded list of
 * recent cycle results for the REST API /api/v1/orchestrator/history.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import type { ActionResult } from './types.js';

const HISTORY_KEY_DEFAULT = 'spa:orchestrator:history';
const HISTORY_MAX = 200;

@Injectable()
export class OrchestratorHistoryService {
  private readonly logger = new Logger(OrchestratorHistoryService.name);
  private readonly historyKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
  ) {
    this.historyKey = this.configService.get<string>('ORCHESTRATOR_HISTORY_KEY') ?? HISTORY_KEY_DEFAULT;
  }

  async record(cycle: number, result: ActionResult | null, sleepMs: number): Promise<void> {
    try {
      const entry = JSON.stringify({
        cycle,
        type: result?.type,
        success: result?.success,
        duration: result?.duration,
        sleepMs,
        timestamp: Date.now(),
      });
      await this.redis.lpush(this.historyKey, entry);
      await this.redis.ltrim(this.historyKey, 0, HISTORY_MAX - 1);
    } catch {
      // non-critical
    }
  }

  async getHistory(limit = 50): Promise<Record<string, unknown>[]> {
    try {
      const n = Math.max(1, Math.min(limit, HISTORY_MAX));
      const entries = await this.redis.lrange(this.historyKey, 0, n - 1);
      return entries.map((e) => JSON.parse(e) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}
