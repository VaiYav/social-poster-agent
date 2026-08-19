/**
 * Smoke test — verifies Vitest setup is correct.
 * If this passes, the test infrastructure is working.
 *
 * [Verifies: Test infrastructure setup]
 */
import { describe, it, expect } from 'vitest';
import { createMockLlmPort, createMockPrismaService, createMockRedis } from '../mocks/index.js';

describe('Test Infrastructure Smoke Test', () => {
  it('should create mock LLM port with generate methods', () => {
    const mock = createMockLlmPort();
    expect(mock.generate).toBeDefined();
    expect(mock.generateChat).toBeDefined();
    expect(typeof mock.generate).toBe('function');
  });

  it('should create mock Prisma service with model methods', () => {
    const mock = createMockPrismaService();
    expect(mock.generationRun.create).toBeDefined();
    expect(mock.post.findMany).toBeDefined();
    expect(mock.session.update).toBeDefined();
    expect(mock.$transaction).toBeDefined();
  });

  it('should create mock Redis with store', async () => {
    const mock = createMockRedis();
    await mock.set('key1', 'value1');
    const val = await mock.get('key1');
    expect(val).toBe('value1');
  });

  it('should support async/await with promises', async () => {
    const mock = createMockLlmPort();
    const result = await mock.generateChat('system', 'user');
    expect(result.content).toBe('Mock LLM chat content');
    expect(result.model).toBe('gpt-5-nano');
  });

  it('should support vi.fn() mock assertions', async () => {
    const mock = createMockLlmPort();
    await mock.generate('test prompt');
    expect(mock.generate).toHaveBeenCalledOnce();
    expect(mock.generate).toHaveBeenCalledWith('test prompt');
  });
});
