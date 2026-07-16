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

    // H3: REMOVED — BANNED sessions are now handled by Guardrails (G4 and G8).
    // G8 routes POST/GENERATE_* to healthy active networks, and G4 blocks any
    // LLM-chosen POST/BROWSE on a BANNED session with a per-cycle WAIT. Keeping
    // H3 here caused a single BANNED network to block every network, preventing
    // THREADS from posting while X was restricted.

    // H4: Circuit breaker open for ALL networks → WAIT
    // If only some networks have open circuit breakers, let the decision engine
    // pick a healthy network instead of blocking everything.
    const openCircuits = networks.filter(
      (net) => world.sessions[net]?.circuitBreaker === 'open',
    );
    if (openCircuits.length > 0 && openCircuits.length === networks.length) {
      return WAIT_ACTION(`Circuit breaker open for all networks (${openCircuits.join(', ')})`, 60000);
    }

    // H5: All networks daily limit exhausted → WAIT.
    // Networks with a daily limit of 0 are unlimited, so they are not considered exhausted.
    const allDailyExhausted = networks.every((net) => {
      const rl = world.rateLimits[net];
      return rl && rl.dailyLimit > 0 && rl.dailyRemaining === 0;
    });
    if (allDailyExhausted && networks.length > 0) {
      return WAIT_ACTION('Daily rate limit exhausted for all networks', 300000);
    }

    // H6: All networks weekly limit exhausted → WAIT
    const allWeeklyExhausted = networks.every((net) => {
      const rl = world.rateLimits[net];
      return rl && rl.weeklyLimit > 0 && rl.weeklyRemaining === 0;
    });
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

    // H8b: Stuck browsing sessions → RECONCILE
    if (world.health.stuckBrowsingSessions > 0) {
      return {
        type: 'RECONCILE',
        reason: `${world.health.stuckBrowsingSessions} browsing session(s) stuck ACTIVE`,
        source: 'hard_rule',
      };
    }

    // H9: Bans detected on ALL networks → WAIT. A single failing network should not
    // block the whole pipeline; the decision engine can route work to healthy networks.
    if (world.health.bans > 0 && networks.length > 0 && world.health.bans === networks.length) {
      return WAIT_ACTION(`${world.health.bans} ban(s) detected`, 300000);
    }

    // H10: Queue backed up for ALL networks → WAIT
    // If only one network is backlogged, let the decision engine pick a healthy
    // network instead of blocking the whole pipeline.
    const allQueueBackedUp =
      networks.length > 0 &&
      networks.every((net) => (world.queueDepth[net] ?? 0) > 5);
    if (allQueueBackedUp) {
      return WAIT_ACTION('Queue depth > 5 for all networks', 60000);
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
