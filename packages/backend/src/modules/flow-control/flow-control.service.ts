/**
 * ADR-006: Flow Control Service — Redis-based pause/resume flags for all agent flows.
 *
 * Allows the operator to pause any flow without restarting the backend:
 *   - pause_all: global emergency stop
 *   - pause_generation: stop new generation runs
 *   - pause_posting: stop enqueueing new posts
 *   - pause_engagement: stop engagement sessions
 *   - pause_replies: stop reply monitoring
 *
 * All services check isPaused() before starting new work.
 * In-flight jobs complete naturally — only NEW work is blocked.
 *
 * Crisis mode: pauseAll() sets all flags at once.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';

export type FlowName = 'generation' | 'posting' | 'engagement' | 'replies';

const FLOW_KEYS: Record<FlowName, string> = {
  generation: 'flow:pause_generation',
  posting: 'flow:pause_posting',
  engagement: 'flow:pause_engagement',
  replies: 'flow:pause_replies',
};

const PAUSE_ALL_KEY = 'flow:pause_all';

@Injectable()
export class FlowControlService {
  private readonly logger = new Logger(FlowControlService.name);

  constructor(
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    private readonly sseService: SseService,
  ) {}

  /**
   * Check if a specific flow is paused.
   * Returns true if either the flow-specific flag OR pause_all is set.
   */
  async isPaused(flow: FlowName): Promise<boolean> {
    const [allPaused, flowPaused] = await Promise.all([
      this.redis.get(PAUSE_ALL_KEY),
      this.redis.get(FLOW_KEYS[flow]),
    ]);
    return allPaused === '1' || flowPaused === '1';
  }

  /**
   * Synchronous-ish check for use in hot paths.
   * Note: this is async — caller must await. For truly sync checks, use a cached flag.
   */
  async assertNotPaused(flow: FlowName): Promise<void> {
    if (await this.isPaused(flow)) {
      throw new Error(`Flow '${flow}' is paused — skipping new work`);
    }
  }

  /**
   * Pause a specific flow.
   */
  async pause(flow: FlowName, reason?: string): Promise<void> {
    await this.redis.set(FLOW_KEYS[flow], '1');
    this.logger.warn(`Flow '${flow}' paused${reason ? `: ${reason}` : ''}`);
    await this.notifySse('paused', flow, reason);
  }

  /**
   * Resume a specific flow.
   */
  async resume(flow: FlowName): Promise<void> {
    await this.redis.del(FLOW_KEYS[flow]);
    this.logger.log(`Flow '${flow}' resumed`);
    await this.notifySse('resumed', flow);
  }

  /**
   * Crisis mode: pause ALL flows at once.
   */
  async pauseAll(reason?: string): Promise<void> {
    await this.redis.set(PAUSE_ALL_KEY, '1');
    this.logger.error(`CRISIS MODE: All flows paused${reason ? `: ${reason}` : ''}`);
    await this.sseService.publish({
      type: 'flow_control',
      action: 'pause_all',
      reason: reason ?? 'Crisis mode activated',
    });
  }

  /**
   * Resume all flows (clear pause_all + all individual flags).
   */
  async resumeAll(): Promise<void> {
    await this.redis.del(PAUSE_ALL_KEY);
    for (const flow of Object.keys(FLOW_KEYS) as FlowName[]) {
      await this.redis.del(FLOW_KEYS[flow]);
    }
    this.logger.log('All flows resumed — crisis mode deactivated');
    await this.sseService.publish({
      type: 'flow_control',
      action: 'resume_all',
    });
  }

  /**
   * Get status of all flows (for dashboard).
   */
  async getStatus(): Promise<{
    pauseAll: boolean;
    flows: Record<FlowName, boolean>;
  }> {
    const allPaused = (await this.redis.get(PAUSE_ALL_KEY)) === '1';
    const flows = {} as Record<FlowName, boolean>;
    for (const flow of Object.keys(FLOW_KEYS) as FlowName[]) {
      flows[flow] = allPaused || (await this.redis.get(FLOW_KEYS[flow])) === '1';
    }
    return { pauseAll: allPaused, flows };
  }

  private async notifySse(action: 'paused' | 'resumed', flow: FlowName, reason?: string): Promise<void> {
    await this.sseService.publish({
      type: 'flow_control',
      action,
      flow,
      reason: reason ?? null,
    });
  }
}
