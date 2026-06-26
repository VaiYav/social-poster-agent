/**
 * MOD-05: Infrastructure Adapters Module — RedisCheckpointSaver unit tests.
 *
 * Tests checkpoint put, getTuple, list (async generator), putWrites,
 * and lifecycle (init, destroy).
 *
 * Source: packages/backend/src/infrastructure/checkpoint/redis-checkpoint.ts
 * Traces to: REQ-NF-010, REQ-003
 * Hazards: HAZ-001
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock IORedis — RedisCheckpointSaver creates an instance in onModuleInit()
vi.mock('ioredis', () => ({
  default: vi.fn(),
}));

// Mock BaseCheckpointSaver — we only test Redis-specific logic
vi.mock('@langchain/langgraph-checkpoint', () => ({
  BaseCheckpointSaver: class MockBaseCheckpointSaver {},
}));

import { ConfigService } from '@nestjs/config';
import { RedisCheckpointSaver } from '../../../src/infrastructure/checkpoint/redis-checkpoint';
import { createMockRedis } from '../../mocks/index';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    REDIS_URL: 'redis://localhost:6380',
    CHECKPOINT_TTL_SECONDS: 604800, // 7 days
    CHECKPOINT_PREFIX: 'spa:checkpoint',
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

/**
 * Extended mock Redis with `keys` and `rpush` methods needed by checkpoint saver.
 * The base createMockRedis() lacks these.
 */
function createCheckpointMockRedis() {
  const redis = createMockRedis();
  (redis as any).keys = vi.fn((_pattern: string) => Promise.resolve([]));
  (redis as any).rpush = vi.fn().mockResolvedValue(1);
  return redis as any;
}

