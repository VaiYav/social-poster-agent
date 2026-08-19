/**
 * English-only generation tests.
 *
 * Verifies that prompts and graph state force English output regardless of
 * any multilingual configuration or topic metadata.
 */
import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../../src/modules/generation/generation.graph.js';
import { createArticleInitialState } from '../../../src/modules/generation/article-graph.js';
import { GenerationService } from '../../../src/modules/generation/generation.service.js';
import {
  RESEARCH_EXTRACT_PROMPT,
  HOOK_GENERATION_PROMPT,
  DRAFT_POST_PROMPT,
  CRITIQUE_POST_PROMPT,
  REFINE_POST_PROMPT,
  ARTICLE_RESEARCH_EXTRACT_PROMPT,
  ARTICLE_OUTLINE_PROMPT,
  ARTICLE_DRAFT_PROMPT,
  ARTICLE_REFINE_PROMPT,
} from '../../../src/modules/generation/prompts/fallback-prompts.js';
import { TOPIC_GENERATION_PROMPT } from '../../../src/infrastructure/content/prompts/topic-generation-prompt.js';
import { SocialNetwork } from '@prisma/client';
import { createMockConfigService } from '../../mocks/index.js';

function createTopic() {
  return {
    id: 'topic-1',
    topic: 'Why Your To-Do List Gets Longer After 2 p.m.',
    keywords: ['productivity', 'focus'],
    category: 'productivity',
    outline: [],
    facts: [],
    source: 'test' as const,
  };
}

describe('English-only generation prompts', () => {
  it('research extract prompt requires English only', () => {
    expect(RESEARCH_EXTRACT_PROMPT.systemPrompt).toContain('English only');
    expect(RESEARCH_EXTRACT_PROMPT.userPrompt).toContain('English only');
  });

  it('hook generation prompt requires English only', () => {
    expect(HOOK_GENERATION_PROMPT.systemPrompt).toContain('English only');
  });

  it('draft post prompt requires English only', () => {
    expect(DRAFT_POST_PROMPT.systemPrompt).toContain('English only');
    expect(DRAFT_POST_PROMPT.systemPrompt).not.toContain('Ukrainian comment');
    expect(DRAFT_POST_PROMPT.systemPrompt).not.toContain('Russian and Ukrainian are DIFFERENT');
  });

  it('critique post prompt checks for English only', () => {
    expect(CRITIQUE_POST_PROMPT).toContain('written in English only');
  });

  it('refine post prompt requires English only', () => {
    expect(REFINE_POST_PROMPT).toContain('English only');
    expect(REFINE_POST_PROMPT).not.toContain('Ukrainian');
    expect(REFINE_POST_PROMPT).not.toContain('Russian and Ukrainian are DIFFERENT');
  });

  it('article prompts require English only', () => {
    expect(ARTICLE_RESEARCH_EXTRACT_PROMPT.systemPrompt).toContain('English only');
    expect(ARTICLE_RESEARCH_EXTRACT_PROMPT.userPrompt).toContain('English only');
    expect(ARTICLE_OUTLINE_PROMPT).toContain('English only');
    expect(ARTICLE_DRAFT_PROMPT.systemPrompt).toContain('English only');
    expect(ARTICLE_REFINE_PROMPT).toContain('English only');
  });

  it('topic generation prompt requires English only', () => {
    expect(TOPIC_GENERATION_PROMPT.systemPrompt).toContain('English only');
    expect(TOPIC_GENERATION_PROMPT.userPrompt).toContain('English only');
  });
});

describe('English-only generation state', () => {
  it('createInitialState forces language to en', () => {
    const state = createInitialState(createTopic(), [SocialNetwork.X], 'brand voice', false, 'ru');
    expect(state.language).toBe('en');
  });

  it('createArticleInitialState forces language to en', () => {
    const state = createArticleInitialState(
      { topic: 'test', language: 'uk' },
      'article-run-id',
    );
    expect(state.language).toBe('en');
  });
});

describe('GenerationService posting languages', () => {
  function buildService(config: any): any {
    // Only the ConfigService matters for postingLanguages; everything else can be undefined.
    return new GenerationService(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      config,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
  }

  it('filters non-English POSTING_LANGUAGES to en only', () => {
    const config = createMockConfigService({ POSTING_LANGUAGES: 'en,ru,uk,es' });
    const service = buildService(config);
    expect(service.postingLanguages).toEqual(['en']);
  });

  it('defaults to en when POSTING_LANGUAGES is missing', () => {
    const config = createMockConfigService({});
    const service = buildService(config);
    expect(service.postingLanguages).toEqual(['en']);
  });
});
