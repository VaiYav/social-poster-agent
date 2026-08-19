/**
 * English-only engagement tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EngagementDecisionService } from '../../../src/modules/engagement/engagement-decision.service';
import {
  ENGAGEMENT_DECISION_PROMPT,
  ENGAGEMENT_COMMENT_PROMPT,
  ENGAGEMENT_QUOTE_PROMPT,
  ENGAGEMENT_BATCH_DECISION_PROMPT,
  COMMENT_JUDGE_PROMPT,
} from '../../../src/infrastructure/llm/prompts/v0.4.0/engagement-decision.js';
import type { ILlmPort, LlmResponse } from '../../../src/domain/ports/llm.port';
import type { PostContext } from '../../../src/domain/ports/engagement-decision.port';

function createMockLlm(response: string): ILlmPort {
  return {
    generateChat: vi.fn().mockResolvedValue({ content: response, model: 'mock' }),
    generate: vi.fn(),
    getPromptVersion: vi.fn(),
  } as unknown as ILlmPort;
}

function createPostContext(overrides: Partial<PostContext> = {}): PostContext {
  return {
    network: 'X',
    postUrl: 'https://x.com/user/status/123',
    postText: 'Remote Work in Q1 brings energy and initiative today.',
    hasMedia: false,
    source: 'home-feed',
    likesThisSession: 0,
    commentsThisSession: 0,
    likesMaxPerSession: 15,
    commentsMaxPerSession: 4,
    ...overrides,
  };
}

describe('Engagement English-only prompts', () => {
  it('EE-001: decision prompt requires English-only comments and quotes', () => {
    expect(ENGAGEMENT_DECISION_PROMPT.systemPrompt).toContain('English only');
    expect(ENGAGEMENT_BATCH_DECISION_PROMPT.userPrompt).toContain('English only');
  });

  it('EE-002: comment and quote prompts require English only', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('English only');
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('English only');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).not.toContain('Ukrainian post');
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).not.toContain('Italian');
  });

  it('EE-003: comment judge checks for English only', () => {
    expect(COMMENT_JUDGE_PROMPT.systemPrompt).toContain('English only');
  });
});

describe('EngagementDecisionService English-only guards', () => {
  it('EE-004: generateComment returns null for a non-English post', async () => {
    const llm = createMockLlm('A comment in English.');
    const config = { get: vi.fn().mockReturnValue(0.7) } as unknown as ConfigService;
    const service = new EngagementDecisionService(llm, config);
    const comment = await service.generateComment(
      createPostContext({ postText: 'Продуктивность в Q1 сегодня' }),
    );
    expect(comment).toBeNull();
    expect(llm.generateChat).not.toHaveBeenCalled();
  });

  it('EE-005: generateQuoteText returns null for a non-English post', async () => {
    const llm = createMockLlm('A quote in English.');
    const config = { get: vi.fn().mockReturnValue(0.7) } as unknown as ConfigService;
    const service = new EngagementDecisionService(llm, config);
    const quote = await service.generateQuoteText(
      createPostContext({ postText: 'Продуктивність у Q1 сьогодні' }),
    );
    expect(quote).toBeNull();
    expect(llm.generateChat).not.toHaveBeenCalled();
  });
});
