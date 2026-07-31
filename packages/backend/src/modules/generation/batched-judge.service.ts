/**
 * BatchedJudgeService — judges all network variants for a topic in ONE LLM call.
 *
 * Reduces the per-topic judge cost from 3 calls (X, THREADS, FACEBOOK) to 1
 * per iteration of the retry loop. Caches results by content hash so concurrent
 * per-network judge nodes share the same promise and the same batch result.
 */
import { Logger } from '@nestjs/common';
import type { SocialNetwork } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';
import type { ILlmPort } from '../../domain/ports/llm.port.js';
import type { IPromptPort } from '../../domain/ports/prompt.port.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import {
  JUDGE_BATCH_FALLBACK,
  JUDGE_BATCH_SYSTEM_PROMPT,
  JUDGE_BATCH_USER_PROMPT_TEMPLATE,
} from './prompts/judge-batch-prompt.js';

export interface BatchJudgeInput {
  network: SocialNetwork;
  content: string;
  charLimit: number;
  factsText: string;
  slopList: string;
}

export class BatchedJudgeService {
  private readonly logger = new Logger(BatchedJudgeService.name);

  private readonly resultsCache = new Map<string, Promise<Record<string, JudgeScores>>>();
  private readonly inProgress = new Map<string, Promise<Record<string, JudgeScores>>>();

  constructor(
    private readonly llm: ILlmPort,
    private readonly promptPort: IPromptPort,
    private readonly maxTokens = 1200,
  ) {}

  /**
   * Get (or run) a batched judgment for a list of posts.
   * Safe for concurrent per-network judge nodes: the first caller starts the
   * batch and later callers for the same content hash receive the same promise.
   */
  async judgeBatch(inputs: BatchJudgeInput[]): Promise<Record<string, JudgeScores>> {
    if (inputs.length === 0) return {};
    const key = this.makeKey(inputs);

    const cached = this.resultsCache.get(key);
    if (cached) return cached;

    const inProgress = this.inProgress.get(key);
    if (inProgress) return inProgress;

    const promise = this.runJudgeBatch(inputs, key);
    this.inProgress.set(key, promise);
    return promise;
  }

  private makeKey(inputs: BatchJudgeInput[]): string {
    // Include content + network + facts so a retry with a refined rewrite re-runs.
    return inputs
      .sort((a, b) => a.network.localeCompare(b.network))
      .map((i) => `${i.network}:${i.factsText}:${i.content}`)
      .join(':::');
  }

  private async runJudgeBatch(inputs: BatchJudgeInput[], key: string): Promise<Record<string, JudgeScores>> {
    try {
      const batchText = inputs
        .map(
          (i, idx) =>
            `[POST ${idx + 1}]\nNetwork: ${i.network}\nCharacter limit: ${i.charLimit}\nSlop list: ${i.slopList}\nText:\n"""${i.content}"""`,
        )
        .join('\n\n---\n\n');

      const facts = inputs[0]?.factsText ?? '- (no source facts provided)';
      const compiled = this.promptPort
        ? await this.promptPort.getCompiledChat(
            'post-quality-judge-batch',
            { facts, batch: batchText },
            JUDGE_BATCH_FALLBACK,
          )
        : {
            systemPrompt: interpolate(JUDGE_BATCH_SYSTEM_PROMPT, {}),
            userPrompt: interpolate(JUDGE_BATCH_USER_PROMPT_TEMPLATE, { facts, batch: batchText }),
          };

      const response = await this.llm.generateChat(compiled.systemPrompt, compiled.userPrompt, {
        temperature: 0.2,
        maxTokens: this.maxTokens,
        role: 'judge',
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON in batched judge response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.judgments)) {
        throw new Error('Invalid batched judge JSON structure');
      }

      const judgments = parsed.judgments as unknown[];
      if (judgments.length < inputs.length) {
        throw new Error(`Batched judge returned ${judgments.length} judgments for ${inputs.length} posts`);
      }

      const out: Record<string, JudgeScores> = {};
      const inputByNetwork = new Map(inputs.map((i) => [i.network, i]));
      for (let i = 0; i < judgments.length; i++) {
        const raw = judgments[i] as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== 'object') continue;

        // Prefer the network field from the LLM output; fall back to input order.
        const network =
          typeof raw.network === 'string' && inputByNetwork.has(raw.network as SocialNetwork)
            ? (raw.network as SocialNetwork)
            : inputs[i]?.network;
        if (!network) continue;

        out[network] = {
          anti_ai_tone: this.clamp01(raw.anti_ai_tone),
          anti_ai_tone_reason: String(raw.anti_ai_tone_reason ?? ''),
          hook_strength: this.clamp01(raw.hook_strength),
          hook_strength_reason: String(raw.hook_strength_reason ?? ''),
          factual_accuracy: this.clamp01(raw.factual_accuracy),
          factual_accuracy_reason: String(raw.factual_accuracy_reason ?? ''),
          character_limit: this.clamp01(raw.character_limit),
          character_limit_reason: String(raw.character_limit_reason ?? ''),
        };
      }

      this.logger.debug(`Batched judge for ${inputs.map((i) => i.network).join(', ')}: ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { anti: v.anti_ai_tone, hook: v.hook_strength, factual: v.factual_accuracy, chars: v.character_limit }])))}`);
      this.resultsCache.set(key, Promise.resolve(out));
      return out;
    } catch (err) {
      this.resultsCache.delete(key);
      throw err;
    } finally {
      this.inProgress.delete(key);
    }
  }

  private clamp01(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }
}
