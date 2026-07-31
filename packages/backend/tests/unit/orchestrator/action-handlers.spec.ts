/**
 * Orchestrator action handlers unit tests.
 *
 * Source: packages/backend/src/modules/orchestrator/action-handlers.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostStatus, SocialNetwork } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';
import { GeneratePostsHandler } from '../../../src/modules/orchestrator/action-handlers.js';
import { AutoApproveService } from '../../../src/modules/autonomy/auto-approve.service';
import { GenerationService } from '../../../src/modules/generation/generation.service';
import { createMockConfigService } from '../../mocks/index.js';

describe('GeneratePostsHandler', () => {
  function buildHandler() {
    const configService = createMockConfigService({
      AUTO_APPROVE_ENABLED: 'true',
      AUTONOMOUS_POSTS_PER_RUN: '2',
      AUTONOMOUS_TARGET_NETWORKS: 'X,THREADS',
    });
    const runId = 'run-001';
    const generationService = {
      generate: vi.fn().mockResolvedValue(runId),
    } as unknown as GenerationService;

    const judgeScores: JudgeScores = {
      anti_ai_tone: 0.8,
      anti_ai_tone_reason: 'sounds human',
      hook_strength: 0.7,
      hook_strength_reason: 'strong hook',
      factual_accuracy: 0.9,
      factual_accuracy_reason: 'facts correct',
      character_limit: 1.0,
      character_limit_reason: 'fits',
    };

    const autoApproveResults: Map<string, { decision: 'AUTO_APPROVE' | 'HUMAN_REVIEW' | 'REJECT' | 'SKIP' }> = new Map();
    const autoApprove = {
      evaluate: vi.fn(async (
        _postId: string,
        _content: string,
        _network: SocialNetwork,
        qualityScore?: number,
        _judgeScores?: JudgeScores,
      ) => {
        const result = autoApproveResults.get(_postId) ?? { decision: 'HUMAN_REVIEW' };
        return { decision: result.decision, postId: _postId, qualityScore: qualityScore ?? null, checkResult: { passed: true, checks: [] }, reason: 'test' };
      }),
    } as unknown as Pick<AutoApproveService, 'evaluate'>;

    const posts = [
      { id: 'post-1', content: 'Post 1', network: SocialNetwork.X, status: PostStatus.DRAFT, llmMetadata: { qualityScore: 8, judgeScores } },
      { id: 'post-2', content: 'Post 2', network: SocialNetwork.THREADS, status: PostStatus.DRAFT, llmMetadata: {} },
      { id: 'post-3', content: 'Post 3', network: SocialNetwork.X, status: PostStatus.DRAFT, llmMetadata: { qualityScore: 'not a number', judgeScores: { anti_ai_tone: 'bad' } } },
    ];

    const prisma = {
      post: {
        findMany: vi.fn().mockResolvedValue(posts),
        count: vi.fn().mockResolvedValue(posts.length),
      },
    };

    const moduleRef = {
      get: vi.fn((cls: unknown) => {
        if (cls === GenerationService) return generationService;
        if (cls === AutoApproveService) return autoApprove;
        return null;
      }),
    };

    const handler = new GeneratePostsHandler(configService as never, moduleRef as never, prisma as never);

    return { handler, generationService, autoApprove, prisma, posts, autoApproveResults };
  }

  it('passes qualityScore and judgeScores from post.llmMetadata to AutoApproveService.evaluate', async () => {
    const { handler, autoApprove, posts } = buildHandler();

    await handler.execute({ type: 'GENERATE_POSTS', reason: 'test', source: 'hard_rule' });

    expect(autoApprove.evaluate).toHaveBeenCalledWith('post-1', 'Post 1', SocialNetwork.X, 8, posts[0]!.llmMetadata.judgeScores);
    expect(autoApprove.evaluate).toHaveBeenCalledWith('post-2', 'Post 2', SocialNetwork.THREADS, undefined, undefined);
    expect(autoApprove.evaluate).toHaveBeenCalledWith('post-3', 'Post 3', SocialNetwork.X, undefined, undefined);
  });

  it('returns postsApproved count based on auto-approve decisions', async () => {
    const { handler, autoApproveResults } = buildHandler();
    autoApproveResults.set('post-1', { decision: 'AUTO_APPROVE' });
    autoApproveResults.set('post-2', { decision: 'HUMAN_REVIEW' });
    autoApproveResults.set('post-3', { decision: 'AUTO_APPROVE' });

    const result = await handler.execute({ type: 'GENERATE_POSTS', reason: 'test', source: 'hard_rule' });

    expect(result.postsGenerated).toBe(3);
    expect(result.postsApproved).toBe(2);
  });
});
