/**
 * LlmDecisionService — Phase 2 of DECIDE: LLM-based action selection.
 *
 * Calls the LLM with the orchestrator prompt, parses the JSON response
 * into an Action. Falls back to rules-only on LLM failure or timeout.
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { LangfuseService } from '../../infrastructure/langfuse/langfuse.service.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { combineSignals } from '../../infrastructure/util/abort-signal.js';
import { ORCHESTRATOR_SYSTEM_PROMPT, buildOrchestratorUserPrompt } from './prompts/orchestrator-prompt.js';
import type { WorldState, Action, ActionType, NetworkActionType, GenericActionType } from './types.js';

const LLM_TIMEOUT_MS_DEFAULT = 30000;

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
  private readonly llmTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(ILlmPort) private readonly llm?: ILlmPort,
    @Optional() private readonly langfuse?: LangfuseService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    this.llmTimeoutMs = Math.max(
      5000,
      Number(this.configService.get<string>('ORCHESTRATOR_LLM_TIMEOUT_MS', String(LLM_TIMEOUT_MS_DEFAULT))),
    );
  }

  async decide(world: WorldState, signal?: AbortSignal): Promise<Action> {
    if (!this.llm) throw new Error('LLM port not available');

    const userPrompt = buildOrchestratorUserPrompt(world);

    // Fetch system prompt from Langfuse Prompt Management (falls back to local constant)
    const systemPrompt = this.promptPort
      ? await this.promptPort.getCompiledText('orchestrator-system', {}, ORCHESTRATOR_SYSTEM_PROMPT)
      : ORCHESTRATOR_SYSTEM_PROMPT;

    // Langfuse tracing: each orchestrator decision gets its own trace.
    // tags enable filtering orchestrator decisions from generation traces.
    // promptNames links this trace to the Langfuse Prompt Management prompt used.
    const handler = this.langfuse?.createHandler({
      tags: ['orchestrator', 'decision'],
      traceMetadata: {
        utcHour: world.utcHour,
        utcDayOfWeek: world.utcDayOfWeek,
        degraded: world._degraded,
        promptNames: 'orchestrator-system',
      },
    });
    const callbacks = handler ? [handler] : undefined;

    const controller = new AbortController();
    const stopSignal = combineSignals(controller.signal, signal);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('LLM timeout'));
      }, this.llmTimeoutMs);
    });

    const llmPromise = this.llm.generateChat(systemPrompt, userPrompt, {
      temperature: 0.3,
      maxTokens: 200,
      callbacks,
      signal: stopSignal,
    });

    // 2.6.4: clear the timeout and suppress the LLM promise rejection when the
    // timeout wins. The original llmPromise is still observed by Promise.race.
    llmPromise
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      })
      .catch(() => {});

    try {
      const result = await Promise.race([llmPromise, timeoutPromise]);

      const action = this.parseLlmResponse(result.content);
      this.logger.debug(`LLM decision: ${action.type}:${action.network} — ${action.reason}`);
      return action;
    } finally {
      // Abort the local controller so the combined signal cleans up its
      // listeners on the orchestrator graph's long-lived signal.
      controller.abort();
    }
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
      // LLM sometimes returns pipe-separated networks (e.g. "X|THREADS") or
      // invalid values. Validate against the SocialNetwork enum and pick the
      // first valid one; throw if none match (triggers rules fallback).
      const validNetworks = new Set<string>(Object.values(SocialNetwork));
      const candidates = String(networkRaw).split('|').map((s) => s.trim().toUpperCase());
      const validNetwork = candidates.find((c) => validNetworks.has(c));
      if (!validNetwork) {
        throw new Error(`Invalid network "${networkRaw}" for ${actionType}`);
      }
      return {
        type: actionType as NetworkActionType,
        network: validNetwork as SocialNetwork,
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
