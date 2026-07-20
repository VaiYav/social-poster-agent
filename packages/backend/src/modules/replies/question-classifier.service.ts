/**
 * Sprint Q+: Question classifier for incoming comments.
 *
 * Determines whether a comment is a genuine question and what kind.
 * Used by DialogueGraph to decide whether to answer or skip.
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { IPromptPort } from '../../domain/ports/prompt.port.js';
import { interpolate } from '../../domain/prompt-interpolation.js';
import { QUESTION_CLASSIFIER_PROMPT } from './prompts/question-classifier.prompt.js';
import { sanitizeUntrustedInput } from '../../infrastructure/llm/sanitize-untrusted-input.js';

export interface QuestionClassification {
  isQuestion: boolean;
  confidence: number;
  questionType: 'factual' | 'opinion' | 'personal' | 'offtopic' | null;
  reason: string;
}

const VALID_TYPES = new Set(['factual', 'opinion', 'personal', 'offtopic']);

@Injectable()
export class QuestionClassifierService {
  private readonly logger = new Logger(QuestionClassifierService.name);
  private readonly temperature: number;

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly configService: ConfigService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
  ) {
    const rawTemp = Number(this.configService.get<string>('REPLIES_QUESTION_TEMPERATURE', '0.3'));
    this.temperature = Number.isFinite(rawTemp) && rawTemp >= 0 && rawTemp <= 2 ? rawTemp : 0.3;
  }

  /**
   * Classify a single comment.
   * All text is sanitized before being interpolated into the prompt.
   */
  async classify(text: string, detectedLanguage: string): Promise<QuestionClassification> {
    const systemPrompt = await this.getCompiledText(
      'question-classifier',
      { detectedLanguage },
      QUESTION_CLASSIFIER_PROMPT,
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
        this.logger.warn('Question classifier: no JSON found in response');
        return this.fallback(text, 'no JSON');
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        this.logger.warn('Question classifier: JSON parse failed');
        return this.fallback(text, 'JSON parse failed');
      }

      const isQuestion = parsed.isQuestion === true;
      const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      const rawType = typeof parsed.questionType === 'string' ? parsed.questionType : null;
      const questionType = rawType && VALID_TYPES.has(rawType) ? (rawType as QuestionClassification['questionType']) : null;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unknown';

      return { isQuestion, confidence, questionType, reason };
    } catch (err) {
      this.logger.warn(`Question classifier LLM failed: ${(err as Error).message}`);
      return this.fallback(text, (err as Error).message);
    }
  }

  /**
   * Fallback when the LLM is unavailable or returns malformed output.
   * Uses a simple heuristic: presence of '?' and question-like words.
   */
  private fallback(text: string, reason: string): QuestionClassification {
    const hasQuestionMark = text.includes('?');
    const questionWords = /\b(what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|am|have|has|had|should|may|might|mean|means)\b/gi;
    const matches = text.match(questionWords);
    const isQuestion = hasQuestionMark || (matches ? matches.length >= 2 : false);
    return {
      isQuestion,
      confidence: isQuestion ? 0.5 : 0.0,
      questionType: null,
      reason: `fallback (${reason})`,
    };
  }

  private async getCompiledText(name: string, variables: Record<string, string>, fallback: string): Promise<string> {
    if (this.promptPort) {
      return this.promptPort.getCompiledText(name, variables, fallback);
    }
    return interpolate(fallback, variables);
  }
}
