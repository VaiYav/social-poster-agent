/**
 * GuardrailsService — Phase 3 of DECIDE: validate + clamp LLM output (G1-G7).
 *
 * Each guardrail checks a specific safety condition and overrides
 * the action with a WAIT if the condition is violated.
 */

import { Injectable } from '@nestjs/common';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';
import type { WorldState, Action } from './types.js';
import { WAIT_ACTION, RECOVER_ACTION } from './types.js';

@Injectable()
export class GuardrailsService {
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

    // G3: POST requires rate limit remaining
    if (action.type === 'POST' && action.network) {
      const remaining = world.rateLimits[action.network]?.dailyRemaining ?? 0;
      if (remaining === 0) {
        return WAIT_ACTION(`Rate limit exhausted for ${action.network}`, 300000, 'guardrail_override');
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
}
