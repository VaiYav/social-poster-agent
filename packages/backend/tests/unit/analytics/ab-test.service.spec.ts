import { describe, it, expect, vi } from 'vitest';
import { SocialNetwork } from '@prisma/client';
import { ABTestService } from '../../../src/modules/analytics/ab-test.service';
import { createMockPrismaService } from '../../mocks/index.js';

describe('ABTestService', () => {
  it('groups posted variants by topic and network', async () => {
    const prisma = createMockPrismaService();
    const postedAt = new Date('2026-07-01T12:00:00Z');

    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'pv-1',
        postId: 'p-1',
        network: SocialNetwork.X,
        label: 'a',
        content: 'A variant',
        selected: true,
        likes: 10,
        comments: 2,
        shares: 1,
        impressions: 50,
        postedAt,
        metricsAt: postedAt,
        judgeScores: { anti_ai_tone: 0.8, hook_strength: 0.9 },
        post: {
          id: 'p-1',
          network: SocialNetwork.X,
          postedAt,
          postUrl: 'https://x.com/1',
          sourceRef: { topic: 'Mercury retrograde' },
        },
      },
      {
        id: 'pv-2',
        postId: 'p-2',
        network: SocialNetwork.X,
        label: 'b',
        content: 'B variant',
        selected: true,
        likes: 5,
        comments: 1,
        shares: 0,
        impressions: 30,
        postedAt,
        metricsAt: postedAt,
        judgeScores: { anti_ai_tone: 0.7, hook_strength: 0.8 },
        post: {
          id: 'p-2',
          network: SocialNetwork.X,
          postedAt,
          postUrl: 'https://x.com/2',
          sourceRef: { topic: 'Mercury retrograde' },
        },
      },
    ]);

    const service = new ABTestService(prisma as never);
    const results = await service.getAbTests({ days: 30, network: 'X', minSampleSize: 0 });

    expect(results).toHaveLength(1);
    const test = results[0]!;
    expect(test.topic).toBe('Mercury retrograde');
    expect(test.network).toBe('X');
    expect(test.totalPosts).toBe(2);
    expect(test.variants).toHaveLength(2);

    const variantA = test.variants.find((v) => v.label === 'a')!;
    expect(variantA.avgLikes).toBe(10);
    expect(variantA.avgEngagement).toBe(13);
    expect(variantA.avgAntiAiTone).toBe(0.8);
    expect(variantA.avgHookStrength).toBe(0.9);

    const variantB = test.variants.find((v) => v.label === 'b')!;
    expect(variantB.avgEngagement).toBe(6);

    expect(test.winner).toBe('a');
  });

  it('filters out variants below minSampleSize when choosing winner', async () => {
    const prisma = createMockPrismaService();
    const postedAt = new Date('2026-07-01T12:00:00Z');

    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'pv-1',
        postId: 'p-1',
        network: SocialNetwork.X,
        label: 'a',
        content: 'A variant',
        selected: true,
        likes: 100,
        comments: 0,
        shares: 0,
        impressions: null,
        postedAt,
        metricsAt: postedAt,
        judgeScores: null,
        post: {
          id: 'p-1',
          network: SocialNetwork.X,
          postedAt,
          postUrl: null,
          sourceRef: { topic: 'Mercury retrograde' },
        },
      },
      {
        id: 'pv-2',
        postId: 'p-2',
        network: SocialNetwork.X,
        label: 'b',
        content: 'B variant',
        selected: true,
        likes: 5,
        comments: 0,
        shares: 0,
        impressions: null,
        postedAt,
        metricsAt: postedAt,
        judgeScores: null,
        post: {
          id: 'p-2',
          network: SocialNetwork.X,
          postedAt,
          postUrl: null,
          sourceRef: { topic: 'Mercury retrograde' },
        },
      },
    ]);

    const service = new ABTestService(prisma as never);
    const results = await service.getAbTests({ days: 30, network: 'X', minSampleSize: 2 });

    const test = results[0]!;
    expect(test.winner).toBeNull();
    expect(test.variants.every((v) => v.sampleSize === 1)).toBe(true);
  });
});
