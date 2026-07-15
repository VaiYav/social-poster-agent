/**
 * DecisionEngine — DECIDE node implementation (WS-2).
 *
 * Thin orchestrator that delegates to three phases:
 *   Phase 1: HardRulesService — deterministic safety checks (H1-H10)
 *   Phase 2: LlmDecisionService — LLM soft optimization (or rules-only fallback)
 *   Phase 3: GuardrailsService — validate + clamp LLM output (G1-G7)
 *
 * Also handles:
 *   - Posting window enrichment (delegates to PostingWindowService)
 *   - Rules-only fallback decision logic
 *   - Action rate tracking (G6 guardrail — Redis sorted set)
 *
 * V-Model: WS-2 (critical — wrong decisions = wrong actions = bans)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { PostingWindowService } from './posting-window.service.js';
import { HardRulesService } from './hard-rules.service.js';
import { LlmDecisionService } from './llm-decision.service.js';
import { GuardrailsService } from './guardrails.service.js';
import type { WorldState, Action } from './types.js';
import { WAIT_ACTION } from './types.js';

const ACTION_HISTORY_KEY = 'spa:orchestrator:action-history'; // Redis sorted set (score=timestamp)
const ACTION_HISTORY_WINDOW_SEC = 3600; // 1 hour

@Injectable()
export class DecisionEngineService {
  private readonly logger = new Logger(DecisionEngineService.name);
  private readonly llmEnabled: boolean;
  private readonly maxActionsPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly postingWindowService: PostingWindowService,
    private readonly hardRules: HardRulesService,
    private readonly llmDecision: LlmDecisionService,
    private readonly guardrails: GuardrailsService,
  ) {
    this.llmEnabled = parseBool(process.env.ORCHESTRATOR_LLM_ENABLED ?? 'true');
    this.maxActionsPerHour = Number(process.env.ORCHESTRATOR_MAX_ACTIONS_PER_HOUR ?? '60');
  }

  /**
   * Main entry point — choose the next action based on world state.
   * Never throws — always returns an Action.
   */
  async decide(world: WorldState, signal?: AbortSignal): Promise<Action> {
    // Enrich world state with posting windows
    await this.enrichWithPostingWindows(world);

    // Phase 1: Hard rules (deterministic safety checks)
    const hardRuleAction = await this.hardRules.check(world);
    if (hardRuleAction) {
      this.logger.debug(`Decision: hard rule → ${hardRuleAction.type} (${hardRuleAction.reason})`);
      return hardRuleAction;
    }

    // Phase 2: LLM or rules-only fallback
    let action: Action;
    if (this.llmEnabled) {
      try {
        action = await this.llmDecision.decide(world, signal);
      } catch (err) {
        this.logger.warn(`LLM decision failed, falling back to rules: ${(err as Error).message}`);
        action = this.rulesOnlyDecision(world);
      }
    } else {
      action = this.rulesOnlyDecision(world);
    }

    // Phase 3: Guardrails (validate + clamp)
    let guarded = this.guardrails.apply(action, world);

    if (guarded !== action) {
      this.logger.warn(
        `Guardrail override: ${action.type}:${action.network} → ${guarded.type}:${guarded.network} (${guarded.reason})`,
      );
    }

    // G6: Enforce max actions per hour (soft guardrail).
    // Check before recording, otherwise the guardrails/LLM could choose a non-WAIT
    // action and we would immediately exceed the hourly budget.
    if (guarded.type !== 'WAIT') {
      const actionsThisHour = await this.getActionsThisHour();
      if (actionsThisHour >= this.maxActionsPerHour) {
        this.logger.warn(
          `Guardrail G6: hourly action budget exhausted (${actionsThisHour}/${this.maxActionsPerHour}) — overriding ${guarded.type} to WAIT`,
        );
        guarded = WAIT_ACTION(`Hourly action budget exhausted (${actionsThisHour}/${this.maxActionsPerHour})`, 300000, 'guardrail_override');
      }
    }

    // Record the final action (only non-WAIT actions count toward the budget)
    if (guarded.type !== 'WAIT') {
      void this.recordAction(guarded);
    }

    this.logger.log(`Decision: ${guarded.type}${guarded.network ? `:${guarded.network}` : ''} — ${guarded.reason}`);
    return guarded;
  }

  // ── Rules-Only Fallback ──────────────────────────────────────────────────

  private rulesOnlyDecision(world: WorldState): Action {
    const networks = getEnabledNetworks();

    // Topic pool low → generate topics
    if (world.topicPool.count < world.topicPool.threshold) {
      return {
        type: 'GENERATE_TOPICS',
        reason: `Topic pool ${world.topicPool.count}/${world.topicPool.threshold}`,
        source: 'rules_fallback',
      };
    }

    // Approved drafts + in posting window → POST
    if (world.drafts.approved > 0) {
      for (const net of networks) {
        // Skip networks with open or half-open circuit breaker — let a healthy network post instead
        if (
          world.sessions[net]?.circuitBreaker === 'open' ||
          world.sessions[net]?.circuitBreaker === 'half_open'
        ) {
          continue;
        }
        if (world.inPostingWindow[net] && (world.rateLimits[net]?.dailyRemaining ?? 0) > 0) {
          return {
            type: 'POST',
            network: net,
            reason: `${world.drafts.approved} approved drafts, ${net} in posting window`,
            source: 'rules_fallback',
          };
        }
      }
      // No healthy network is ready to post; generate drafts for the first healthy network
      // so posting can rotate off the failing network.
      const genNet = networks.find((net) => {
        const rl = world.rateLimits[net];
        const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
        const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : true;
        return (
          world.sessions[net]?.status === 'ACTIVE' &&
          world.sessions[net]?.circuitBreaker !== 'open' &&
          world.sessions[net]?.circuitBreaker !== 'half_open' &&
          dailyReady &&
          weeklyReady
        );
      });
      if (genNet) {
        return {
          type: 'GENERATE_POSTS',
          network: genNet,
          reason: `Approved drafts but no healthy POST network; generating drafts for ${genNet}`,
          source: 'rules_fallback',
        };
      }
      return WAIT_ACTION('Approved drafts waiting for healthy posting network', 120000, 'rules_fallback');
    }

    // No approved drafts, topic pool sufficient → GENERATE_POSTS
    if (world.topicPool.count >= world.topicPool.threshold && world.drafts.approved === 0) {
      const genNet = networks.find((net) => {
        const rl = world.rateLimits[net];
        const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
        const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : true;
        return (
          world.sessions[net]?.status === 'ACTIVE' &&
          world.sessions[net]?.circuitBreaker !== 'open' &&
          world.sessions[net]?.circuitBreaker !== 'half_open' &&
          dailyReady &&
          weeklyReady
        );
      });
      if (genNet) {
        return {
          type: 'GENERATE_POSTS',
          network: genNet,
          reason: `No approved drafts; generating for ${genNet}`,
          source: 'rules_fallback',
        };
      }
      return WAIT_ACTION('No approved drafts and no healthy network for generation', 120000, 'rules_fallback');
    }

    // NOTE: BROWSE (engagement) is now handled in PARALLEL by the observeNode
    // via EngagementSchedulerService.checkStaleAndEnqueue(). It no longer needs
    // to be chosen as the main action — browsing sessions are enqueued as
    // fire-and-forget BullMQ jobs and run concurrently with content pipeline.

    // Unchecked replies → CHECK_REPLIES
    if (world.engagement.uncheckedReplies > 0) {
      return {
        type: 'CHECK_REPLIES',
        reason: `${world.engagement.uncheckedReplies} unchecked replies`,
        source: 'rules_fallback',
      };
    }

    // Stale trends → REFRESH_TRENDS
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    if (world.trends.lastRefreshMs < twoHoursAgo) {
      return {
        type: 'REFRESH_TRENDS',
        reason: 'Trends cache stale (> 2h)',
        source: 'rules_fallback',
      };
    }

    // Default → WAIT
    return WAIT_ACTION('No actionable condition', 120000, 'rules_fallback');
  }

  // ── Posting Window Enrichment ────────────────────────────────────────────

  private async enrichWithPostingWindows(world: WorldState): Promise<void> {
    const networks = getEnabledNetworks();
    for (const net of networks) {
      try {
        const window = await this.postingWindowService.getRecommendation(net);
        world.postingWindows[net] = window;
        world.inPostingWindow[net] = window.inWindow;
      } catch {
        world.postingWindows[net] = null;
        world.inPostingWindow[net] = false;
      }
    }
  }

  // ── Action Rate Tracking (for G6 guardrail) ──────────────────────────────

  /**
   * Count actions in the last hour using Redis sorted set.
   * O(log N) — uses ZCOUNT which is efficient.
   */
  async getActionsThisHour(): Promise<number> {
    try {
      const now = Date.now();
      const cutoff = now - ACTION_HISTORY_WINDOW_SEC * 1000;
      await this.redis.zremrangebyscore(ACTION_HISTORY_KEY, '-inf', String(cutoff));
      return await this.redis.zcount(ACTION_HISTORY_KEY, String(cutoff), String(now));
    } catch {
      return 0;
    }
  }

  /**
   * Record an action in the sorted set for rate limiting.
   */
  async recordAction(action: Action): Promise<void> {
    try {
      const now = Date.now();
      const member = `${now}:${action.type}:${action.network ?? 'null'}`;
      await this.redis.zadd(ACTION_HISTORY_KEY, String(now), member);
      await this.redis.expire(ACTION_HISTORY_KEY, ACTION_HISTORY_WINDOW_SEC);
    } catch {
      // non-critical
    }
  }

  get maxActionsPerHourValue(): number {
    return this.maxActionsPerHour;
  }
}
