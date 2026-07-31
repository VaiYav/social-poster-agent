/**
 * GuardrailsService — Phase 3 of DECIDE: validate + clamp LLM output (G1-G7).
 *
 * Each guardrail checks a specific safety condition and overrides
 * the action with a WAIT if the condition is violated.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SocialNetwork } from '@prisma/client';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import { NetworkSelector } from './network-selector.js';
import type { WorldState, Action } from './types.js';
import { WAIT_ACTION, RECOVER_ACTION } from './types.js';

@Injectable()
export class GuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);
  private readonly engagementPriorityWeight: number;

  constructor(
    configService: ConfigService,
    private readonly networkSelector: NetworkSelector,
  ) {
    const raw = configService.get<string>('ENGAGEMENT_PRIORITY_WEIGHT', '1');
    const parsed = Number(raw);
    this.engagementPriorityWeight = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
  }

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

    // G9: Engagement-first nudge. If we are behind on comments (debt > 0) and there
    // are approved drafts waiting, prefer BROWSE over POST/GENERATE_POSTS when the
    // operator has configured an engagement priority weight.
    // A weight of 0 disables the nudge. Higher weight makes BROWSE more likely.
    // Formula: debt * weight > approvedDrafts.
    if (this.engagementPriorityWeight > 0 && world.engagement.debt > 0 && world.drafts.approved > 0) {
      if (action.type === 'POST' || action.type === 'GENERATE_POSTS') {
        if (world.engagement.debt * this.engagementPriorityWeight > world.drafts.approved) {
          const browseNet = this.networkSelector.selectBestEngagementNetwork(world);
          if (browseNet) {
            return {
              type: 'BROWSE' as const,
              network: browseNet,
              reason: `Guardrail G9: engagement-first — ${world.engagement.debt} comment(s) behind, ${world.drafts.approved} approved drafts; browsing ${browseNet} instead of ${action.type}`,
              source: 'guardrail_override',
            };
          }
        }
      }
    }

    // G8: POST takes priority over BROWSE/WAIT/GENERATE_*/REPLY when there are approved drafts,
    // UNLESS engagement debt is high — then BROWSE is intentionally allowed to proceed first.
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
    if (world.drafts.approved > 0 && !(action.type === 'BROWSE' && world.engagement.engagementDebt > 0)) {
      const postNet = this.networkSelector.selectBestReadyNetwork(world);
      if (postNet && (action.type !== 'POST' || action.network !== postNet)) {
        return {
          type: 'POST' as const,
          network: postNet,
          reason: `Guardrail G8: ${world.drafts.approved} approved drafts take priority over ${action.type} (${postNet} ready, oldest lastPost)`,
          source: 'guardrail_override',
        };
      }
      if (!postNet) {
        // No ready POST network — try to generate for a healthy alternative.
        const genNet = this.networkSelector.selectBestGenerationNetwork(world);
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
          this.networkSelector.isCircuitBreakerRisky(world.sessions[action.network]?.circuitBreaker)
        ) {
          return WAIT_ACTION(
            `Guardrail G8: POST ${action.network} blocked — circuit breaker ${world.sessions[action.network]?.circuitBreaker}`,
            300000,
            'guardrail_override',
          );
        }
      }
    }

    // G3: POST requires rate limit remaining (daily AND WEEKLY).
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

    // G3b: GENERATE_POSTS must target the healthiest network with the oldest lastPostMs
    // (or one that has never posted). If the LLM picks a rate-limited, circuit-risk, or
    // suboptimal network, redirect so posting rotates and we don't waste LLM quota on a
    // failing channel. If no healthy network is available, WAIT.
    if (action.type === 'GENERATE_POSTS') {
      const bestGenNet = this.networkSelector.selectBestGenerationNetwork(world);
      const actionNetwork = action.network;
      if (bestGenNet && (!actionNetwork || actionNetwork !== bestGenNet)) {
        const why = actionNetwork
          ? this.networkSelector.isReadyForGeneration(actionNetwork, world)
            ? `Guardrail G3b: ${actionNetwork} is healthy but ${bestGenNet} has the oldest lastPostMs; redirecting GENERATE_POSTS to ${bestGenNet}`
            : `Guardrail G3b: ${actionNetwork} is not ready for generation; redirecting GENERATE_POSTS to ${bestGenNet}`
          : `Guardrail G3b: no network specified; redirecting GENERATE_POSTS to ${bestGenNet}`;
        return {
          type: 'GENERATE_POSTS' as const,
          network: bestGenNet,
          reason: why,
          source: 'guardrail_override',
        };
      }
      if (!bestGenNet) {
        return WAIT_ACTION(
          `No healthy network available for GENERATE_POSTS`,
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
        // BANNED sessions are terminal — do not attempt to recover them, and do not
        // let the LLM keep selecting them for POST/BROWSE. A WAIT gives the next
        // cycle a chance to pick a healthy network (the orchestrator prompt includes
        // session status so the LLM should avoid BANNED networks on retry).
        if (session.status === 'BANNED') {
          return WAIT_ACTION(`Session ${action.network} is banned`, 300000, 'guardrail_override');
        }
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
}