function createMockConfig(threadId: string, checkpointId?: string) {
  return {
    configurable: {
      thread_id: threadId,
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
  } as any;
}

function createMockCheckpoint(id: string) {
  return { id } as any;
}

// ── Tests ──

describe('RedisCheckpointSaver (MOD-05 — Infrastructure Adapters)', () => {
  let saver: RedisCheckpointSaver;
  let configService: ConfigService;
  let mockRedis: ReturnType<typeof createCheckpointMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = createMockConfigService();
    mockRedis = createCheckpointMockRedis();
    saver = new RedisCheckpointSaver(configService);
    // Inject mock Redis into the private field
    (saver as any).redis = mockRedis;
  });

  // ── put ──

  it('put() stores checkpoint at thread:checkpoint key with TTL', async () => {
    const config = createMockConfig('thread-1');
    const checkpoint = createMockCheckpoint('ckpt-001');
    const metadata = { source: 'input' } as any;
    const newVersions = {} as any;

    await saver.put(config, checkpoint, metadata, newVersions);

    // set called twice: specific checkpoint + latest pointer
    expect(mockRedis.set).toHaveBeenCalledTimes(2);

    // First call: specific checkpoint key
    const firstCall = mockRedis.set.mock.calls[0]!;
    expect(firstCall[0]).toBe('spa:checkpoint:thread-1:ckpt-001');
    expect(firstCall[2]).toBe('EX');
    expect(firstCall[3]).toBe(604800); // 7 days TTL

    // Second call: latest pointer key
    const secondCall = mockRedis.set.mock.calls[1]!;
    expect(secondCall[0]).toBe('spa:checkpoint:thread-1');
    expect(secondCall[2]).toBe('EX');
    expect(secondCall[3]).toBe(604800);
  });

  it('put() stores tuple with correct config, checkpoint, and metadata', async () => {
    const config = createMockConfig('thread-2');
    const checkpoint = createMockCheckpoint('ckpt-002');
    const metadata = { step: 1 } as any;

    await saver.put(config, checkpoint, metadata, {} as any);

    // Verify the stored JSON contains the tuple
    const storedData = mockRedis.set.mock.calls[0]![1] as string;
    const parsed = JSON.parse(storedData);
    expect(parsed.checkpoint).toEqual(checkpoint);
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.config.configurable.thread_id).toBe('thread-2');
    expect(parsed.config.configurable.checkpoint_id).toBe('ckpt-002');
  });

  it('put() returns the tuple config with checkpoint_id set', async () => {
    const config = createMockConfig('thread-3');
    const checkpoint = createMockCheckpoint('ckpt-003');

    const result = await saver.put(config, checkpoint, {} as any, {} as any);

    expect(result.configurable.thread_id).toBe('thread-3');
    expect(result.configurable.checkpoint_id).toBe('ckpt-003');
  });

  it('put() does nothing when Redis not connected', async () => {
    (saver as any).redis = null;
    const config = createMockConfig('thread-4');
    const checkpoint = createMockCheckpoint('ckpt-004');

    const result = await saver.put(config, checkpoint, {} as any, {} as any);

    expect(mockRedis.set).not.toHaveBeenCalled();
    // Returns the original config
    expect(result).toBe(config);
  });

  // ── getTuple ──

  it('getTuple() returns undefined when Redis not connected', async () => {
    (saver as any).redis = null;
    const config = createMockConfig('thread-1');

    const result = await saver.getTuple(config);

    expect(result).toBeUndefined();
  });

  it('getTuple() returns undefined when thread_id is missing', async () => {
    const config = { configurable: {} } as any;

    const result = await saver.getTuple(config);

    expect(result).toBeUndefined();
  });

  it('getTuple() returns specific checkpoint when checkpoint_id provided', async () => {
    const tupleData = {
      checkpoint: { id: 'ckpt-100' },
      metadata: {},
      config: { configurable: { thread_id: 't1', checkpoint_id: 'ckpt-100' } },
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(tupleData));

    const config = createMockConfig('t1', 'ckpt-100');
    const result = await saver.getTuple(config);

    expect(result).toBeDefined();
    expect(result!.checkpoint.id).toBe('ckpt-100');
    expect(mockRedis.get).toHaveBeenCalledWith('spa:checkpoint:t1:ckpt-100');
  });

  it('getTuple() returns undefined when specific checkpoint_id not found', async () => {
    mockRedis.get.mockResolvedValue(null);

    const config = createMockConfig('t1', 'nonexistent');
    const result = await saver.getTuple(config);

    expect(result).toBeUndefined();
  });

  it('getTuple() returns latest checkpoint from pointer key when no checkpoint_id', async () => {
    const tupleData = {
      checkpoint: { id: 'ckpt-latest' },
      metadata: {},
      config: { configurable: { thread_id: 't2', checkpoint_id: 'ckpt-latest' } },
    };
    // keys must return non-empty so the code proceeds to check the pointer
    mockRedis.keys.mockResolvedValue(['spa:checkpoint:t2:ckpt-latest']);
    mockRedis.get.mockResolvedValue(JSON.stringify(tupleData));

    const config = createMockConfig('t2');
    const result = await saver.getTuple(config);

    expect(result).toBeDefined();
    expect(result!.checkpoint.id).toBe('ckpt-latest');
    // Should query the latest pointer key
    expect(mockRedis.get).toHaveBeenCalledWith('spa:checkpoint:t2');
  });

  it('getTuple() returns undefined when no checkpoints exist for thread', async () => {
    // keys returns empty, get returns null
    mockRedis.keys.mockResolvedValue([]);
    mockRedis.get.mockResolvedValue(null);

    const config = createMockConfig('empty-thread');
    const result = await saver.getTuple(config);

    expect(result).toBeUndefined();
  });

  // ── list ──

  it('list() yields checkpoints up to the limit', async () => {
    const tuple1 = { checkpoint: { id: 'c1' }, metadata: {}, config: {} };
    const tuple2 = { checkpoint: { id: 'c2' }, metadata: {}, config: {} };
    const tuple3 = { checkpoint: { id: 'c3' }, metadata: {}, config: {} };

    // keys returns 3 checkpoint keys (not the pointer)
    mockRedis.keys.mockResolvedValue([
      'spa:checkpoint:t1:c1',
      'spa:checkpoint:t1:c2',
      'spa:checkpoint:t1:c3',
    ]);
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify(tuple1))
      .mockResolvedValueOnce(JSON.stringify(tuple2))
      .mockResolvedValueOnce(JSON.stringify(tuple3));

    const config = createMockConfig('t1');
    const results: any[] = [];
    for await (const tuple of saver.list(config, { limit: 10 })) {
      results.push(tuple);
    }

    expect(results).toHaveLength(3);
    expect(results[0].checkpoint.id).toBe('c1');
    expect(results[1].checkpoint.id).toBe('c2');
    expect(results[2].checkpoint.id).toBe('c3');
  });

  it('list() respects limit option (default 10)', async () => {
    // Create 15 keys — default limit is 10
    const keys = Array.from({ length: 15 }, (_, i) => `spa:checkpoint:t1:c${i}`);
    mockRedis.keys.mockResolvedValue(keys);
    mockRedis.get.mockResolvedValue(JSON.stringify({ checkpoint: { id: 'x' } }));

    const config = createMockConfig('t1');
    const results: any[] = [];
    for await (const tuple of saver.list(config)) {
      results.push(tuple);
    }

    // Only first 10 keys are iterated (limit defaults to 10)
    expect(results).toHaveLength(10);
  });

  it('list() skips the pointer key (thread key without checkpoint_id)', async () => {
    const tupleData = { checkpoint: { id: 'c1' }, metadata: {}, config: {} };
    mockRedis.keys.mockResolvedValue([
      'spa:checkpoint:t1', // pointer key — should be skipped
      'spa:checkpoint:t1:c1',
    ]);
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(tupleData));

    const config = createMockConfig('t1');
    const results: any[] = [];
    for await (const tuple of saver.list(config, { limit: 10 })) {
      results.push(tuple);
    }

    // Only the checkpoint key yielded, pointer skipped
    expect(results).toHaveLength(1);
    expect(results[0].checkpoint.id).toBe('c1');
  });

  it('list() yields nothing when Redis not connected', async () => {
    (saver as any).redis = null;
    const config = createMockConfig('t1');

    const results: any[] = [];
    for await (const tuple of saver.list(config)) {
      results.push(tuple);
    }

    expect(results).toHaveLength(0);
  });

  it('list() yields nothing when thread_id is missing', async () => {
    const config = { configurable: {} } as any;

    const results: any[] = [];
    for await (const tuple of saver.list(config)) {
      results.push(tuple);
    }

    expect(results).toHaveLength(0);
  });

  // ── putWrites ──

  it('putWrites() stores writes as JSON via rpush with TTL', async () => {
    const config = createMockConfig('t1', 'ckpt-1');
    const writes = [{ taskId: 'task-1', data: 'write-data' }] as any;

    await saver.putWrites(config, writes, 'task-1');

    expect(mockRedis.rpush).toHaveBeenCalledOnce();
    const rpushArgs = mockRedis.rpush.mock.calls[0]!;
    expect(rpushArgs[0]).toBe('spa:checkpoint:writes:t1:ckpt-1');
    const storedData = JSON.parse(rpushArgs[1]);
    expect(storedData.taskId).toBe('task-1');
    expect(storedData.writes).toEqual(writes);

    // TTL set on the writes key
    expect(mockRedis.expire).toHaveBeenCalledWith('spa:checkpoint:writes:t1:ckpt-1', 604800);
  });

  it('putWrites() does nothing when Redis not connected', async () => {
    (saver as any).redis = null;
    const config = createMockConfig('t1', 'ckpt-1');

    await saver.putWrites(config, [] as any, 'task-1');

    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  it('putWrites() does nothing when thread_id or checkpoint_id missing', async () => {
    // Missing checkpoint_id
    const config = createMockConfig('t1');

    await saver.putWrites(config, [] as any, 'task-1');

    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  // ── onModuleInit / onModuleDestroy ──

  it('onModuleInit() creates Redis connection', () => {
    expect(() => saver.onModuleInit()).not.toThrow();
  });

  it('onModuleDestroy() disconnects Redis when connected', () => {
    saver.onModuleDestroy();
    expect(mockRedis.disconnect).toHaveBeenCalledOnce();
  });

  it('onModuleDestroy() is safe when Redis is null', () => {
    (saver as any).redis = null;
    expect(() => saver.onModuleDestroy()).not.toThrow();
  });

  // ── Custom config ──

  it('uses env-configurable TTL and prefix', async () => {
    const customConfig = createMockConfigService({
      CHECKPOINT_TTL_SECONDS: 3600,
      CHECKPOINT_PREFIX: 'custom:ckpt',
    });
    const customSaver = new RedisCheckpointSaver(customConfig);
    const customRedis = createCheckpointMockRedis();
    (customSaver as any).redis = customRedis;

    const config = createMockConfig('t1');
    await customSaver.put(config, createMockCheckpoint('c1'), {} as any, {} as any);

    const firstCall = customRedis.set.mock.calls[0]!;
    expect(firstCall[0]).toBe('custom:ckpt:t1:c1');
    expect(firstCall[3]).toBe(3600);
  });
});
