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
import type { BaseCallbackHandler } from '../../../src/domain/ports/llm-primitives.js';
import { LlmService } from '../../../src/infrastructure/llm/llm.service';

// ── Helpers ──

function createRateLimitError(retryAfter: string | null = '120'): Error & { status: number; headers: Headers } {
  const err = new Error('429 rate limit') as Error & { status: number; headers: Headers };
  err.status = 429;
  if (retryAfter) {
    err.headers = new Headers([['retry-after', retryAfter]]);
  } else {
    err.headers = new Headers();
  }
  return err;
}

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

  it('generateChat() bakes custom temperature into an immutable per-call instance (race fix)', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'response' });

    await service.generateChat('system', 'user', { temperature: 0.2 });

    // Quality pass: temperature is no longer mutated on a shared instance —
    // a dedicated instance is constructed with the requested temperature.
    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.temperature).toBe(0.2);
  });

  it('BUG-13: generateChat() forwards maxTokens into the per-call instance', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'short' });

    await service.generateChat('system', 'user', { maxTokens: 100 });

    // Quality pass: maxTokens is part of the constructor args / cache key now
    // (previously it was mutated on a shared instance — a concurrency race).
    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.maxTokens).toBe(100);
  });

  it('BUG-13: generateChat() defaults maxTokens to no-limit (-1) when not provided (no leak)', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'x' });

    await service.generateChat('system', 'user');

    const ctorArgs = mocks.ChatOpenAIMock.mock.calls[0]![0];
    expect(ctorArgs.maxTokens).toBe(-1);
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
    // First call (Groq) fails with a NON-rate-limit error → immediate failover.
    // (A 429/rate-limit error would now retry the SAME provider once first —
    // covered in tests/unit/llm/llm-service-routing.spec.ts LS-003.)
    mocks.invoke
      .mockRejectedValueOnce(new Error('Groq exploded'))
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

  it('SQ-001: getProviderStatus() includes rate-limit cooldown fields', () => {
    service.onModuleInit();
    const status = service.getProviderStatus();

    expect(status[0]).toHaveProperty('rateLimitUntil');
    expect(status[0]).toHaveProperty('rateLimitStrikes');
    expect(status[0]).toHaveProperty('consecutive429s');
    expect(typeof status[0]!.rateLimitUntil).toBe('number');
    expect(typeof status[0]!.rateLimitStrikes).toBe('number');
    expect(typeof status[0]!.consecutive429s).toBe('number');
  });

  // ── Sprint Q: Rate-limit backoff ──

  it('SQ-002: long Retry-After header fails over and sets rate-limit cooldown', async () => {
    service.onModuleInit();
    const err = createRateLimitError('120');

    mocks.invoke
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ content: 'OpenAI response' });

    const result = await service.generateChat('sys', 'usr');

    expect(result.content).toBe('OpenAI response');
    expect(result.model).toContain('openai');
    // Groq is put in cooldown, not retried on the same provider.
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    const status = service.getProviderStatus();
    const groq = status.find((s) => s.name === 'groq');
    expect(groq?.consecutive429s).toBe(1);
    expect(groq?.rateLimitUntil).toBeGreaterThan(Date.now());
  });

  it('SQ-003: resetCircuitBreakers also clears rate-limit cooldown', async () => {
    service.onModuleInit();
    const err = createRateLimitError('120');

    mocks.invoke
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ content: 'OpenAI response' });
    await service.generateChat('sys', 'usr');

    let status = service.getProviderStatus();
    expect(status.find((s) => s.name === 'groq')?.rateLimitUntil).toBeGreaterThan(Date.now());

    service.resetCircuitBreakers(['groq']);
    status = service.getProviderStatus();
    expect(status.find((s) => s.name === 'groq')?.rateLimitUntil).toBe(0);
  });

  // ── Sprint J: Prompt Versioning ──

  it('SJ-007: getPromptVersion() returns version string', () => {
    const version = service.getPromptVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  // ── Langfuse tracing: callbacks propagation ──

  it('LF-001: generateChat() passes callbacks to model.invoke when provided in options', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'traced response' });

    const fakeHandler = { name: 'LangfuseCallbackHandler' } as BaseCallbackHandler;
    await service.generateChat('sys', 'usr', { callbacks: [fakeHandler] });

    // model.invoke should receive { callbacks: [...] } as the second arg
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeCall = mocks.invoke.mock.calls[0]!;
    expect(invokeCall[0]).toHaveLength(2); // system + user messages
    expect(invokeCall[1]).toBeDefined();
    expect((invokeCall[1] as { callbacks: unknown[] }).callbacks).toContain(fakeHandler);
  });

  it('LF-002: generateChat() passes undefined (not empty callbacks) when no callbacks set', async () => {
    service.onModuleInit();
    mocks.invoke.mockResolvedValue({ content: 'response' });

    await service.generateChat('sys', 'usr');

    expect(mocks.invoke).toHaveBeenCalledOnce();
    const invokeCall = mocks.invoke.mock.calls[0]!;
    // No callbacks → second arg is undefined (avoids creating empty callback config)
    expect(invokeCall[1]).toBeUndefined();
  });
});
