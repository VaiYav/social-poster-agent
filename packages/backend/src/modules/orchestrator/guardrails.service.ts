/**
 * GuardrailsService — Phase 3 of DECIDE: validate + clamp LLM output (G1-G7).
 *
 * Each guardrail checks a specific safety condition and overrides
 * the action with a WAIT if the condition is violated.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { WorldState, Action } from './types.js';
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

    // G8: POST takes priority over BROWSE/WAIT/GENERATE_TOPICS when there are approved drafts.
    // The LLM sometimes chooses BROWSE when it sees stale engagement, WAIT when it
    // believes no posting window is active, or GENERATE_TOPICS when the topic pool is low,
    // but approved content should always be posted when a network is ready. Engagement runs
    // in parallel via checkStaleAndEnqueue, so BROWSE/WAIT as the main action is redundant
    // when there are drafts to post.
    //
    // Among ready networks, pick the one with the oldest lastPostMs so posting rotates
    // across X and Threads instead of always hammering the first enabled network.
    if ((action.type === 'BROWSE' || action.type === 'WAIT' || action.type === 'GENERATE_TOPICS') && world.drafts.approved > 0) {
      let chosenNet: SocialNetwork | undefined;
      let chosenLastPostMs = Infinity;
      const readyDebug = networks.map((net) => ({
        net,
        inWindow: world.inPostingWindow[net],
        dailyRemaining: world.rateLimits[net]?.dailyRemaining ?? 0,
        weeklyRemaining: world.rateLimits[net]?.weeklyRemaining ?? 0,
        weeklyLimit: world.rateLimits[net]?.weeklyLimit ?? 0,
        status: world.sessions[net]?.status,
        circuitBreaker: world.sessions[net]?.circuitBreaker,
        lastPostMs: world.rateLimits[net]?.lastPostMs ?? 0,
        approved: world.drafts.approvedByNetwork[net] ?? 0,
      }));
      this.logger.debug(`G8 ready networks: ${JSON.stringify(readyDebug)}`);
      for (const net of networks) {
        if (world.sessions[net]?.circuitBreaker === 'open') continue;
        const rl = world.rateLimits[net];
        const dailyReady = rl ? (rl.dailyLimit > 0 ? rl.dailyRemaining > 0 : true) : false;
        const weeklyReady = rl ? (rl.weeklyLimit > 0 ? rl.weeklyRemaining > 0 : true) : false;
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
      if (chosenNet) {
        return {
          type: 'POST' as const,
          network: chosenNet,
          reason: `Guardrail G8: ${world.drafts.approved} approved drafts take priority over ${action.type} (${chosenNet} in posting window, oldest lastPost)`,
          source: 'guardrail_override',
        };
      }
    }

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
}
