/**
 * HardRulesService — Phase 1 of DECIDE: deterministic safety checks (H1-H10).
 *
 * First match wins. Never calls LLM. Returns null if no hard rule matches
 * → caller proceeds to LLM/rules-only phase.
 */

import { Injectable } from '@nestjs/common';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { Inject } from '@nestjs/common';
import type { WorldState, Action } from './types.js';
import { WAIT_ACTION, RECOVER_ACTION } from './types.js';

const RECOVER_COOLDOWN_MS = 300_000; // 5 min between RECOVER_SESSION attempts per network
const RECOVER_COOLDOWN_KEY = 'spa:orchestrator:recover-cooldown';

@Injectable()
export class HardRulesService {
  constructor(
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
  ) {}

  /**
   * Check hard rules in priority order. First match wins.
   * Returns null if no hard rule matches → proceed to LLM.
   */
  async check(world: WorldState): Promise<Action | null> {
    const networks = getEnabledNetworks();

    // H1: Kill switch
    if (world.flowControl.pauseAll) {
      return WAIT_ACTION('Kill switch active', 60000);
    }

    // H2: Expired session → RECOVER (with cooldown to avoid tight loop)
    for (const net of networks) {
      const session = world.sessions[net];
      if (session && (session.status === 'EXPIRED' || session.status === 'ERROR')) {
        const cooldownRemaining = await this.getRecoverCooldown(net);
        if (cooldownRemaining > 0) {
          return WAIT_ACTION(
            `Session ${net} is ${session.status}, recovery cooldown (${Math.round(cooldownRemaining / 1000)}s left)`,
            cooldownRemaining,
          );
        }
        await this.setRecoverCooldown(net);
        return RECOVER_ACTION(net, `Session ${net} is ${session.status}`);
      }
    }

    // H3: Banned session → WAIT
    for (const net of networks) {
      const session = world.sessions[net];
      if (session && session.status === 'BANNED') {
        return WAIT_ACTION(`Session ${net} is banned`, 300000);
      }
    }

    // H4: Circuit breaker open → WAIT
    for (const net of networks) {
      const session = world.sessions[net];
      if (session && session.circuitBreaker === 'open') {
        return WAIT_ACTION(`Circuit breaker open for ${net}`, 60000);
      }
    }

    // H5: All networks daily limit exhausted → WAIT
    const allDailyExhausted = networks.every(
      (net) => (world.rateLimits[net]?.dailyRemaining ?? 0) === 0,
    );
    if (allDailyExhausted && networks.length > 0) {
      return WAIT_ACTION('Daily rate limit exhausted for all networks', 300000);
    }

    // H6: All networks weekly limit exhausted → WAIT
    const allWeeklyExhausted = networks.every(
      (net) => (world.rateLimits[net]?.weeklyRemaining ?? 0) === 0,
    );
    if (allWeeklyExhausted && networks.length > 0) {
      return WAIT_ACTION('Weekly rate limit exhausted for all networks', 600000);
    }

    // H7: DLQ overflow → HEALTH_CHECK
    if (world.health.dlqDepth > 10) {
      return {
        type: 'HEALTH_CHECK',
        reason: `DLQ depth ${world.health.dlqDepth} > 10`,
        source: 'hard_rule',
      };
    }

    // H8: Stuck posting → RECONCILE
    if (world.health.stuckPosting > 5) {
      return {
        type: 'RECONCILE',
        reason: `${world.health.stuckPosting} posts stuck in POSTING`,
        source: 'hard_rule',
      };
    }

    // H9: Bans detected → WAIT
    if (world.health.bans > 0) {
      return WAIT_ACTION(`${world.health.bans} ban(s) detected`, 300000);
    }

    // H10: Queue backed up → WAIT
    for (const net of networks) {
      if ((world.queueDepth[net] ?? 0) > 5) {
        return WAIT_ACTION(`Queue depth for ${net} > 5`, 60000);
      }
    }

    return null; // No hard rule matched → proceed to LLM
  }

  // ── RECOVER_SESSION Cooldown ──────────────────────────────────────────────

  private async getRecoverCooldown(network: string): Promise<number> {
    try {
      const key = `${RECOVER_COOLDOWN_KEY}:${network}`;
      const ttl = await this.redis.pttl(key);
      if (ttl > 0) return ttl;
      return 0;
    } catch {
      return 0;
    }
  }

  private async setRecoverCooldown(network: string): Promise<void> {
    try {
      const key = `${RECOVER_COOLDOWN_KEY}:${network}`;
      await this.redis.set(key, '1', 'PX', RECOVER_COOLDOWN_MS);
    } catch {
      // non-critical — cooldown is best-effort
    }
  }
}
