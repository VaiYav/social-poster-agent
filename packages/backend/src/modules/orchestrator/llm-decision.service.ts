/**
 * LlmDecisionService — Phase 2 of DECIDE: LLM-based action selection.
 *
 * Calls the LLM with the orchestrator prompt, parses the JSON response
 * into an Action. Falls back to rules-only on LLM failure or timeout.
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { ORCHESTRATOR_SYSTEM_PROMPT, buildOrchestratorUserPrompt } from './prompts/orchestrator-prompt.js';
import type { WorldState, Action, ActionType, NetworkActionType, GenericActionType } from './types.js';

const LLM_TIMEOUT_MS = 10000;

const VALID_ACTIONS: ActionType[] = [
  'GENERATE_TOPICS', 'GENERATE_POSTS', 'POST', 'BROWSE',
  'RECOVER_SESSION', 'CHECK_REPLIES', 'REFRESH_TRENDS',
  'HEALTH_CHECK', 'RECONCILE', 'SCRAPE_METRICS',
  'RECYCLE_CONTENT', 'AGGREGATE_HOOKS', 'WAIT',
];

const NETWORK_ACTION_TYPES: ReadonlySet<string> = new Set(['POST', 'BROWSE', 'RECOVER_SESSION']);

@Injectable()
export class LlmDecisionService {
  private readonly logger = new Logger(LlmDecisionService.name);

  constructor(
    @Optional() @Inject(ILlmPort) private readonly llm?: ILlmPort,
  ) {}

  async decide(world: WorldState): Promise<Action> {
    if (!this.llm) throw new Error('LLM port not available');

    const userPrompt = buildOrchestratorUserPrompt(world);

    const result = await Promise.race([
      this.llm.generateChat(ORCHESTRATOR_SYSTEM_PROMPT, userPrompt, {
        temperature: 0.3,
        maxTokens: 200,
      }),
      this.timeout(),
    ]);

    const action = this.parseLlmResponse(result.content);
    this.logger.debug(`LLM decision: ${action.type}:${action.network} — ${action.reason}`);
    return action;
  }

  private timeout(): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM timeout')), LLM_TIMEOUT_MS),
    );
  }

  private parseLlmResponse(text: string): Action {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const actionType = String(parsed.action).toUpperCase() as ActionType;
    const networkRaw = parsed.network && parsed.network !== 'null' ? parsed.network : undefined;
    const reason = String(parsed.reason ?? 'LLM decision');

    if (!VALID_ACTIONS.includes(actionType)) {
      throw new Error(`Invalid action type: ${actionType}`);
    }

    if (NETWORK_ACTION_TYPES.has(actionType)) {
      if (!networkRaw) {
        throw new Error(`${actionType} requires a network`);
      }
      return {
        type: actionType as NetworkActionType,
        network: networkRaw as SocialNetwork,
        reason,
        source: 'llm',
      };
    }
    return {
      type: actionType as GenericActionType,
      network: networkRaw as SocialNetwork | undefined,
      reason,
      source: 'llm',
    };
  }
}
