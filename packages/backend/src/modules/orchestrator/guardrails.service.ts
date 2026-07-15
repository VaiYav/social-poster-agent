/**
 * GuardrailsService — Phase 3 of DECIDE: validate + clamp LLM output (G1-G7).
 *
 * Each guardrail checks a specific safety condition and overrides
 * the action with a WAIT if the condition is violated.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { WorldState, Action, SessionState } from './types.js';
import { WAIT_ACTION, RECOVER_ACTION } from './types.js';

@Injectable()
export class GuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);

  /**
   * Apply guardrails to an action. Returns the original action if all
   * guardrails pass, or a WAIT/RECOVER override if any guardrail fires.
   */
  apply(action: Action, world: WorldState): Action {
    // G1: Validate action type (should never fail — types are constrained)
    // Skipped — TypeScript discriminated union enforces this at compile time

    // G2: Validate network is enabled
    const networks = getEnabledNetworks();
    if (action.network && !networks.includes(action.network)) {
      return WAIT_ACTION(`Network ${action.network} not enabled`, 60000, 'guardrail_override');
    }

    // G8: POST takes priority over BROWSE/WAIT/GENERATE_*/REPLY when there are approved drafts.
    // The LLM sometimes chooses BROWSE when it sees stale engagement, WAIT when it
    // believes no posting window is active, or GENERATE_TOPICS when the topic pool is low,
    // but approved content should always be posted when a network is ready. Engagement runs
    // in parallel via checkStaleAndEnqueue, so BROWSE/WAIT as the main action is redundant
    // when there are drafts to post.
    //
    // Run before G3/G4/G5 so a rate-limit, queue-depth, or session issue on the chosen
    // network is checked on the best ready network (oldest lastPostMs), not on the first
    // enabled network. This also rotates posting across X and Threads and skips networks
    // with an open or half-open circuit breaker.
    //
    // Fallback: if approved drafts exist but no network is ready to POST (e.g. the only
    // network with approved drafts is half-open), generate drafts for the healthiest
    // alternative network so posting can rotate there. If no healthy network is available
    // for posting, block a POST action to a risky network with WAIT.
    if (world.drafts.approved > 0) {
      const postNet = this.selectBestReadyNetwork(world);
      if (postNet && (action.type !== 'POST' || action.network !== postNet)) {
        return {
          type: 'POST' as const,
          network: postNet,
          reason: `Guardrail G8: ${world.drafts.approved} approved drafts take priority over ${action.type} (${postNet} ready, oldest lastPost)`,
          source: 'guardrail_override',
        };
      }
      // No ready POST network — try to generate for a healthy alternative.
      const genNet = this.selectBestGenerationNetwork(world);
      if (genNet && (action.type !== 'GENERATE_POSTS' || action.network !== genNet)) {
        return {
          type: 'GENERATE_POSTS' as const,
          network: genNet,
          reason: `Guardrail G8: ${world.drafts.approved} approved drafts but no ready POST network; generating drafts for ${genNet}`,
          source: 'guardrail_override',
        };
      }
      // If the original action is POST to a risky network, block it until a healthy
      // network is available.
      if (
        action.type === 'POST' &&
        action.network &&
        this.isCircuitBreakerRisky(world.sessions[action.network]?.circuitBreaker)
      ) {
        return WAIT_ACTION(
          `Guardrail G8: POST ${action.network} blocked — circuit breaker ${world.sessions[action.network]?.circuitBreaker}`,
          300000,
          'guardrail_override',
        );
      }
    }

    // G3: POST requires rate limit remaining (daily AND weekly).
    // A limit of 0 means unlimited, so the exhausted checks are skipped in that case.
    if (action.type === 'POST' && action.network) {
      const rl = world.rateLimits[action.network];
      if (!rl || (rl.dailyLimit > 0 && rl.dailyRemaining === 0)) {
        return WAIT_ACTION(`Daily rate limit exhausted for ${action.network}`, 300000, 'guardrail_override');
      }
      if (rl.weeklyLimit > 0 && rl.weeklyRemaining === 0) {
        return WAIT_ACTION(`Weekly rate limit exhausted for ${action.network}`, 600000, 'guardrail_override');
      }
    }

    // G3b: GENERATE_POSTS with a network must target a network that has rate limit
    // capacity and a healthy circuit breaker. If the LLM picks a rate-limited or
    // half-open/open network, redirect to the ready network with the oldest lastPostMs
    // so posting rotates. If no network is ready, WAIT — generating drafts for an
    // exhausted or failing network wastes LLM quota.
    if (action.type === 'GENERATE_POSTS' && action.network) {
      const rl = world.rateLimits[action.network];
      const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
      const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : true;
      if (
        !dailyReady ||
        !weeklyReady ||
        this.isCircuitBreakerRisky(world.sessions[action.network]?.circuitBreaker)
      ) {
        let chosenNet: SocialNetwork | undefined;
        let chosenLastPostMs = Infinity;
        for (const net of networks) {
          if (net === action.network) continue;
          if (this.isCircuitBreakerRisky(world.sessions[net]?.circuitBreaker)) continue;
          const r = world.rateLimits[net];
          const dReady = r ? (r.dailyLimit > 0 ? r.dailyRemaining > 0 : true) : false;
          const wReady = r ? (r.weeklyLimit > 0 ? r.weeklyRemaining > 0 : true) : true;
          if (
            dReady &&
            wReady &&
            world.sessions[net]?.status === 'ACTIVE' &&
            (world.queueDepth[net] ?? 0) <= 5
          ) {
            const lastPostMs = world.rateLimits[net]?.lastPostMs ?? 0;
            if (lastPostMs < chosenLastPostMs) {
              chosenNet = net as SocialNetwork;
              chosenLastPostMs = lastPostMs;
            }
          }
        }
        if (chosenNet) {
          return {
            type: 'GENERATE_POSTS' as const,
            network: chosenNet,
            reason: `Guardrail G3b: ${action.network} is rate-limited; redirecting GENERATE_POSTS to ${chosenNet}`,
            source: 'guardrail_override',
          };
        }
        return WAIT_ACTION(
          `Rate limit exhausted for ${action.network} (GENERATE_POSTS blocked)`,
          300000,
          'guardrail_override',
        );
      }
    }

    // G4: POST/BROWSE require active session — but check flow-pause for the *original*
    // action type first. Otherwise a paused posting/engagement/replies flow doesn't stop
    // the resulting RECOVER_SESSION action (RECOVER_SESSION has no flow of its own to
    // pause — see isFlowPausedForAction's default case), so recovery attempts (and the
    // browser contexts/logins they spawn) would keep firing on their cooldown regardless
    // of Flow Control, defeating the operator's intent to silence that network.
    if ((action.type === 'POST' || action.type === 'BROWSE') && action.network) {
      if (this.isFlowPausedForAction(action, world)) {
        return WAIT_ACTION(`Flow paused for ${action.type}`, 60000, 'guardrail_override');
      }
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

    // G6: Max actions per hour — handled by DecisionEngine (needs Redis)

    // G7: Flow control paused for specific action (covers action types not already
    // gated by G4 above, e.g. GENERATE_*, RECYCLE_CONTENT, CHECK_REPLIES)
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

  private isCircuitBreakerRisky(circuitBreaker: SessionState['circuitBreaker'] | undefined): boolean {
    return circuitBreaker === 'open' || circuitBreaker === 'half_open';
  }

  /**
   * G8 generation helper: select the healthiest network with the oldest lastPostMs
   * among those that have active sessions, rate-limit capacity, and no circuit breaker
   * risk. Unlike selectBestReadyNetwork, this does NOT require approved drafts or an
   * active posting window — it is used as a fallback to generate drafts for a healthy
   * backup network when the only approved drafts are stuck on a failing network.
   */
  private selectBestGenerationNetwork(world: WorldState): SocialNetwork | undefined {
    if (world.flowControl.pauseGeneration) return undefined;

    const networks = getEnabledNetworks();
    let chosenNet: SocialNetwork | undefined;
    let chosenLastPostMs = Infinity;

    for (const net of networks) {
      if (this.isCircuitBreakerRisky(world.sessions[net]?.circuitBreaker)) continue;
      const rl = world.rateLimits[net];
      const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
      const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : true;
      if (
        dailyReady &&
        weeklyReady &&
        world.sessions[net]?.status === 'ACTIVE' &&
        (world.queueDepth[net] ?? 0) <= 5
      ) {
        const lastPostMs = world.rateLimits[net]?.lastPostMs ?? 0;
        if (lastPostMs < chosenLastPostMs) {
          chosenNet = net as SocialNetwork;
          chosenLastPostMs = lastPostMs;
        }
      }
    }
    return chosenNet;
  }

  /**
   * G8 helper: select the ready network with the oldest lastPostMs among those
   * that have approved drafts, active sessions, rate-limit capacity, and no
   * circuit breaker risk. Returns undefined if posting is paused or no network is ready.
   */
  private selectBestReadyNetwork(world: WorldState): SocialNetwork | undefined {
    if (world.flowControl.pausePosting) return undefined;

    const networks = getEnabledNetworks();
    let chosenNet: SocialNetwork | undefined;
    let chosenLastPostMs = Infinity;

    const readyDebug = networks.map((net) => ({
      net,
      inWindow: world.inPostingWindow[net],
      dailyRemaining: world.rateLimits[net]?.dailyRemaining ?? 0,
      weeklyRemaining: world.rateLimits[net]?.weeklyRemaining ?? 0,
      status: world.sessions[net]?.status,
      circuitBreaker: world.sessions[net]?.circuitBreaker,
      lastPostMs: world.rateLimits[net]?.lastPostMs ?? 0,
      approved: world.drafts.approvedByNetwork[net] ?? 0,
    }));
    this.logger.debug(`G8 ready networks: ${JSON.stringify(readyDebug)}`);

    for (const net of networks) {
      if (this.isCircuitBreakerRisky(world.sessions[net]?.circuitBreaker)) continue;
      const rl = world.rateLimits[net];
      const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
      const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : true;
      if (
        world.inPostingWindow[net] &&
        dailyReady &&
        weeklyReady &&
        world.sessions[net]?.status === 'ACTIVE' &&
        (world.drafts.approvedByNetwork[net] ?? 0) > 0 &&
        (world.queueDepth[net] ?? 0) <= 5
      ) {
        const lastPostMs = world.rateLimits[net]?.lastPostMs ?? 0;
        if (lastPostMs < chosenLastPostMs) {
          chosenNet = net as SocialNetwork;
          chosenLastPostMs = lastPostMs;
        }
      }
    }
    return chosenNet;
  }
}
