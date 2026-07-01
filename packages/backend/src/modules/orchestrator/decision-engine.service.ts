/**
 * DecisionEngine — DECIDE node implementation (WS-2).
 *
 * Three-phase decision: hard rules → LLM → guardrails.
 *
 * Phase 1: Hard rules — deterministic safety checks (H1-H10).
 *          First match wins. Never calls LLM.
 * Phase 2: LLM — soft optimization. Only called when no hard rule matches.
 *          Falls back to rules-only if LLM disabled, fails, or times out.
 * Phase 3: Guardrails — validate + clamp LLM output (G1-G8).
 *
 * V-Model: WS-2 (critical — wrong decisions = wrong actions = bans)
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { PostingWindowService } from './posting-window.service.js';
import { ORCHESTRATOR_SYSTEM_PROMPT, buildOrchestratorUserPrompt } from './prompts/orchestrator-prompt.js';
import type { WorldState, Action, ActionType } from './types.js';
import { WAIT_ACTION, RECOVER_ACTION } from './types.js';

const LLM_TIMEOUT_MS = 10000;
const ACTION_HISTORY_KEY = 'spa:orchestrator:action-history';
const ACTION_HISTORY_WINDOW_SEC = 3600; // 1 hour
const RECOVER_COOLDOWN_MS = 300_000; // 5 min between RECOVER_SESSION attempts per network
const RECOVER_COOLDOWN_KEY = 'spa:orchestrator:recover-cooldown';

const VALID_ACTIONS: ActionType[] = [
  'GENERATE_TOPICS', 'GENERATE_POSTS', 'POST', 'BROWSE',
  'RECOVER_SESSION', 'CHECK_REPLIES', 'REFRESH_TRENDS',
  'HEALTH_CHECK', 'RECONCILE', 'SCRAPE_METRICS',
  'RECYCLE_CONTENT', 'AGGREGATE_HOOKS', 'WAIT',
];

@Injectable()
export class DecisionEngineService {
  private readonly logger = new Logger(DecisionEngineService.name);
  private readonly llmEnabled: boolean;
  private readonly maxActionsPerHour: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: InstanceType<typeof import('ioredis').default>,
    private readonly postingWindowService: PostingWindowService,
    @Optional() @Inject(ILlmPort) private readonly llm?: typeof ILlmPort extends never ? never : any,
  ) {
    this.llmEnabled = parseBool(process.env.ORCHESTRATOR_LLM_ENABLED ?? 'true');
    this.maxActionsPerHour = Number(process.env.ORCHESTRATOR_MAX_ACTIONS_PER_HOUR ?? '15');
  }

  /**
   * Main entry point — choose the next action based on world state.
   * Never throws — always returns an Action.
   */
  async decide(world: WorldState): Promise<Action> {
    // Enrich world state with posting windows
    await this.enrichWithPostingWindows(world);

    // Phase 1: Hard rules (deterministic safety checks)
    const hardRuleAction = await this.checkHardRules(world);
    if (hardRuleAction) {
      this.logger.debug(`Decision: hard rule → ${hardRuleAction.type} (${hardRuleAction.reason})`);
      return hardRuleAction;
    }

    // Phase 2: LLM or rules-only fallback
    let action: Action;
    if (this.llmEnabled && this.llm) {
      action = await this.llmDecision(world);
    } else {
      action = this.rulesOnlyDecision(world);
    }

    // Phase 3: Guardrails (validate + clamp)
    const guarded = this.applyGuardrails(action, world);

    if (guarded !== action) {
      this.logger.warn(
        `Guardrail override: ${action.type}:${action.network} → ${guarded.type}:${guarded.network} (${guarded.reason})`,
      );
    }

    this.logger.log(`Decision: ${guarded.type}${guarded.network ? `:${guarded.network}` : ''} — ${guarded.reason}`);
    return guarded;
  }

  // ── Phase 1: Hard Rules ──────────────────────────────────────────────────

  /**
   * Check hard rules in priority order. First match wins.
   * Returns null if no hard rule matches → proceed to LLM.
   */
  private async checkHardRules(world: WorldState): Promise<Action | null> {
    const networks = getEnabledNetworks();

    // H1: Kill switch
    if (world.flowControl.pauseAll) {
      return WAIT_ACTION('Kill switch active', 60000);
    }

    // H2: Expired session → RECOVER (with cooldown to avoid tight loop)
    for (const net of networks) {
      const session = world.sessions[net];
      if (session && (session.status === 'EXPIRED' || session.status === 'ERROR')) {
        // Check cooldown — if we recently tried to recover this network, WAIT instead
        const cooldownRemaining = await this.getRecoverCooldown(net);
        if (cooldownRemaining > 0) {
          return WAIT_ACTION(
            `Session ${net} is ${session.status}, recovery cooldown (${Math.round(cooldownRemaining / 1000)}s left)`,
            cooldownRemaining,
          );
        }
        // Set cooldown before attempting recovery
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

  // ── Phase 2: LLM Decision ────────────────────────────────────────────────

  private async llmDecision(world: WorldState): Promise<Action> {
    try {
      const userPrompt = buildOrchestratorUserPrompt(world);

      const result = await Promise.race([
        this.llm.generateChat(ORCHESTRATOR_SYSTEM_PROMPT, userPrompt, {
          temperature: 0.3,
          maxTokens: 200,
        }),
        this.timeout(),
      ]);

      const action = this.parseLlmResponse(result.text, world);
      this.logger.debug(`LLM decision: ${action.type}:${action.network} — ${action.reason}`);
      return action;
    } catch (err) {
      this.logger.warn(`LLM decision failed, falling back to rules: ${(err as Error).message}`);
      return this.rulesOnlyDecision(world);
    }
  }

  private timeout(): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM timeout')), LLM_TIMEOUT_MS),
    );
  }

  private parseLlmResponse(text: string, world: WorldState): Action {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const actionType = String(parsed.action).toUpperCase() as ActionType;
    const network = parsed.network && parsed.network !== 'null' ? parsed.network : undefined;
    const reason = String(parsed.reason ?? 'LLM decision');

    if (!VALID_ACTIONS.includes(actionType)) {
      throw new Error(`Invalid action type: ${actionType}`);
    }

    return {
      type: actionType,
      network: network as any,
      reason,
      source: 'llm',
    };
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
        if (world.inPostingWindow[net] && (world.rateLimits[net]?.dailyRemaining ?? 0) > 0) {
          return {
            type: 'POST',
            network: net as any,
            reason: `${world.drafts.approved} approved drafts, ${net} in posting window`,
            source: 'rules_fallback',
          };
        }
      }
      // Drafts exist but not in window → WAIT
      return WAIT_ACTION('Approved drafts waiting for posting window', 120000, 'rules_fallback');
    }

    // No approved drafts, topic pool sufficient → GENERATE_POSTS
    if (world.topicPool.count >= world.topicPool.threshold && world.drafts.approved === 0) {
      return {
        type: 'GENERATE_POSTS',
        reason: 'No approved drafts, topic pool sufficient',
        source: 'rules_fallback',
      };
    }

    // Stale browse → BROWSE
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    for (const net of networks) {
      const lastBrowse = world.engagement.lastBrowseMs[net] ?? 0;
      if (lastBrowse < fourHoursAgo && world.sessions[net]?.status === 'ACTIVE') {
        return {
          type: 'BROWSE',
          network: net as any,
          reason: `Last browse for ${net} > 4h ago`,
          source: 'rules_fallback',
        };
      }
    }

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

  // ── Phase 3: Guardrails ──────────────────────────────────────────────────

  private applyGuardrails(action: Action, world: WorldState): Action {
    // G1: Validate action type
    if (!VALID_ACTIONS.includes(action.type)) {
      return WAIT_ACTION(`Invalid action type: ${action.type}`, 60000, 'guardrail_override');
    }

    // G2: Validate network is enabled
    const networks = getEnabledNetworks();
    if (action.network && !networks.includes(action.network as any)) {
      return WAIT_ACTION(`Network ${action.network} not enabled`, 60000, 'guardrail_override');
    }

    // G3: POST requires rate limit remaining
    if (action.type === 'POST' && action.network) {
      const remaining = world.rateLimits[action.network]?.dailyRemaining ?? 0;
      if (remaining === 0) {
        return WAIT_ACTION(`Rate limit exhausted for ${action.network}`, 300000, 'guardrail_override');
      }
    }

    // G4: POST/BROWSE require active session
    if ((action.type === 'POST' || action.type === 'BROWSE') && action.network) {
      const session = world.sessions[action.network];
      if (session && session.status !== 'ACTIVE') {
        return RECOVER_ACTION(action.network, `Session ${action.network} not active (was ${action.type})`);
      }
    }

    // G5: POST requires queue depth < 5
    if (action.type === 'POST' && action.network) {
      const depth = world.queueDepth[action.network] ?? 0;
      if (depth > 5) {
        return WAIT_ACTION(`Queue depth for ${action.network} > 5`, 60000, 'guardrail_override');
      }
    }

    // G6: Max actions per hour
    // (checked asynchronously — if we can't verify, we allow the action)
    // This is a soft guardrail — checked in the executor before running

    // G7: Flow control paused for specific action
    if (this.isFlowPausedForAction(action, world)) {
      return WAIT_ACTION(`Flow paused for ${action.type}`, 60000, 'guardrail_override');
    }

    return action;
  }

  private isFlowPausedForAction(action: Action, world: WorldState): boolean {
    const fc = world.flowControl;
    switch (action.type) {
      case 'GENERATE_TOPICS':
      case 'GENERATE_POSTS':
      case 'RECYCLE_CONTENT':
        return fc.pauseGeneration;
      case 'POST':
        return fc.pausePosting;
      case 'BROWSE':
        return fc.pauseEngagement;
      case 'CHECK_REPLIES':
        return fc.pauseReplies;
      default:
        return false;
    }
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

  async getActionsThisHour(): Promise<number> {
    try {
      const count = await this.redis.llen(ACTION_HISTORY_KEY);
      // Clean up old entries
      const cutoff = Date.now() - ACTION_HISTORY_WINDOW_SEC * 1000;
      const entries = await this.redis.lrange(ACTION_HISTORY_KEY, 0, -1);
      for (const entry of entries) {
        const ts = Number(entry.split(':')[0]);
        if (ts < cutoff) {
          await this.redis.lrem(ACTION_HISTORY_KEY, 1, entry);
        }
      }
      return await this.redis.llen(ACTION_HISTORY_KEY);
    } catch {
      return 0;
    }
  }

  async recordAction(action: Action): Promise<void> {
    try {
      const entry = `${Date.now()}:${action.type}:${action.network ?? 'null'}`;
      await this.redis.lpush(ACTION_HISTORY_KEY, entry);
      await this.redis.expire(ACTION_HISTORY_KEY, ACTION_HISTORY_WINDOW_SEC);
    } catch {
      // non-critical
    }
  }

  get maxActionsPerHourValue(): number {
    return this.maxActionsPerHour;
  }

  // ── RECOVER_SESSION Cooldown ──────────────────────────────────────────────

  private async getRecoverCooldown(network: string): Promise<number> {
    try {
      const key = `${RECOVER_COOLDOWN_KEY}:${network}`;
      const ttl = await this.redis.pttl(key);
      // pttl returns -2 if key doesn't exist, -1 if no TTL
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
