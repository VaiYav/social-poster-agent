/**
 * Unit tests for article-graph.ts — article generation LangGraph (#7, #15).
 *
 * Tests real LLM node implementations: research_extract, outline, draft,
 * judge, refine, set_canonical, save_to_db.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildArticleGraph,
  createArticleInitialState,
} from '../../../src/modules/generation/article-graph.js';
import type { ILlmPort, LlmResponse } from '../../../src/domain/ports/llm.port.js';
import type { IPromptPort, CompiledChatPrompt } from '../../../src/domain/ports/prompt.port.js';

// ============================================================
// Mock LLM — returns canned responses per role
// ============================================================

function createMockLlm(responses: Partial<Record<string, string>> = {}): ILlmPort {
  const defaults: Record<string, string> = {
    facts: '1. Workflow takes 18 months to mature in the brand\n2. Workflow in learning happens every 2 years\n3. learning is shaped by Workflow',
    outline: '## Introduction\n- Why Workflow in learning matters\n- Estimated: 300 words\n\n## Workflow in learning: The Energy\n- Restless curiosity\n- Estimated: 400 words\n\n## Conclusion\n- Summary\n- Estimated: 200 words',
    draft: '# Workflow in learning 2026: What to Expect\n\nWorkflow demand rises in March 2026, bringing restless energy...\n\n## Workflow in learning: The Energy\n\nWhen workflow surges learning, curiosity doubles.\n\n## Conclusion\n\nWorkflow in learning is a time for focused exploration.',
    judge: '{"anti_ai_tone":0.75,"anti_ai_tone_reason":"good","hook_strength":0.8,"hook_strength_reason":"strong","factual_accuracy":0.85,"factual_accuracy_reason":"correct","structure_quality":0.7,"structure_quality_reason":"ok","seo_optimization":0.72,"seo_optimization_reason":"decent"}',
    refine: '# Workflow in learning 2026: The Ultimate Guide\n\nWhen Workflow enters learning in March 2026, prepare for a whirlwind of mental energy...\n\n## The Energy of Workflow in learning\n\nWorkflow in learning is restless, curious, and never satisfied with one topic.\n\n## Conclusion\n\nEmbrace the mental chaos.',
  };

  const merged = { ...defaults, ...responses };

  return {
    generate: vi.fn().mockResolvedValue({ content: 'mock', model: 'test', tokens: 10 } as LlmResponse),
    generateChat: vi.fn().mockImplementation((_sys: string, _user: string, opts?: { role?: string }) => {
      const role = opts?.role ?? 'default';
      const content = merged[role] ?? 'mock response';
      return Promise.resolve({ content, model: 'test', tokens: 100 } as LlmResponse);
    }),
    generateVision: vi.fn().mockResolvedValue({ content: 'mock', model: 'test', tokens: 10 } as LlmResponse),
    getPromptVersion: vi.fn().mockReturnValue('test'),
  } as unknown as ILlmPort;
}

function createMockPromptPort(): IPromptPort {
  return {
    getCompiledChat: vi.fn().mockResolvedValue({
      systemPrompt: 'test system',
      userPrompt: 'test user',
    } as CompiledChatPrompt),
    getCompiledText: vi.fn().mockResolvedValue('test text prompt'),
  } as unknown as IPromptPort;
}

function createMockCanonicalService() {
  return {
    buildBlogUrl: vi.fn().mockReturnValue('https://example.com/blog/test-slug'),
    setCanonical: vi.fn().mockResolvedValue(undefined),
    addSyndicatedUrl: vi.fn().mockResolvedValue(undefined),
    verifyCanonical: vi.fn().mockResolvedValue(true),
    slugify: vi.fn().mockReturnValue('test-slug'),
  };
}

describe('Article Generation Graph', () => {
  let mockLlm: ILlmPort;
  let mockPromptPort: IPromptPort;
  let mockCanonical: ReturnType<typeof createMockCanonicalService>;

  beforeEach(() => {
    mockLlm = createMockLlm();
    mockPromptPort = createMockPromptPort();
    mockCanonical = createMockCanonicalService();
  });

  // ============================================================
  // State creation
  // ============================================================

  describe('createArticleInitialState()', () => {
    it('AG-001: creates initial state with topic and target networks', () => {
      const state = createArticleInitialState({
        topic: 'Workflow in learning 2026',
        targetNetworks: ['DEVTO', 'HASHNODE', 'LINKEDIN'],
        language: 'en',
      }, 'run-001');

      expect(state.topic).toBe('Workflow in learning 2026');
      expect(state.targetNetworks).toEqual(['DEVTO', 'HASHNODE', 'LINKEDIN']);
      expect(state.language).toBe('en');
      expect(state.runId).toBe('run-001');
      expect(state.facts).toEqual([]);
      expect(state.outline).toEqual([]);
      expect(state.refineCount).toBe(0);
    });

    it('AG-002: defaults language to en when not specified', () => {
      const state = createArticleInitialState({
        topic: 'Test topic',
        targetNetworks: ['DEVTO'],
      }, 'run-002');

      expect(state.language).toBe('en');
    });
  });

  // ============================================================
  // Graph compilation
  // ============================================================

  describe('buildArticleGraph()', () => {
    it('AG-003: compiles without errors', () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      expect(graph).toBeDefined();
      expect(typeof graph.invoke).toBe('function');
    });

    it('AG-004: compiles with null promptPort (uses inline fallbacks)', () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: null,
        canonicalService: mockCanonical as never,
      });

      expect(graph).toBeDefined();
    });
  });

  // ============================================================
  // Real LLM node behavior (Phase 1 — P1-05)
  // ============================================================

  describe('research_extract node', () => {
    it('AG-010: extracts facts from LLM response', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
        keywords: ['workflow', 'learning'],
      }, 'run-010');

      const result = await graph.invoke(state);

      // Facts should be extracted from the numbered list
      expect(result.facts.length).toBeGreaterThan(0);
      expect(result.facts[0]).toContain('Workflow');
    });

    it('AG-011: handles LLM failure gracefully — returns empty facts', async () => {
      const failingLlm = createMockLlm();
      (failingLlm.generateChat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM down'));

      const graph = buildArticleGraph({
        llm: failingLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Test',
        targetNetworks: ['DEVTO'],
      }, 'run-011');

      const result = await graph.invoke(state);

      expect(result.facts).toEqual([]);
      expect(result.error).toContain('research_extract');
    });
  });

  describe('outline node', () => {
    it('AG-020: parses markdown outline into sections', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-020');

      const result = await graph.invoke(state);

      expect(result.outline.length).toBeGreaterThan(0);
      expect(result.outline[0].heading).toBeDefined();
      expect(result.outline[0].level).toBe(2);
    });
  });

  describe('draft_article node', () => {
    it('AG-030: generates article with title, slug, bodyMarkdown', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
        keywords: ['workflow', 'learning', 'productivity'],
      }, 'run-030');

      const result = await graph.invoke(state);

      expect(result.draft).not.toBeNull();
      expect(result.draft?.title).toContain('Workflow in learning');
      expect(result.draft?.slug).toMatch(/^workflow-in-learning/);
      expect(result.draft?.bodyMarkdown.length).toBeGreaterThan(50);
      expect(result.draft?.tags).toEqual(['workflow', 'learning', 'productivity']);
    });
  });

  describe('judge_article node', () => {
    it('AG-040: parses judge scores from JSON response', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-040');

      const result = await graph.invoke(state);

      expect(result.judgeScores).not.toBeNull();
      expect(result.judgeScores?.anti_ai_tone).toBe(0.75);
      expect(result.judgeScores?.hook_strength).toBe(0.8);
      expect(result.judgeScores?.factual_accuracy).toBe(0.85);
    });

    it('AG-041: builds judge feedback string for refine node', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-041');

      const result = await graph.invoke(state);

      expect(result.judgeFeedback).not.toBeNull();
      expect(result.judgeFeedback).toContain('anti_ai_tone');
      expect(result.judgeFeedback).toContain('hook_strength');
    });
  });

  describe('judge router (conditional edge)', () => {
    it('AG-050: high scores → skip refine, go to set_canonical', async () => {
      const highScoreLlm = createMockLlm({
        judge: '{"anti_ai_tone":0.9,"anti_ai_tone_reason":"great","hook_strength":0.85,"hook_strength_reason":"strong","factual_accuracy":0.9,"factual_accuracy_reason":"correct","structure_quality":0.85,"structure_quality_reason":"good","seo_optimization":0.8,"seo_optimization_reason":"optimized"}',
      });

      const graph = buildArticleGraph({
        llm: highScoreLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-050');

      const result = await graph.invoke(state);

      // High scores → no refine → refineCount stays 0
      expect(result.refineCount).toBe(0);
      expect(result.canonicalUrl).not.toBeNull();
    });

    it('AG-051: low scores → triggers refine loop', async () => {
      const lowScoreLlm = createMockLlm({
        judge: '{"anti_ai_tone":0.3,"anti_ai_tone_reason":"too AI","hook_strength":0.2,"hook_strength_reason":"weak","factual_accuracy":0.4,"factual_accuracy_reason":"errors","structure_quality":0.3,"structure_quality_reason":"poor","seo_optimization":0.2,"seo_optimization_reason":"bad"}',
      });

      const graph = buildArticleGraph({
        llm: lowScoreLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-051');

      const result = await graph.invoke(state);

      // Low scores → refine triggered
      expect(result.refineCount).toBeGreaterThan(0);
      expect(result.judgeRetried).toBe(true);
    });
  });

  describe('set_canonical node', () => {
    it('AG-060: sets canonical URL from draft slug', async () => {
      const graph = buildArticleGraph({
        llm: mockLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-060');

      const result = await graph.invoke(state);

      expect(result.canonicalUrl).not.toBeNull();
      expect(result.canonicalUrl).toContain('https://example.com/blog/');
      expect(result.finalArticle).not.toBeNull();
    });
  });

  describe('full graph invocation', () => {
    it('AG-070: completes full flow with high scores (no refine)', async () => {
      const highScoreLlm = createMockLlm({
        judge: '{"anti_ai_tone":0.9,"anti_ai_tone_reason":"great","hook_strength":0.85,"hook_strength_reason":"strong","factual_accuracy":0.9,"factual_accuracy_reason":"correct","structure_quality":0.85,"structure_quality_reason":"good","seo_optimization":0.8,"seo_optimization_reason":"optimized"}',
      });

      const graph = buildArticleGraph({
        llm: highScoreLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning 2026',
        targetNetworks: ['DEVTO', 'HASHNODE', 'LINKEDIN'],
        keywords: ['workflow', 'learning', 'productivity', 'period'],
        language: 'en',
      }, 'run-070');

      const result = await graph.invoke(state);

      // Full flow completed
      expect(result.facts.length).toBeGreaterThan(0);
      expect(result.outline.length).toBeGreaterThan(0);
      expect(result.draft).not.toBeNull();
      expect(result.judgeScores).not.toBeNull();
      expect(result.canonicalUrl).not.toBeNull();
      expect(result.finalArticle).not.toBeNull();
      expect(result.refineCount).toBe(0); // No refine — high scores
    });

    it('AG-071: completes full flow with refine loop', async () => {
      // First judge call: low scores → refine
      // Second judge call (after refine): high scores → done
      let judgeCallCount = 0;
      const mixedLlm = createMockLlm();
      (mixedLlm.generateChat as ReturnType<typeof vi.fn>).mockImplementation(
        (_sys: string, _user: string, opts?: { role?: string }) => {
          if (opts?.role === 'judge') {
            judgeCallCount++;
            if (judgeCallCount === 1) {
              return Promise.resolve({
                content: '{"anti_ai_tone":0.3,"anti_ai_tone_reason":"bad","hook_strength":0.3,"hook_strength_reason":"bad","factual_accuracy":0.3,"factual_accuracy_reason":"bad","structure_quality":0.3,"structure_quality_reason":"bad","seo_optimization":0.3,"seo_optimization_reason":"bad"}',
                model: 'test',
                tokens: 100,
              } as LlmResponse);
            }
            return Promise.resolve({
              content: '{"anti_ai_tone":0.85,"anti_ai_tone_reason":"good","hook_strength":0.8,"hook_strength_reason":"good","factual_accuracy":0.85,"factual_accuracy_reason":"good","structure_quality":0.8,"structure_quality_reason":"good","seo_optimization":0.75,"seo_optimization_reason":"good"}',
              model: 'test',
              tokens: 100,
            } as LlmResponse);
          }
          const role = opts?.role ?? 'default';
          const defaults: Record<string, string> = {
            facts: '1. Workflow takes 18 months to mature',
            outline: '## Intro\n- Point\n- Estimated: 300 words',
            draft: '# Workflow in learning\n\nArticle body here.',
            refine: '# Workflow in learning Refined\n\nBetter article body.',
          };
          return Promise.resolve({ content: defaults[role] ?? 'mock', model: 'test', tokens: 100 } as LlmResponse);
        },
      );

      const graph = buildArticleGraph({
        llm: mixedLlm,
        promptPort: mockPromptPort,
        canonicalService: mockCanonical as never,
      });

      const state = createArticleInitialState({
        topic: 'Workflow in learning',
        targetNetworks: ['DEVTO'],
      }, 'run-071');

      const result = await graph.invoke(state);

      // Refine was triggered once
      expect(result.refineCount).toBe(1);
      expect(result.judgeRetried).toBe(true);
      expect(result.canonicalUrl).not.toBeNull();
    });
  });
});
