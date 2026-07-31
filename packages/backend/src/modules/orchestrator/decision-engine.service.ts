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
import { RulesEngine } from './rules-engine.js';
import type { WorldState, Action } from './types.js';
import { WAIT_ACTION } from './types.js';

const ACTION_HISTORY_KEY = 'spa:orchestrator:action-history'; // Redis sorted set (score=timestamp)
const LLM_DECISION_HISTORY_KEY = 'spa:orchestrator:llm-decision-history'; // Redis sorted set (score=timestamp)
const ACTION_HISTORY_WINDOW_SEC = 3600; // 1 hour

@Injectable()
export class DecisionEngineService {
  private readonly logger = new Logger(DecisionEngineService.name);
  private readonly llmEnabled: boolean;
  private readonly maxActionsPerHour: number;
  private readonly llmFullLoopEnabled: boolean;
  private readonly llmFullLoopMaxDecisionsPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly postingWindowService: PostingWindowService,
    private readonly hardRules: HardRulesService,
    private readonly llmDecision: LlmDecisionService,
    private readonly guardrails: GuardrailsService,
    private readonly rulesEngine: RulesEngine,
  ) {
    this.llmEnabled = parseBool(this.configService.get<string>('ORCHESTRATOR_LLM_ENABLED', 'true'));
    this.maxActionsPerHour = Number(this.configService.get<number>('ORCHESTRATOR_MAX_ACTIONS_PER_HOUR', 60));
    this.llmFullLoopEnabled = parseBool(this.configService.get<string>('LLM_FULL_LOOP_ENABLED', 'false'));
    this.llmFullLoopMaxDecisionsPerHour = Number(this.configService.get<number>('LLM_FULL_LOOP_MAX_DECISIONS_PER_HOUR', 60));
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
    // P1: full LLM-in-the-loop mode forces LLM usage unless the hourly budget is exhausted.
    let action: Action;
    const useLlm = this.llmEnabled || this.llmFullLoopEnabled;
    if (useLlm) {
      const withinBudget = this.llmFullLoopEnabled
        ? await this.isLlmDecisionWithinBudget()
        : true; // legacy mode: no separate LLM budget
      if (withinBudget) {
        try {
          action = await this.llmDecision.decide(world, signal);
          // Record LLM decision usage only in full-LLM loop mode to enforce its budget.
          if (this.llmFullLoopEnabled) {
            await this.recordLlmDecision();
          }
        } catch (err) {
          this.logger.warn(`LLM decision failed, falling back to rules: ${(err as Error).message}`);
          action = this.rulesEngine.decide(world);
        }
      } else {
        this.logger.warn(
          `Full-LLM loop budget exhausted (${await this.getLlmDecisionsThisHour()}/${this.llmFullLoopMaxDecisionsPerHour}) — using rules fallback`,
        );
        action = this.rulesEngine.decide(world);
      }
    } else {
      action = this.rulesEngine.decide(world);
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
      await this.recordAction(guarded);
    }

    this.logger.log(`Decision: ${guarded.type}${guarded.network ? `:${guarded.network}` : ''} — ${guarded.reason}`);
    return guarded;
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
    } catch (err) {
      this.logger.warn(`Failed to record action history: ${(err as Error).message}`);
    }
  }

  get maxActionsPerHourValue(): number {
    return this.maxActionsPerHour;
  }

  /**
   * P1: Full LLM-in-the-loop budget helpers.
   */
  private async getLlmDecisionsThisHour(): Promise<number> {
    try {
      const now = Date.now();
      const cutoff = now - ACTION_HISTORY_WINDOW_SEC * 1000;
      await this.redis.zremrangebyscore(LLM_DECISION_HISTORY_KEY, '-inf', String(cutoff));
      return await this.redis.zcount(LLM_DECISION_HISTORY_KEY, String(cutoff), String(now));
    } catch {
      return 0;
    }
  }

  private async isLlmDecisionWithinBudget(): Promise<boolean> {
    if (this.llmFullLoopMaxDecisionsPerHour <= 0) return true;
    const count = await this.getLlmDecisionsThisHour();
    return count < this.llmFullLoopMaxDecisionsPerHour;
  }

  private async recordLlmDecision(): Promise<void> {
    try {
      const now = Date.now();
      const member = `${now}:llm`;
      await this.redis.zadd(LLM_DECISION_HISTORY_KEY, String(now), member);
      await this.redis.expire(LLM_DECISION_HISTORY_KEY, ACTION_HISTORY_WINDOW_SEC);
    } catch (err) {
      this.logger.warn(`Failed to record LLM decision history: ${(err as Error).message}`);
    }
  }
}
