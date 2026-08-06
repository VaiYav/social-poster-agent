/**
 * F4: Comment safety classifier — LLM-based injection/spam/toxic/sensitive detection.
 *
 * Runs as a brand-safety gate before the reply decision. Comments flagged as
 * injection/spam are skipped silently; toxic/sensitive comments are escalated
 * to human review. Returns 'none' for genuine comments.
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import { COMMENT_SAFETY_PROMPT } from './prompts/comment-safety.prompt.js';
import { sanitizeUntrustedInput } from '../../infrastructure/llm/sanitize-untrusted-input.js';
import { detectSensitive, isLikelyTroll, isLowValueComment } from './sensitive-filter.js';

export interface CommentSafetyClassification {
  risk: 'none' | 'injection' | 'spam' | 'toxic' | 'sensitive';
  confidence: number;
  reason: string;
}

const VALID_RISKS = new Set(['none', 'injection', 'spam', 'toxic', 'sensitive']);

@Injectable()
export class CommentSafetyClassifierService {
  private readonly logger = new Logger(CommentSafetyClassifierService.name);
  private readonly temperature: number;

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly configService: ConfigService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    const rawTemp = Number(this.configService.get<string>('REPLIES_SAFETY_TEMPERATURE', '0.2'));
    this.temperature = Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 2 ? rawTemp : 0.2;
  }

  /**
   * Classify a comment for brand-safety risk.
   * Returns the LLM classification, or a deterministic fallback when the LLM fails.
   */
  async classify(text: string, detectedLanguage: string): Promise<CommentSafetyClassification> {
    const systemPrompt = await this.getCompiledText(
      'comment-safety',
      { detectedLanguage },
      COMMENT_SAFETY_PROMPT,
    );

    const userPrompt = `Comment language: ${detectedLanguage}

Comment: "${sanitizeUntrustedInput(text)}"

Return JSON only.`;

    try {
      const response = await this.llm.generateChat(systemPrompt, userPrompt, {
        temperature: this.temperature,
        role: 'utility',
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('Comment safety classifier: no JSON found in response');
        return this.fallback(text);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        this.logger.warn('Comment safety classifier: JSON parse failed');
        return this.fallback(text);
      }

      const rawRisk = typeof parsed.risk === 'string' ? parsed.risk : 'none';
      const risk = VALID_RISKS.has(rawRisk) ? (rawRisk as CommentSafetyClassification['risk']) : 'none';
      const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unknown';

      return { risk, confidence, reason };
    } catch (err) {
      this.logger.warn(`Comment safety classifier LLM failed: ${(err as Error).message}`);
      return this.fallback(text);
    }
  }

  /**
   * Fallback classification when the LLM is unavailable or returns malformed output.
   * Uses the deterministic sensitive/troll/low-value filters already in the pipeline.
   */
  private fallback(text: string): CommentSafetyClassification {
    const sensitive = detectSensitive(text);
    if (sensitive.sensitive) {
      return {
        risk: sensitive.kind === 'crisis' ? 'sensitive' : 'sensitive',
        confidence: 0.7,
        reason: sensitive.reason ?? 'Deterministic sensitive filter triggered',
      };
    }
    if (isLikelyTroll(text)) {
      return { risk: 'toxic', confidence: 0.6, reason: 'Troll/spam keyword detected' };
    }
    const lowValue = isLowValueComment(text);
    if (lowValue.lowValue) {
      return { risk: 'none', confidence: 0.8, reason: lowValue.reason ?? 'Low-value comment' };
    }
    return { risk: 'none', confidence: 0.5, reason: 'LLM safety check unavailable — treating as safe' };
  }

  private async getCompiledText(name: string, variables: Record<string, string>, fallback: string): Promise<string> {
    if (this.promptPort) {
      return this.promptPort.getCompiledText(name, variables, fallback);
    }
    return interpolate(fallback, variables);
  }
}
