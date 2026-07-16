/**
 * LlmService cache key tests.
 *
 * Source: packages/backend/src/infrastructure/llm/llm.service.ts
 * Sprint J: cache key must include provider/model/temperature/maxTokens/role.
 */
import { describe, it, expect, vi } from 'vitest';
import { LlmService } from '../../../src/infrastructure/llm/llm.service';

function createConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      // Default cache to in-memory so tests don't require Redis.
      if (key === 'LLM_CACHE_SHARED') return 'false';
      return defaultValue;
    }),
  } as never;
}

function baseProvider() {
  return { name: 'groq', model: 'llama-3-8b' } as never;
}

describe('LlmService — cache key', () => {
  it('P1-1.5: different providers produce different cache keys', () => {
    const service = new LlmService(createConfigService());
    const keyA = (service as any).cacheKey('sys', 'user', {}, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', {}, { name: 'anthropic', model: 'claude-3-haiku' } as never);
    expect(keyA).not.toBe(keyB);
  });

  it('P1-1.5b: different models produce different cache keys', () => {
    const service = new LlmService(createConfigService());
    const keyA = (service as any).cacheKey('sys', 'user', {}, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', {}, { name: 'groq', model: 'llama-3-70b' } as never);
    expect(keyA).not.toBe(keyB);
  });

  it('P1-1.5c: different temperatures produce different cache keys', () => {
    const service = new LlmService(createConfigService());
    const base = { maxTokens: 100, role: 'critique' };
    const keyA = (service as any).cacheKey('sys', 'user', { ...base, temperature: 0.2 }, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', { ...base, temperature: 0.8 }, baseProvider());
    expect(keyA).not.toBe(keyB);
  });

  it('P1-1.5d: different maxTokens produce different cache keys', () => {
    const service = new LlmService(createConfigService());
    const base = { temperature: 0.5, role: 'critique' };
    const keyA = (service as any).cacheKey('sys', 'user', { ...base, maxTokens: 100 }, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', { ...base, maxTokens: 500 }, baseProvider());
    expect(keyA).not.toBe(keyB);
  });

  it('P1-1.5e: different roles produce different cache keys', () => {
    const service = new LlmService(createConfigService());
    const base = { temperature: 0.5, maxTokens: 100 };
    const keyA = (service as any).cacheKey('sys', 'user', { ...base, role: 'critique' }, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', { ...base, role: 'judge' }, baseProvider());
    expect(keyA).not.toBe(keyB);
  });

  it('P1-1.5f: identical prompts and options produce identical cache keys', () => {
    const service = new LlmService(createConfigService());
    const options = { temperature: 0.5, maxTokens: 100, role: 'critique' as const };
    const keyA = (service as any).cacheKey('sys', 'user', options, baseProvider());
    const keyB = (service as any).cacheKey('sys', 'user', options, baseProvider());
    expect(keyA).toBe(keyB);
  });
});
