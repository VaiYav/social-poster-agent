/**
 * English-only reply decision tests.
 *
 * Verifies that the DialogueGraph always produces English replies and downgrades
 * any non-English output to human review.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  compileDialogueGraph,
  createDialogueState,
  type DialogueDecision,
} from '../../../src/modules/replies/dialogue.graph.js';
import { REPLY_DECISION_PROMPT } from '../../../src/modules/replies/prompts/reply-decision.prompt.js';
import type { ILlmPort, LlmResponse } from '../../../src/domain/ports/llm.port.js';
import type { QuestionClassification } from '../../../src/modules/replies/question-classifier.service.js';
import type { ToneAnalysis } from '../../../src/modules/replies/tone-analyzer.service.js';

function makeMockLlm(content: string): ILlmPort {
  return {
    generateChat: vi.fn(async (_system: string, _user: string): Promise<LlmResponse> => ({
      content,
      model: 'mock',
    })),
    generate: vi.fn(),
    getPromptVersion: vi.fn(),
  } as unknown as ILlmPort;
}

function makeMockQuestionClassifier(): {
  classify: (text: string, detectedLanguage: string) => Promise<QuestionClassification>;
} {
  return {
    classify: vi.fn().mockResolvedValue({
      isQuestion: true,
      confidence: 0.9,
      questionType: 'factual',
      reason: 'genuine question in English',
    }),
  };
}

function makeMockToneAnalyzer(): {
  detectTone: (text: string, detectedLanguage: string) => ToneAnalysis;
} {
  return {
    detectTone: vi.fn().mockReturnValue({
      tone: 'neutral',
      confidence: 0.8,
      reason: 'neutral tone',
    }),
  };
}

describe('DialogueGraph English-only replies', () => {
  it('RE-001: keeps English replies', async () => {
    const llm = makeMockLlm(
      JSON.stringify({
        action: 'auto_reply',
        reason: 'answer the question',
        detectedLanguage: 'en',
        replyText: 'Honestly? Most people never hit the cap.',
      }),
    );
    const questionClassifier = makeMockQuestionClassifier();
    const toneAnalyzer = makeMockToneAnalyzer();
    const graph = compileDialogueGraph({
      llm,
      questionClassifier: questionClassifier as any,
      toneAnalyzer: toneAnalyzer as any,
    });

    const state = createDialogueState({
      conversationId: 'c1',
      postId: 'p1',
      network: 'X',
      postContent: 'Is the free trial really that limited?',
      detectedLanguage: 'en',
      maxDepth: 3,
      autoReplyComplexity: 'medium',
      messages: [
        { role: 'user', author: 'user1', text: 'Is the free trial really that limited?', commentId: 'm1', depth: 0 },
      ],
    });

    const result = (await graph.invoke(state)) as { decision: DialogueDecision };
    expect(result.decision?.action).toBe('auto_reply');
    expect(result.decision?.replyText).toBe('Honestly? Most people never hit the cap.');
    expect(result.decision?.detectedLanguage).toBe('en');
  });

  it('RE-002: downgrades non-English reply to human review', async () => {
    const llm = makeMockLlm(
      JSON.stringify({
        action: 'auto_reply',
        reason: 'answer the question',
        detectedLanguage: 'en',
        replyText: 'Это правило двух недель ударило меня в 28...',
      }),
    );
    const questionClassifier = makeMockQuestionClassifier();
    const toneAnalyzer = makeMockToneAnalyzer();
    const graph = compileDialogueGraph({
      llm,
      questionClassifier: questionClassifier as any,
      toneAnalyzer: toneAnalyzer as any,
    });

    const state = createDialogueState({
      conversationId: 'c1',
      postId: 'p1',
      network: 'X',
      postContent: 'Original post in English',
      detectedLanguage: 'ru',
      maxDepth: 3,
      autoReplyComplexity: 'medium',
      messages: [
        { role: 'user', author: 'user1', text: 'Продуктивность в Q1 сегодня', commentId: 'm1', depth: 0 },
      ],
    });

    const result = (await graph.invoke(state)) as { decision: DialogueDecision };
    expect(result.decision?.action).toBe('human_review');
    expect(result.decision?.replyText).toBeUndefined();
    expect(result.decision?.reviewReason).toMatch(/not in English|non-English/i);
  });

  it('RE-003: reply-decision prompt contains English-only instruction and comment language context', () => {
    expect(REPLY_DECISION_PROMPT).toContain('REPLY LANGUAGE');
    expect(REPLY_DECISION_PROMPT).toContain('English only');
    expect(REPLY_DECISION_PROMPT).toContain('Original comment language: {commentLanguage}');
    expect(REPLY_DECISION_PROMPT).toContain('"detectedLanguage": "en"');
  });
});
