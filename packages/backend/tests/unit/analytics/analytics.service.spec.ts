/**
 * AnalyticsService unit tests.
 *
 * Source: packages/backend/src/modules/analytics/analytics.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostStatus, SocialNetwork } from '@prisma/client';
import { AnalyticsService } from '../../../src/modules/analytics/analytics.service';
import { createMockPrismaService } from '../../mocks/index.js';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    service = new AnalyticsService(prisma as never);
  });

  describe('getAutonomousStats', () => {
    it('returns judge score averages overall and by decision', async () => {
      (prisma.post.count as ReturnType<typeof vi.fn>).mockResolvedValue(10);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ autoApproved: 4, rejected: 2, humanReview: 1 }])
        .mockResolvedValueOnce([{ avgScore: '0.82' }])
        .mockResolvedValueOnce([{ score: '0.8', count: 3 }])
        .mockResolvedValueOnce([{ reason: 'low quality', count: 2 }])
        .mockResolvedValueOnce([
          {
            antiAiTone: 0.75,
            hookStrength: 0.85,
            factualAccuracy: 0.9,
            characterLimit: 0.95,
            count: 7,
          },
        ])
        .mockResolvedValueOnce([
          {
            decision: 'AUTO_APPROVE',
            antiAiTone: 0.8,
            hookStrength: 0.9,
            factualAccuracy: 0.95,
            characterLimit: 1.0,
            count: 4,
          },
          {
            decision: 'REJECT',
            antiAiTone: 0.6,
            hookStrength: 0.7,
            factualAccuracy: 0.75,
            characterLimit: 0.8,
            count: 3,
          },
        ]);

      const stats = await service.getAutonomousStats();

      expect(stats.judgeStats.overall).toMatchObject({
        antiAiTone: 0.75,
        hookStrength: 0.85,
        factualAccuracy: 0.9,
        characterLimit: 0.95,
        count: 7,
      });
      expect(stats.judgeStats.byDecision.AUTO_APPROVE).toMatchObject({
        antiAiTone: 0.8,
        hookStrength: 0.9,
        factualAccuracy: 0.95,
        characterLimit: 1,
        count: 4,
      });
      expect(stats.judgeStats.byDecision.REJECT).toMatchObject({
        antiAiTone: 0.6,
        hookStrength: 0.7,
        factualAccuracy: 0.75,
        characterLimit: 0.8,
        count: 3,
      });
    });

    it('returns null averages when no judge scores exist', async () => {
      (prisma.post.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ autoApproved: 0, rejected: 0, humanReview: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const stats = await service.getAutonomousStats();

      expect(stats.judgeStats.overall).toMatchObject({
        antiAiTone: null,
        hookStrength: null,
        factualAccuracy: null,
        characterLimit: null,
        count: 0,
      });
      expect(Object.keys(stats.judgeStats.byDecision)).toHaveLength(0);
    });
  });

  describe('generateReport', () => {
    it('aggregates judge scores by dimension and decision', async () => {
      const postedAt = new Date('2026-07-01T12:00:00Z');
      const posts = [
        {
          id: 'p-1',
          network: SocialNetwork.X,
          status: PostStatus.POSTED,
          content: 'Post 1',
          createdAt: postedAt,
          postedAt,
          llmMetadata: {
            autoApproveDecision: 'AUTO_APPROVE',
            qualityScore: 8.5,
            judgeScores: {
              anti_ai_tone: 0.9,
              hook_strength: 0.8,
              factual_accuracy: 0.85,
              character_limit: 1.0,
            },
          },
          generationRun: { triggeredBy: 'SCHEDULE' },
        },
        {
          id: 'p-2',
          network: SocialNetwork.THREADS,
          status: PostStatus.REJECTED,
          content: 'Post 2',
          createdAt: postedAt,
          postedAt: null,
          llmMetadata: {
            autoApproveDecision: 'REJECT',
            qualityScore: 4.0,
            judgeScores: {
              anti_ai_tone: 0.3,
              hook_strength: 0.4,
              factual_accuracy: 0.5,
              character_limit: 0.6,
            },
          },
          generationRun: { triggeredBy: 'MANUAL' },
        },
      ];

      (prisma.post.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(posts);

      const report = await service.generateReport('30d');

      expect(report.judgeStats.overall).toMatchObject({
        antiAiTone: 0.6, // (0.9 + 0.3) / 2
        hookStrength: 0.6, // (0.8 + 0.4) / 2
        factualAccuracy: 0.68, // (0.85 + 0.5) / 2 = 0.675 -> rounded
        characterLimit: 0.8, // (1.0 + 0.6) / 2
        count: 2,
      });

      expect(report.judgeStats.byDecision.AUTO_APPROVE).toMatchObject({
        antiAiTone: 0.9,
        hookStrength: 0.8,
        factualAccuracy: 0.85,
        characterLimit: 1,
        count: 1,
      });

      expect(report.judgeStats.byDecision.REJECT).toMatchObject({
        antiAiTone: 0.3,
        hookStrength: 0.4,
        factualAccuracy: 0.5,
        characterLimit: 0.6,
        count: 1,
      });
    });

    it('ignores judge score posts with no numeric dimensions', async () => {
      (prisma.post.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'p-1',
          network: SocialNetwork.X,
          status: PostStatus.POSTED,
          content: 'No judge',
          createdAt: new Date(),
          postedAt: new Date(),
          llmMetadata: {},
          generationRun: null,
        },
      ]);

      const report = await service.generateReport('30d');

      expect(report.judgeStats.overall.count).toBe(0);
    });
  });
});
