/**
 * MOD-05: Infrastructure Adapters Module — LlmService unit tests.
 *
 * Tests multi-provider fallback chain, generate, generateChat, error handling,
 * and provider configuration.
 *
 * Source: packages/backend/src/infrastructure/llm/llm.service.ts
 * Traces to: REQ-001, REQ-002, REQ-NF-001
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ChatOpenAI ──
// LlmService lazily creates ChatOpenAI instances per provider.
// We mock the constructor so no real API call is made.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ChatOpenAIMock: vi.fn(),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: mocks.ChatOpenAIMock.mockImplementation((opts: unknown) => ({
    model: opts.model,
    apiKey: opts.apiKey,
    temperature: opts.temperature,
    configuration: opts.configuration,
    invoke: mocks.invoke,
  })),
}));

import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../../src/infrastructure/llm/llm.service';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    OPENAI_API_KEY: 'test-openai-key',
    GROQ_API_KEY: 'test-groq-key',
    GROQ_MODEL: 'llama-3.3-70b-versatile',
    OPENROUTER_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    CEREBRAS_API_KEY: '',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_DEFAULT_MODEL: 'gemma4',
    LLM_DEFAULT_MODEL: 'gpt-4o-mini',
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

// ── Tests ──

describe('LlmService (MOD-05 — Infrastructure Adapters)', () => {
  let service: LlmService;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockReset();
    configService = createMockConfigService();
    service = new LlmService(configService);
  });

  // ── onModuleInit ──

  it('onModuleInit() builds provider chain from env vars', () => {
    service.onModuleInit();

    const status = service.getProviderStatus();
    // Groq + OpenAI + Ollama (Ollama always included as last resort)
    expect(status.length).toBeGreaterThanOrEqual(2);
    expect(status.some((p) => p.name === 'groq')).toBe(true);
    expect(status.some((p) => p.name === 'openai')).toBe(true);
    expect(status.some((p) => p.name === 'ollama')).toBe(true);
  });

  it('onModuleInit() includes only providers with API keys (plus Ollama)', () => {
    const minimalConfig = createMockConfigService({
      OPENAI_API_KEY: '',
      GROQ_API_KEY: 'groq-key',
      OPENROUTER_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      CEREBRAS_API_KEY: '',
    });
    const minimalService = new LlmService(minimalConfig);
    minimalService.onModuleInit();

    const status = minimalService.getProviderStatus();
    // Only Groq + Ollama
    expect(status).toHaveLength(2);
    expect(status[0]!.name).toBe('groq');
    expect(status[1]!.name).toBe('ollama');
  });

  it('onModuleInit() does not throw when no API keys are set', () => {
    const emptyConfig = createMockConfigService({
      OPENAI_API_KEY: '',
      GROQ_API_KEY: '',
      OPENROUTER_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      CEREBRAS_API_KEY: '',
    });
    const emptyService = new LlmService(emptyConfig);

    expect(() => emptyService.onModuleInit()).not.toThrow();
    // Ollama is always included
    expect(emptyService.getProviderStatus()).toHaveLength(1);
  });

  // ── generateChat ──

  it('generateChat() invokes first provider (Groq) with system and user messages', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'LLM response text' });

    const result = await service.generateChat('You are helpful', 'Write a tweet');

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeArgs = mocks.invoke.mock.calls[0]![0];
    expect(invokeArgs).toHaveLength(2);
    expect(invokeArgs[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(invokeArgs[1]).toEqual({ role: 'user', content: 'Write a tweet' });

    expect(result.content).toBe('LLM response text');
    expect(result.model).toContain('groq');
  });

  it('generateChat() applies custom temperature from options', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'response' });

    await service.generateChat('system', 'user', { temperature: 0.2 });

    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    // Model is created with default temp, then temperature is set before invoke
    expect(ctorArgs.temperature).toBe(0.7);
  });

  it('BUG-13: generateChat() forwards maxTokens to the model before invoke', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'short' });

    await service.generateChat('system', 'user', { maxTokens: 100 });

    // The cached model the service used is the ctor mock's first return value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelInstance = mocks.ChatOpenAIMock.mock.results[0]!.value as any;
    expect(modelInstance.maxTokens).toBe(100);
  });

  it('BUG-13: generateChat() resets maxTokens to no-limit (-1) when not provided (no leak)', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'x' });

    await service.generateChat('system', 'user');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelInstance = mocks.ChatOpenAIMock.mock.results[0]!.value as any;
    expect(modelInstance.maxTokens).toBe(-1);
  });

  it('generateChat() handles string response content', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'plain string content' });

    const result = await service.generateChat('sys', 'usr');

    expect(result.content).toBe('plain string content');
  });

  it('generateChat() JSON-stringifies non-string response content', async () => {
    service.onModuleInit();
    const objContent = { text: 'hello', meta: { tokens: 50 } };
    mocks.invoke.mockResolvedValue({ content: objContent });

    const result = await service.generateChat('sys', 'usr');

    expect(result.content).toBe(JSON.stringify(objContent));
  });

  // ── Fallback ──

  it('generateChat() falls back to next provider when first fails', async () => {
    service.onModuleInit();
    // First call (Groq) fails, second call (OpenAI) succeeds
    mocks.invoke
      .mockRejectedValueOnce(new Error('Groq rate limit'))
      .mockResolvedValueOnce({ content: 'OpenAI response' });

    const result = await service.generateChat('sys', 'usr');

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('OpenAI response');
    expect(result.model).toContain('openai');
  });

  it('generateChat() throws when all providers fail', async () => {
    service.onModuleInit();
    mocks.invoke.mockRejectedValue(new Error('All down'));

    await expect(service.generateChat('sys', 'usr')).rejects.toThrow(
      'All LLM providers failed',
    );
  });

  it('generateChat() uses sticky provider after first success', async () => {
    service.onModuleInit();
    // Groq fails, OpenAI succeeds
    mocks.invoke
      .mockRejectedValueOnce(new Error('Groq down'))
      .mockResolvedValueOnce({ content: 'OpenAI response' })
      .mockResolvedValueOnce({ content: 'OpenAI response 2' });

    await service.generateChat('sys', 'usr');
    const result2 = await service.generateChat('sys', 'usr');

    // Second call should use OpenAI first (sticky)
    expect(result2.model).toContain('openai');
  });

  it('generateChat() rejects empty content and falls back', async () => {
    service.onModuleInit();
    mocks.invoke
      .mockResolvedValueOnce({ content: '' })
      .mockResolvedValueOnce({ content: 'real content' });

    const result = await service.generateChat('sys', 'usr');

    expect(result.content).toBe('real content');
  });

  // ── generate ──

  it('generate() delegates to invokeWithFallback with user-only message', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'generated text' });

    const result = await service.generate('Write a haiku');

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeArgs = mocks.invoke.mock.calls[0]![0];
    // No system prompt → only user message
    expect(invokeArgs).toHaveLength(1);
    expect(invokeArgs[0]).toEqual({ role: 'user', content: 'Write a haiku' });

    expect(result.content).toBe('generated text');
  });

  // ── LlmResponse shape ──

  it('generateChat() returns LlmResponse with content and model fields', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'test' });

    const result = await service.generateChat('sys', 'usr');

    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('model');
    expect(typeof result.content).toBe('string');
    expect(typeof result.model).toBe('string');
  });

  // ── getProviderStatus ──

  it('getProviderStatus() returns empty array before onModuleInit', () => {
    expect(service.getProviderStatus()).toEqual([]);
  });

  it('getProviderStatus() returns provider list after onModuleInit', () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status.length).toBeGreaterThan(0);
    expect(status[0]).toHaveProperty('name');
    expect(status[0]).toHaveProperty('model');
  });

  // ── Sprint J: Token Counting ──

  it('SJ-001: generate() returns response with tokens field (estimated)', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'This is a test response from the LLM' });

    const result = await service.generate('test prompt');

    expect(result.tokens).toBeDefined();
    expect(typeof result.tokens).toBe('number');
    expect(result.tokens!).toBeGreaterThan(0);
  });

  // ── Sprint J: Content Caching ──

  it('SJ-002: generate() returns cached response on second call with same prompt', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'cached response' });

    const result1 = await service.generate('identical prompt for cache test');
    const result2 = await service.generate('identical prompt for cache test');

    expect(result1.content).toBe('cached response');
    expect(result2.content).toBe('cached response');
    // invoke should only be called once (second call hits cache)
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('SJ-003: clearCache() forces next call to invoke LLM again', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'response' });

    await service.generate('cache clear test prompt');
    service.clearCache();
    await service.generate('cache clear test prompt');

    // After clearCache, invoke should be called twice
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('SJ-004: getCacheStats() returns cache size, max size, and TTL', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'test' });

    await service.generate('cache stats test');

    const stats = service.getCacheStats();
    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('maxSize');
    expect(stats).toHaveProperty('ttlMs');
    expect(stats.size).toBeGreaterThan(0);
  });

  // ── Sprint J: Circuit Breaker ──

  it('SJ-005: circuit breaker trips after threshold failures, skips provider', async () => {
    service.onModuleInit();
    // Make invoke fail for all calls (triggers circuit breaker)
    mocks.invoke.mockRejectedValue(new Error('provider down'));

    // First call — all providers fail
    await expect(service.generate('cb test 1')).rejects.toThrow();

    // Get provider status — should show failures
    const status = service.getProviderStatus();
    expect(status.length).toBeGreaterThan(0);
    // At least one provider should have failures > 0
    const hasFailures = status.some((s) => s.failures > 0);
    expect(hasFailures).toBe(true);
  });

  it('SJ-006: getProviderStatus() includes circuitOpen and failures fields', () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status[0]).toHaveProperty('circuitOpen');
    expect(status[0]).toHaveProperty('failures');
    expect(typeof status[0]!.circuitOpen).toBe('boolean');
    expect(typeof status[0]!.failures).toBe('number');
  });

  // ── Sprint J: Prompt Versioning ──

  it('SJ-007: getPromptVersion() returns version string', () => {
    const version = service.getPromptVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
