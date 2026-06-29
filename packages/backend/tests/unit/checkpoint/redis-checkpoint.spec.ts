/**
 * BUG-9: RedisCheckpointSaver.getTuple must return the pending writes recorded by
 * putWrites() — otherwise a crash-resume re-executes a task whose writes were
 * already recorded, duplicating its side effects (e.g. re-saving a post).
 *
 * Source: packages/backend/src/infrastructure/checkpoint/redis-checkpoint.ts
 */
import { describe, it, expect, vi } from 'vitest';
import type { Checkpoint, CheckpointMetadata, ChannelVersions } from '@langchain/langgraph-checkpoint';

import { RedisCheckpointSaver } from '../../../src/infrastructure/checkpoint/redis-checkpoint';

function createRedisMock() {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  return {
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      kv.set(k, v);
      return 'OK';
    }),
    rpush: vi.fn(async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.push(v);
      lists.set(k, l);
      return l.length;
    }),
    lrange: vi.fn(async (k: string) => lists.get(k) ?? []),
    expire: vi.fn(async () => 1),
  };
}

function build() {
  const config = { get: vi.fn((_k: string, d?: unknown) => d) };
  const saver = new RedisCheckpointSaver(config as never, createRedisMock() as never);
  return { saver };
}

const cfg = (extra: Record<string, unknown> = {}) => ({ configurable: { thread_id: 't1', ...extra } });
const put = (saver: RedisCheckpointSaver, id = 'c1') =>
  saver.put(cfg(), { id } as Checkpoint, {} as CheckpointMetadata, {} as ChannelVersions);

describe('RedisCheckpointSaver.getTuple pendingWrites (BUG-9)', () => {
  it('returns pending writes recorded for a specific checkpoint', async () => {
    const { saver } = build();
    await put(saver);
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['posts', { id: 'p1' }]], 'task-1');

    const tuple = await saver.getTuple(cfg({ checkpoint_id: 'c1' }));

    expect(tuple?.pendingWrites).toEqual([['task-1', 'posts', { id: 'p1' }]]);
  });

  it('returns pending writes via the latest-pointer lookup (no checkpoint_id)', async () => {
    const { saver } = build();
    await put(saver);
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['posts', { id: 'p2' }]], 'task-2');

    const tuple = await saver.getTuple(cfg()); // latest pointer

    expect(tuple?.pendingWrites).toEqual([['task-2', 'posts', { id: 'p2' }]]);
  });

  it('returns empty pendingWrites when none were recorded', async () => {
    const { saver } = build();
    await put(saver);

    const tuple = await saver.getTuple(cfg({ checkpoint_id: 'c1' }));

    expect(tuple?.pendingWrites).toEqual([]);
  });

  it('flattens multiple writes and tasks in recorded order', async () => {
    const { saver } = build();
    await put(saver);
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['a', 1], ['b', 2]], 'task-1');
    await saver.putWrites(cfg({ checkpoint_id: 'c1' }), [['c', 3]], 'task-2');

    const tuple = await saver.getTuple(cfg({ checkpoint_id: 'c1' }));

    expect(tuple?.pendingWrites).toEqual([
      ['task-1', 'a', 1],
      ['task-1', 'b', 2],
      ['task-2', 'c', 3],
    ]);
  });
});
