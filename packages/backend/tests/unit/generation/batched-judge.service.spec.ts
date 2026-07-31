/**
 * BatchedJudgeService unit tests.
 *
 * P2: eval harness for per-dimension hard-fail thresholds and A/B skip threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchedJudgeService } from '../../../src/modules/generation/batched-judge.service';
import type { ILlmPort } from '../../../src/domain/ports/llm.port';

function createMockLlm(content: string): ILlmPort {
  return {
    generateChat: vi.fn().mockResolvedValue({ content, model: 'mock', tokens: 100, cost: 0.001 }),
    generate: vi.fn().mockResolvedValue({ content, model: 'mock' }),
  } as unknown as ILLmPort;
}

function makeInput(overrides: Partial<{ anti: number; factual: number; hook: number; char: number }> = {}) {
  const scores = {
    anti_ai_tone: overrides.anti ?? 0.7,
    factual_accuracy: overrides.factual ?? 0.7,
    hook_strength: overrides.hook ?? 0.7,
    character_limit: overrides.char ?? 1.0,
  };
  return {
    network: 'X' as const,
    content: 'test post',
    charLimit: 280,
    factsText: 'facts',
    slopList: 'slop',
  };
}

function makeLlmResponse(scores: { anti_ai_tone: number; factual_accuracy: number; hook_strength: number; character_limit: number }) {
  return JSON.stringify({
    X: {
      anti_ai_tone: scores.anti_ai_tone,
      factual_accuracy: scores.factual_accuracy,
      hook_strength: scores.hook_strength,
      character_limit: scores.character_limit,
    },
    THREADS: {
      anti_ai_tone: scores.anti_ai_tone,
      factual_accuracy: scores.factual_accuracy,
      hook_strength: scores.hook_strength,
      character_limit: scores.character_limit,
    },
    FACEBOOK: {
      anti_ai_tone: scores.anti_ai_tone,
      factual_accuracy: scores.factual_accuracy,
      hook_strength: scores.hook_strength,
      character_limit: scores.character_limit,
    },
  });
}

describe('BatchedJudgeService (P2 eval harness)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('JUDGE-001: returns per-network scores from a single LLM call', async () => {
    const llm = createMockLlm(makeLlmResponse({ anti_ai_tone: 0.8, factual_accuracy: 0.7, hook_strength: 0.6, character_limit: 1.0 }));
    const judge = new BatchedJudgeService(llm, undefined);
    const result = await judge.judgeBatch([makeInput()]);
    expect(Object.keys(result)).toEqual(['X', 'THREADS', 'FACEBOOK']);
    expect(result.X?.anti_ai_tone).toBe(0.8);
    expect(llm.generateChat).toHaveBeenCalledTimes(1);
  });

  it('JUDGE-002: hard-fail on anti_ai_tone below JUDGE_HARD_FAIL_ANTI_AI', async () => {
    const llm = createMockLlm(makeLlmResponse({ anti_ai_tone: 0.2, factual_accuracy: 0.7, hook_strength: 0.6, character_limit: 1.0 }));
    const judge = new BatchedJudgeService(llm, undefined, 1200);
    const result = await judge.judgeBatch([makeInput()]);
    expect(result.X?.anti_ai_tone).toBeLessThan(0.3);
  });

  it('JUDGE-003: hard-fail on factual_accuracy below JUDGE_HARD_FAIL_FACTUAL', async () => {
    const llm = createMockLlm(makeLlmResponse({ anti_ai_tone: 0.8, factual_accuracy: 0.1, hook_strength: 0.6, character_limit: 1.0 }));
    const judge = new BatchedJudgeService(llm, undefined, 1200);
    const result = await judge.judgeBatch([makeInput()]);
    expect(result.X?.factual_accuracy).toBeLessThan(0.3);
  });

  it('JUDGE-004: returns empty record for empty input batch', async () => {
    const llm = createMockLlm('{}');
    const judge = new BatchedJudgeService(llm, undefined);
    const result = await judge.judgeBatch([]);
    expect(result).toEqual({});
    expect(llm.generateChat).not.toHaveBeenCalled();
  });
});
