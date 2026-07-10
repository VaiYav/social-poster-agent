/**
 * Quality-pass tests for LlmService:
 *   - LS-001: Anthropic provider wired into the chain (was dead config)
 *   - LS-002: per-(temperature,maxTokens) instances — the mutation race fix
 *   - LS-003: 429 → one retry on the SAME provider before failover
 *   - LS-004: global concurrency semaphore (LLM_MAX_CONCURRENT)
 *   - LS-005: LLM_ROLE_CHAINS routing (creative roles → preferred providers)
 *   - LS-006: creative roles bypass the response cache
 *
 * ChatOpenAI is mocked — no network calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

interface MockInstance {
  ctorArgs: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    configuration?: { baseURL?: string };
  };
  invokeCalls: number;
}

const mocks = vi.hoisted(() => {
  const instances: MockInstance[] = [];
  let behavior: (inst: MockInstance) => Promise<unknown> = async () => ({
    content: 'ok',
    usage_metadata: { total_tokens: 42 },
  });
  class ChatOpenAI {
    ctorArgs: MockInstance['ctorArgs'];
    invokeCalls = 0;
    constructor(args: MockInstance['ctorArgs']) {
      this.ctorArgs = args;
      instances.push(this as unknown as MockInstance);
    }
    async invoke(): Promise<unknown> {
      this.invokeCalls += 1;
      return behavior(this as unknown as MockInstance);
    }
  }
  return {
    instances,
    ChatOpenAI,
    setBehavior(b: (inst: MockInstance) => Promise<unknown>) {
      behavior = b;
    },
    reset() {
      instances.length = 0;
      behavior = async () => ({ content: 'ok', usage_metadata: { total_tokens: 42 } });
    },
  };
});

vi.mock('@langchain/openai', () => ({ ChatOpenAI: mocks.ChatOpenAI }));

import { LlmService } from '../../../src/infrastructure/llm/llm.service';
import { createMockRedis } from '../../mocks/index';

function makeService(env: Record<string, string | number>): LlmService {
  const config = {
    get: (key: string, def?: unknown) => {
      if (key === 'LLM_CACHE_SHARED') return 'false';
      return key in env ? env[key] : def;
    },
  } as unknown as ConfigService;
  const service = new LlmService(config, createMockRedis());
  service.onModuleInit();
  return service;
}

describe('LlmService — quality pass', () => {
  beforeEach(() => {
    mocks.reset();
    vi.restoreAllMocks();
  });

  it('LS-001: ANTHROPIC_API_KEY wires an anthropic provider (paid) into the chain', () => {
    const service = makeService({ ANTHROPIC_API_KEY: 'key' });
    const models = service.getAvailableModels();
    const anthropic = models.find((m) => m.provider === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.free).toBe(false);
    expect(anthropic?.model).toBe('claude-haiku-4-5');
  });

  it('LS-002: different temperatures produce DIFFERENT immutable instances (race fix)', async () => {
    const service = makeService({ GROQ_API_KEY: 'key' });
    await service.generateChat('sys', 'prompt one', { temperature: 0.3, role: 'draft' });
    await service.generateChat('sys', 'prompt two', { temperature: 0.9, role: 'draft' });

    const groqInstances = mocks.instances.filter((i) => i.ctorArgs.model === 'llama-3.3-70b-versatile');
    const temps = groqInstances.map((i) => i.ctorArgs.temperature).sort();
    expect(groqInstances).toHaveLength(2);
    expect(temps).toEqual([0.3, 0.9]);
  });

  it('LS-002b: maxTokens is part of the instance key (no leakage between calls)', async () => {
    const service = makeService({ GROQ_API_KEY: 'key' });
    await service.generateChat('sys', 'prompt one', { temperature: 0.2, maxTokens: 700, role: 'judge' });
    await service.generateChat('sys', 'prompt two', { temperature: 0.2, role: 'critique' });

    const caps = mocks.instances.map((i) => i.ctorArgs.maxTokens).sort();
    expect(caps).toEqual([-1, 700]);
  });

  it('LS-003: 429 retries the SAME provider once instead of failing over', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let first = true;
    mocks.setBehavior(async () => {
      if (first) {
        first = false;
        const err = new Error('429 rate limit') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return { content: 'ok after retry', usage_metadata: { total_tokens: 5 } };
    });

    const service = makeService({ GROQ_API_KEY: 'key', LLM_RATE_LIMIT_RETRY_MS: 1 });
    const res = await service.generateChat('sys', 'prompt', { role: 'draft' });

    expect(res.content).toBe('ok after retry');
    // Only the groq instance exists — ollama (backstop) was never touched
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]!.invokeCalls).toBe(2);
  });

  it('LS-004: LLM_MAX_CONCURRENT caps concurrent invocations', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.setBehavior(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { content: 'ok', usage_metadata: { total_tokens: 1 } };
    });

    const service = makeService({ GROQ_API_KEY: 'key', LLM_MAX_CONCURRENT: 1 });
    await Promise.all([
      service.generateChat('sys', 'prompt A', { role: 'draft' }),
      service.generateChat('sys', 'prompt B', { role: 'draft' }),
      service.generateChat('sys', 'prompt C', { role: 'draft' }),
    ]);

    expect(peak).toBe(1);
  });

  it('LS-005: LLM_ROLE_CHAINS routes creative roles to the preferred provider first', async () => {
    const service = makeService({
      GROQ_API_KEY: 'key',
      LLM_ROLE_CHAINS: 'draft=ollama;judge=groq',
    });

    await service.generateChat('sys', 'creative prompt', { role: 'draft' });
    // First instance created/invoked must be Ollama (preferred for draft)
    expect(mocks.instances[0]!.ctorArgs.configuration?.baseURL).toContain('11434');

    await service.generateChat('sys', 'judge prompt', { role: 'judge' });
    const groq = mocks.instances.find((i) => i.ctorArgs.model === 'llama-3.3-70b-versatile');
    expect(groq).toBeDefined();
    expect(groq!.invokeCalls).toBe(1);
  });

  it('LS-006: creative roles bypass the response cache; utility roles use it', async () => {
    const service = makeService({ GROQ_API_KEY: 'key' });

    await service.generateChat('sys', 'same prompt', { role: 'utility' });
    await service.generateChat('sys', 'same prompt', { role: 'utility' });
    const utilityInvokes = mocks.instances.reduce((a, i) => a + i.invokeCalls, 0);
    expect(utilityInvokes).toBe(1); // second call = cache hit

    await service.generateChat('sys', 'same creative prompt', { role: 'draft' });
    await service.generateChat('sys', 'same creative prompt', { role: 'draft' });
    const totalInvokes = mocks.instances.reduce((a, i) => a + i.invokeCalls, 0);
    expect(totalInvokes).toBe(3); // both draft calls hit the model
  });

  it('LS-007: real usage_metadata tokens are preferred over the chars/4 estimate', async () => {
    const service = makeService({ GROQ_API_KEY: 'key' });
    const res = await service.generateChat('sys', 'prompt', { role: 'draft' });
    expect(res.tokens).toBe(42);
  });
});
