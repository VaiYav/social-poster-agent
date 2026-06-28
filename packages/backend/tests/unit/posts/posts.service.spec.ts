/**
 * MOD-02: HITL Post Management Module — PostsService unit tests.
 *
 * Traces to: REQ-009..015
 * Hazards: HAZ-003, HAZ-004
 *
 * Source: packages/backend/src/modules/posts/posts.service.ts
 * Spec:   CONSTITUTION.md §14 (Testing) — test case IDs are inline (UTC-026..041)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { PostsService } from '../../../src/modules/posts/posts.service';
import {
  createMockPrismaService,
  fixturePost,
} from '../../mocks/index';

describe('MOD-02: PostsService', () => {
  let service: PostsService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    const eventEmitter = { emit: vi.fn() };
    service = new PostsService(prisma as never, eventEmitter as never);
  });

  // ── findMany() ──────────────────────────────────────────────

  it('UTC-026: findMany() builds where clause with status and network filters', async () => {
    const post1 = { ...fixturePost, id: 'post-1' };
    prisma.post.findMany.mockResolvedValue([post1]);
    prisma.post.count.mockResolvedValue(1);

    const result = await service.findMany({
      status: 'DRAFT',
      network: 'X',
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual({
      posts: [post1],
      total: 1,
      limit: 20,
      offset: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    const findManyArg = prisma.post.findMany.mock.calls[0][0];
    expect(findManyArg.where.status).toBe('DRAFT');
    expect(findManyArg.where.network).toBe('X');
    const countArg = prisma.post.count.mock.calls[0][0];
    expect(countArg.where.status).toBe('DRAFT');
    expect(countArg.where.network).toBe('X');
  });

  it('UTC-027: findMany() builds where clause with only status when network omitted', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.findMany({
      status: 'APPROVED',
      limit: 50,
      offset: 0,
    });

    const findManyArg = prisma.post.findMany.mock.calls[0][0];
    expect(findManyArg.where.status).toBe('APPROVED');
    expect(findManyArg.where.network).toBeUndefined();
  });

  it('UTC-028: findMany() includes account and thread relations', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.findMany({ limit: 10, offset: 0 });

    const findManyArg = prisma.post.findMany.mock.calls[0][0];
    expect(findManyArg.include.account).toBe(true);
    expect(findManyArg.include.thread).toBe(true);
  });

  it('UTC-029: findMany() orders by createdAt DESC and applies pagination', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.findMany({ limit: 100, offset: 200 });

    const findManyArg = prisma.post.findMany.mock.calls[0][0];
    expect(findManyArg.orderBy).toEqual({ createdAt: 'desc' });
    expect(findManyArg.take).toBe(100);
    expect(findManyArg.skip).toBe(200);
  });

  // ── findById() ──────────────────────────────────────────────

  it('UTC-030: findById() returns post with account, thread, generationRun includes', async () => {
    const post = { ...fixturePost, id: 'post-123', account: {}, thread: null, generationRun: null };
    prisma.post.findUnique.mockResolvedValue(post);

    const result = await service.findById('post-123');

    expect(result).toBe(post);
    const arg = prisma.post.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'post-123' });
    expect(arg.include).toEqual({
      account: true,
      thread: true,
      generationRun: true,
    });
  });

  it('UTC-031: findById() throws NotFoundException when post does not exist', async () => {
    prisma.post.findUnique.mockResolvedValue(null);

    await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    await expect(service.findById('nonexistent')).rejects.toThrow(
      'Post nonexistent not found',
    );
  });

  // ── findDrafts() ────────────────────────────────────────────

  it('UTC-032: findDrafts() returns posts with status DRAFT optionally filtered by network', async () => {
    const draft1 = { ...fixturePost, id: 'd1' };
    const draft2 = { ...fixturePost, id: 'd2' };
    prisma.post.findMany.mockResolvedValue([draft1, draft2]);

    const result = await service.findDrafts('X');

    expect(result).toEqual([draft1, draft2]);
    const arg = prisma.post.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe(PostStatus.DRAFT);
    expect(arg.where.network).toBe('X');
  });

  it('UTC-033: findDrafts() returns all DRAFT posts when no network specified', async () => {
    prisma.post.findMany.mockResolvedValue([]);

    await service.findDrafts();

    const arg = prisma.post.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe(PostStatus.DRAFT);
    expect(arg.where.network).toBeUndefined();
  });

  // ── create() ────────────────────────────────────────────────

  it('UTC-034: create() persists post with all provided fields', async () => {
    const created = { id: 'new-post' };
    prisma.post.create.mockResolvedValue(created);

    const data = {
      accountId: 'acc-1',
      network: 'X' as const,
      content: 'hello',
      generationRunId: 'run-1',
      sourceRef: { type: 'brief', path: 'briefs/test.json' },
      llmMetadata: { model: 'gpt-4o-mini', tokens: 120 },
    };

    const result = await service.create(data);

    expect(result).toBe(created);
    const arg = prisma.post.create.mock.calls[0][0];
    expect(arg.data.accountId).toBe('acc-1');
    expect(arg.data.content).toBe('hello');
    expect(arg.data.network).toBe('X');
    expect(arg.data.generationRunId).toBe('run-1');
    expect(arg.data.sourceRef).toEqual({ type: 'brief', path: 'briefs/test.json' });
    expect(arg.data.llmMetadata).toEqual({ model: 'gpt-4o-mini', tokens: 120 });
  });

  it('UTC-035: create(data, tx) writes via the provided transaction client (A4)', async () => {
    const created = { id: 'tx-post' };
    const tx = { post: { create: vi.fn().mockResolvedValue(created) } };

    const result = await service.create(
      { accountId: 'acc-1', network: 'X' as const, content: 'in-tx' },
      tx as never,
    );

    expect(result).toBe(created);
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    // When a tx client is passed, the default (non-transactional) client must NOT be used.
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  // ── updateStatus() ──────────────────────────────────────────

  it('UTC-035: updateStatus() sets APPROVED and records approvedAt timestamp', async () => {
    const existing = { ...fixturePost, id: 'post-1', status: 'DRAFT' };
    prisma.post.findUnique.mockResolvedValue(existing);
    prisma.post.update.mockResolvedValue({ ...existing, status: 'APPROVED' });

    await service.updateStatus('post-1', { status: 'APPROVED' });

    const arg = prisma.post.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'post-1' });
    expect(arg.data.status).toBe('APPROVED');
    expect(arg.data.approvedAt).toBeInstanceOf(Date);
    expect(arg.data.postedAt).toBeUndefined();
  });

  it('UTC-036: updateStatus() sets POSTED and records postedAt timestamp with postUrl', async () => {
    const existing = { ...fixturePost, id: 'post-1', status: 'POSTING' };
    prisma.post.findUnique.mockResolvedValue(existing);
    prisma.post.update.mockResolvedValue({ ...existing, status: 'POSTED' });

    await service.updateStatus('post-1', {
      status: 'POSTED',
      postUrl: 'https://x.com/123',
    });

    const arg = prisma.post.update.mock.calls[0][0];
    expect(arg.data.status).toBe('POSTED');
    expect(arg.data.postUrl).toBe('https://x.com/123');
    expect(arg.data.postedAt).toBeInstanceOf(Date);
    expect(arg.data.approvedAt).toBeUndefined();
  });

  it('UTC-037: updateStatus() sets FAILED with errorMessage', async () => {
    const existing = { ...fixturePost, id: 'post-1', status: 'POSTING' };
    prisma.post.findUnique.mockResolvedValue(existing);
    prisma.post.update.mockResolvedValue({ ...existing, status: 'FAILED' });

    await service.updateStatus('post-1', {
      status: 'FAILED',
      errorMessage: 'timeout',
    });

    const arg = prisma.post.update.mock.calls[0][0];
    expect(arg.data.status).toBe('FAILED');
    expect(arg.data.errorMessage).toBe('timeout');
    expect(arg.data.approvedAt).toBeUndefined();
    expect(arg.data.postedAt).toBeUndefined();
  });

  it('UTC-038: updateStatus() throws NotFoundException when post not found (via findById)', async () => {
    prisma.post.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus('nonexistent', { status: 'APPROVED' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  // ── findBySourceAndNetwork() ────────────────────────────────

  it('UTC-039: findBySourceAndNetwork() filters posts by sourceRef.path in code', async () => {
    prisma.post.findMany.mockResolvedValue([
      { sourceRef: { path: '/a' } },
      { sourceRef: { path: '/b' } },
    ]);

    const result = await service.findBySourceAndNetwork('/a', 'X');

    expect(result).toHaveLength(1);
    expect((result[0].sourceRef as { path: string }).path).toBe('/a');
  });

  it('UTC-040: findBySourceAndNetwork() uses default 14-day lookback window', async () => {
    prisma.post.findMany.mockResolvedValue([]);
    const before = Date.now();

    await service.findBySourceAndNetwork('/path', 'X');

    const after = Date.now();
    const arg = prisma.post.findMany.mock.calls[0][0];
    expect(arg.where.network).toBe('X');
    const gte = arg.where.createdAt.gte as Date;
    expect(gte).toBeInstanceOf(Date);
    // ~14 days ago (allow small clock skew for test execution)
    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    const diffMs = before - gte.getTime();
    expect(diffMs).toBeGreaterThan(expectedMs - 5000);
    expect(diffMs).toBeLessThan(expectedMs + 5000);
    expect(gte.getTime()).toBeLessThanOrEqual(after - expectedMs + 5000);
  });

  it('UTC-041: findBySourceAndNetwork() returns empty when sourceRef is null or not object', async () => {
    prisma.post.findMany.mockResolvedValue([
      { sourceRef: null },
      { sourceRef: 'string' },
    ]);

    const result = await service.findBySourceAndNetwork('/path', 'X');

    expect(result).toEqual([]);
  });
});
