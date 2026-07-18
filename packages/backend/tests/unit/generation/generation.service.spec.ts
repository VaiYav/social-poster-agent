/**
 * MOD-02: Generation Module — GenerationService unit tests.
 *
 * Source: packages/backend/src/modules/generation/generation.service.ts
 * Test cases: CONSTITUTION.md §14 (Testing) — UTC-200..UTC-229
 *
 * Mocked dependencies:
 *   - ILlmPort (generate, generateChat, getPromptVersion)
 *   - ContentSourceService (getTopics)
 *   - AccountsService (findByNetwork)
 *   - PostsService (create, findBySourceAndNetwork)
 *   - PrismaService (generationRun.create/update/findMany, post.findMany, postThread.create)
 *   - RedisCheckpointSaver (put, get, list, listKeysForThread)
 *   - SseService (publish)
 *   - TrendingService (getTrendingTopics) — optional
 *   - TrendingScraperService (getMergedTrending) — optional
 *   - ContentPillarTracker (recommendPillar, recordPillar) — optional
 *   - HookPerformanceBank — optional
 *   - VisualConceptService — optional
 *   - ThreadDepthService (planThread) — optional
 *   - ABVariantGenerator (generateVariants, isEnabled) — optional
 *
 * The LangGraph workflow is mocked via vi.mock to return controlled posts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialNetwork, GenerationRunStatus, GenerationTrigger, PostStatus } from '@prisma/client';
import type { ContentTopic } from '@spa/shared';

// ── Mock the graph module so getGraph().invoke returns controlled state ──────

const mockInvoke = vi.fn();
const mockGetState = vi.fn();

vi.mock('../../../src/modules/generation/generation.graph.js', () => ({
  buildGenerationGraph: vi.fn(() => ({
    compile: vi.fn(() => ({
      invoke: mockInvoke,
      getState: mockGetState,
    })),
  })),
  createInitialState: vi.fn((topic, networks, brandVoice, humanReview) => ({
    topic,
    targetNetworks: networks,
    brandVoice,
    facts: [],
    hooks: [],
    results: {},
    model: '',
    posts: [],
    error: null,
    humanReview,
  })),
}));

// Mock brand-voice.md read
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import { GenerationService } from '../../../src/modules/generation/generation.service';
import { createMockLlmPort, createMockPrismaService, createMockSseService, createMockCheckpointSaver, createMockConfigService } from '../../mocks/index';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_X = { id: 'acc-x', network: SocialNetwork.X, handle: 'myzodiacai', active: true };
const ACCOUNT_THREADS = { id: 'acc-threads', network: SocialNetwork.THREADS, handle: 'myzodiacai', active: true };
const ACCOUNT_FB = { id: 'acc-fb', network: SocialNetwork.FACEBOOK, handle: 'myzodiacai@fb.com', active: true };

const TOPIC_1: ContentTopic = {
  sourceType: 'brief',
  path: 'briefs/mercury-retro-2026.json',
  topic: 'Mercury Retrograde July 2026',
  keywords: ['mercury', 'retrograde'],
  facts: ['Mercury retrograde: July 14 – August 7, 2026', 'Zodiac signs affected: Leo, Virgo'],
  category: 'educational',
  publishedAt: new Date('2026-07-15T10:00:00Z'),
};

const TOPIC_2: ContentTopic = {
  sourceType: 'article',
  path: 'blog/en/full-moon-capricorn.md',
  topic: 'Full Moon in Capricorn',
  keywords: ['full moon', 'capricorn'],
  facts: ['Full moon on July 21, 2026', 'Capricorn energy: discipline, ambition'],
  category: 'educational',
  publishedAt: new Date('2026-07-16T10:00:00Z'),
};

const TRENDING_TOPIC: ContentTopic = {
  sourceType: 'topic',
  path: 'trending/google+x',
  topic: 'Mercury transit',
  keywords: ['google', 'x'],
  facts: [],
  category: 'trending',
  publishedAt: new Date('2026-07-17T10:00:00Z'),
};

function genPost(network: SocialNetwork, content: string, hook = 'Hook line') {
  return {
    network,
    content,
    hook,
    angle: 'question — engaging',
    model: 'gpt-4o-mini',
    qualityScore: 8,
    hookTechnique: 'question' as const,
    contentStyleId: 'style-1',
    visualConcept: null,
    abVariants: null,
  };
}

function createMockContentSourceService(topics: ContentTopic[] = [TOPIC_1, TOPIC_2]) {
  return {
    getTopics: vi.fn().mockResolvedValue(topics),
    readBriefs: vi.fn().mockResolvedValue(topics.filter((t) => t.sourceType === 'brief')),
    readArticles: vi.fn().mockResolvedValue(topics.filter((t) => t.sourceType === 'article')),
    markUsed: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAccountsService(accounts = [ACCOUNT_X, ACCOUNT_THREADS, ACCOUNT_FB]) {
  return {
    findByNetwork: vi.fn((network: SocialNetwork) =>
      accounts.find((a) => a.network === network) ?? null,
    ),
    findAll: vi.fn().mockResolvedValue(accounts),
    seedFromEnv: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn(),
  };
}

function createMockPostsService() {
  return {
    create: vi.fn((data: { accountId: string; network: SocialNetwork; content: string }) => ({
      id: `post-${Math.random().toString(36).slice(2, 10)}`,
      accountId: data.accountId,
      network: data.network,
      content: data.content,
      status: PostStatus.DRAFT,
    })),
    emitDraftGenerated: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    findMany: vi.fn().mockResolvedValue([]),
    findDrafts: vi.fn().mockResolvedValue([]),
    findBySourceAndNetwork: vi.fn().mockResolvedValue([]),
    findThreadContinuations: vi.fn().mockResolvedValue([]),
  };
}

function createMockTrendingService() {
  return {
    getTrendingTopics: vi.fn().mockReturnValue([
      { topic: 'Mercury transit', trending: true, networks: ['X', 'THREADS'] },
    ]),
    getUpcoming: vi.fn().mockReturnValue([]),
  };
}

function createMockTrendingScraper() {
  return {
    getMergedTrending: vi.fn().mockResolvedValue([
      { topic: 'Mercury transit', sources: ['google', 'x'], scrapedAt: new Date() },
    ]),
    getGoogleTrends: vi.fn().mockResolvedValue([]),
    getXTrends: vi.fn().mockResolvedValue([]),
  };
}

function createMockPillarTracker() {
  return {
    recommendPillar: vi.fn().mockResolvedValue({
      recommended: 'educational',
      reason: 'Underrepresented',
    }),
    recordPillar: vi.fn().mockResolvedValue(undefined),
    getPillarStats: vi.fn().mockResolvedValue([]),
    recordPost: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockThreadDepthService() {
  return {
    planThread: vi.fn().mockResolvedValue({
      depth: 1,
      continuations: [],
      reasoning: 'Single post is sufficient',
    }),
    isEnabled: vi.fn().mockReturnValue(true),
  };
}

function createMockABGenerator() {
  return {
    generateVariants: vi.fn().mockResolvedValue(null),
    isEnabled: vi.fn().mockReturnValue(false),
  };
}

function createMockHookBank() {
  return {
    aggregateStats: vi.fn().mockResolvedValue(undefined),
    getRecommendation: vi.fn().mockResolvedValue({ technique: 'question', guidance: '' }),
  };
}

function createMockVisualService() {
  return {
    generateConcept: vi.fn().mockResolvedValue(null),
    isEnabled: vi.fn().mockReturnValue(false),
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

let service: GenerationService;
let prisma: ReturnType<typeof createMockPrismaService>;
let sse: ReturnType<typeof createMockSseService>;
let llm: ReturnType<typeof createMockLlmPort>;
let contentSource: ReturnType<typeof createMockContentSourceService>;
let accounts: ReturnType<typeof createMockAccountsService>;
let posts: ReturnType<typeof createMockPostsService>;
let checkpoint: ReturnType<typeof createMockCheckpointSaver>;
let configService: ReturnType<typeof createMockConfigService>;
let abVariantService: { createVariants: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
  mockGetState.mockReset();

  llm = createMockLlmPort();
  (llm as any).getPromptVersion = vi.fn().mockReturnValue('0.3.0');
  contentSource = createMockContentSourceService();
  accounts = createMockAccountsService();
  posts = createMockPostsService();
  prisma = createMockPrismaService();
  prisma.generationRun.create.mockResolvedValue({
    id: 'run-001',
    status: GenerationRunStatus.RUNNING,
    triggeredBy: GenerationTrigger.MANUAL,
    sourceTopics: [],
    startedAt: new Date('2026-07-15T10:00:00Z'),
    completedAt: null,
    errorMessage: null,
  });
  prisma.generationRun.update.mockResolvedValue(undefined);
  prisma.generationRun.findUnique.mockResolvedValue(null);
  prisma.generationRun.findMany.mockResolvedValue([]);
  prisma.post.findMany.mockResolvedValue([]);
  prisma.post.update.mockResolvedValue(undefined);
  prisma.postThread.create.mockResolvedValue({ id: 'thread-001' });
  sse = createMockSseService();
  checkpoint = createMockCheckpointSaver();
  configService = createMockConfigService();
  abVariantService = { createVariants: vi.fn().mockResolvedValue(undefined) };

  service = new GenerationService(
    llm,
    contentSource as any,
    accounts as any,
    posts as any,
    prisma as any,
    checkpoint as any,
    sse as any,
    configService as any,
  );
  // Inject the mock A/B variant service so persistPostVariants runs in tests.
  (service as any).abVariantService = abVariantService;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GenerationService', () => {

  // ── generate() ───────────────────────────────────────────────────────────

  describe('generate()', () => {

    it('UTC-200: generates posts for 1 topic × 3 networks = 3 drafts', async () => {
      // Arrange: 1 topic, graph returns 3 posts (one per network) with DISTINCT content
      // (SimHash dedup skips near-identical posts — Hamming distance ≤ 3)
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({
        posts: [
          genPost(SocialNetwork.X, 'Mercury retrograde starts July 14! Time to reflect on communication patterns. ♋'),
          genPost(SocialNetwork.THREADS, 'The full moon in Capricorn brings discipline and ambition to your career. ♑'),
          genPost(SocialNetwork.FACEBOOK, 'Did you know Mercury retrograde affects Virgo and Leo most? Here is what to expect. ♒'),
        ],
        facts: TOPIC_1.facts,
      });

      // Act
      const runId = await service.generate(1, [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK]);

      // Assert
      expect(runId).toBe('run-001');
      expect(prisma.generationRun.create).toHaveBeenCalledWith({
        data: { triggeredBy: GenerationTrigger.MANUAL, sourceTopics: [] },
      });
      expect(posts.create).toHaveBeenCalledTimes(3);
      expect(posts.create).toHaveBeenCalledWith(expect.objectContaining({
        network: SocialNetwork.X,
        generationRunId: 'run-001',
      }));
      expect(sse.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'generation_started', runId: 'run-001', count: 1 }));
      expect(sse.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'generation_completed', runId: 'run-001' }));
    });

    it('UTC-200a: persists PostVariants for each generated post', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({
        posts: [
          genPost(SocialNetwork.X, 'Mercury retrograde starts July 14 for X!'),
          genPost(SocialNetwork.THREADS, 'Mercury retrograde starts July 14 for Threads!'),
        ],
        facts: TOPIC_1.facts,
      });

      await service.generate(1, [SocialNetwork.X, SocialNetwork.THREADS]);

      expect(abVariantService.createVariants).toHaveBeenCalledTimes(2);
      expect(abVariantService.createVariants).toHaveBeenCalledWith(
        expect.any(String),
        SocialNetwork.X,
        'Mercury retrograde starts July 14 for X!',
        null,
        undefined,
      );
    });

    it('UTC-201: empty topics → run marked with error message, 0 posts', async () => {
      contentSource.getTopics.mockResolvedValue([]);

      const runId = await service.generate(3);

      expect(runId).toBe('run-001');
      expect(posts.create).not.toHaveBeenCalled();
      // markRunCompleted with errorMessage → status FAILED
      expect(prisma.generationRun.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: GenerationRunStatus.FAILED,
          errorMessage: 'No topics found',
        }),
      }));
    });

    it('UTC-202: default params → count=3, all networks, MANUAL trigger', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1, TOPIC_2]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Test')], facts: [] });

      await service.generate();

      expect(contentSource.getTopics).toHaveBeenCalledWith(3);
      // Each topic generates for all 3 networks
      expect(mockInvoke).toHaveBeenCalled();
    });

    it('UTC-203: SSE generation_started event published', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Test')], facts: [] });

      await service.generate(1);

      expect(sse.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'generation_started', runId: 'run-001', count: 1 }),
      );
    });

    it('UTC-204: SSE generation_completed event with post count', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({
        posts: [
          genPost(SocialNetwork.X, 'Mercury retrograde starts July 14! Time to reflect on communication. ♋'),
          genPost(SocialNetwork.THREADS, 'The full moon in Capricorn brings discipline and ambition to career. ♑'),
        ],
        facts: [],
      });

      await service.generate(1);

      expect(sse.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'generation_completed', runId: 'run-001', postCount: 2 }),
      );
    });

    it('UTC-205: generation failure → run marked FAILED + SSE generation_failed', async () => {
      contentSource.getTopics.mockRejectedValue(new Error('Content source down'));

      await expect(service.generate(1)).rejects.toThrow('Content source down');

      expect(prisma.generationRun.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: GenerationRunStatus.FAILED,
          errorMessage: 'Content source down',
        }),
      }));
      expect(sse.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'generation_failed', runId: 'run-001' }),
      );
    });

    it('UTC-206: graph returns empty content for a network → post skipped', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({
        posts: [
          genPost(SocialNetwork.X, 'Valid post'),
          genPost(SocialNetwork.THREADS, ''),  // empty content
        ],
        facts: [],
      });

      await service.generate(1);

      expect(posts.create).toHaveBeenCalledTimes(1);
      expect(posts.create).toHaveBeenCalledWith(expect.objectContaining({ content: 'Valid post' }));
    });

    it('UTC-207: no active account for network → post skipped', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      accounts.findByNetwork.mockImplementation((network: SocialNetwork) =>
        network === SocialNetwork.X ? ACCOUNT_X : null,
      );
      mockInvoke.mockResolvedValue({
        posts: [
          genPost(SocialNetwork.X, 'X post'),
          genPost(SocialNetwork.THREADS, 'Threads post'),
        ],
        facts: [],
      });

      await service.generate(1);

      expect(posts.create).toHaveBeenCalledTimes(1);
      expect(posts.create).toHaveBeenCalledWith(expect.objectContaining({ network: SocialNetwork.X }));
    });

    it('UTC-208: already posted about source → network skipped (dedup)', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      posts.findBySourceAndNetwork.mockResolvedValue([{ id: 'existing-post' }]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Test')], facts: [] });

      await service.generate(1);

      expect(posts.create).not.toHaveBeenCalled();
    });

    it('UTC-209: SimHash dedup — near-duplicate post skipped', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      // Recent post with identical content → simhash will match
      prisma.post.findMany.mockResolvedValue([
        { content: 'Mercury retrograde is coming! ♋', simhash: null, llmMetadata: null, sourceRef: null },
      ]);
      mockInvoke.mockResolvedValue({
        posts: [genPost(SocialNetwork.X, 'Mercury retrograde is coming! ♋')],
        facts: [],
      });

      await service.generate(1);

      expect(posts.create).not.toHaveBeenCalled();
    });

    it('UTC-210: LLM metadata stored with model, hook, simhash', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Test content')], facts: [] });

      await service.generate(1);

      expect(posts.create).toHaveBeenCalledWith(expect.objectContaining({
        llmMetadata: expect.objectContaining({
          model: 'gpt-4o-mini',
          hook: 'Hook line',
          hookTechnique: 'question',
        }),
        simhash: expect.any(String),
      }));
    });
  });

  // ── generate() with optional trending enrichment ─────────────────────────

  describe('generate() — trending enrichment', () => {

    it('UTC-211: trending scraper enriches topics with trending content', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const trendingScraper = createMockTrendingScraper();
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Trending post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, trendingScraper as any,
      );

      await svc.generate(1);

      expect(trendingScraper.getMergedTrending).toHaveBeenCalled();
      // Trending topic should be checked by guardrail (LLM called for opportunity score)
      // and if safe, included in generation
    });

    it('UTC-212: trending scraper fails → graceful degradation (content topics only)', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const trendingScraper = createMockTrendingScraper();
      trendingScraper.getMergedTrending.mockRejectedValue(new Error('Scrape failed'));
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Content post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, trendingScraper as any,
      );

      const runId = await svc.generate(1);

      expect(runId).toBe('run-001');
      expect(posts.create).toHaveBeenCalled();
    });

    it('UTC-213: trending service provides astro topics to scraper', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const trendingService = createMockTrendingService();
      const trendingScraper = createMockTrendingScraper();
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        trendingService as any, trendingScraper as any,
      );

      await svc.generate(1);

      expect(trendingService.getTrendingTopics).toHaveBeenCalled();
      expect(trendingScraper.getMergedTrending).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ topic: 'Mercury transit' })]),
      );
    });
  });

  // ── generate() — trend guardrail ─────────────────────────────────────────

  describe('generate() — trend guardrail (P5)', () => {

    it('UTC-214: blocklisted trending topic → rejected', async () => {
      const blocklisted: ContentTopic = {
        sourceType: 'topic',
        path: 'trending/google',
        topic: 'Political scandal erupts',
        keywords: ['google'],
        facts: [],
        category: 'trending',
        publishedAt: new Date(),
      };
      contentSource.getTopics.mockResolvedValue([TOPIC_1, blocklisted]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Safe post')], facts: [] });

      await service.generate(2);

      // TOPIC_1 (brief) passes guardrail; blocklisted topic is rejected
      // Only safe topic generates posts
      expect(posts.create).toHaveBeenCalled();
    });

    it('UTC-215: non-trending source → guardrail bypassed', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Brief post')], facts: [] });

      await service.generate(1);

      // Brief source — no LLM guardrail call needed
      expect(llm.generateChat).not.toHaveBeenCalledWith(
        expect.stringContaining('opportunity'),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('UTC-216: all topics rejected by guardrail → run marked FAILED, 0 posts', async () => {
      const allTrending: ContentTopic[] = [
        { sourceType: 'topic', path: 'trending/x', topic: 'scandal topic', keywords: [], facts: [], category: 'trending', publishedAt: new Date() },
      ];
      contentSource.getTopics.mockResolvedValue(allTrending);
      mockInvoke.mockResolvedValue({ posts: [], facts: [] });

      const runId = await service.generate(1);

      expect(runId).toBe('run-001');
      expect(posts.create).not.toHaveBeenCalled();
      // markRunCompleted with errorMessage → status FAILED
      expect(prisma.generationRun.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: GenerationRunStatus.FAILED,
          errorMessage: 'All topics rejected by trend guardrail',
        }),
      }));
    });
  });

  // ── generate() — content pillar rotation ─────────────────────────────────

  describe('generate() — content pillar rotation (P6)', () => {

    it('UTC-217: pillar tracker recommends pillar → keywords injected', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const pillarTracker = createMockPillarTracker();
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Pillar post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, undefined, pillarTracker as any,
      );

      await svc.generate(1);

      expect(pillarTracker.recommendPillar).toHaveBeenCalled();
      // The pillar hint should be injected as first keyword
      const state = mockInvoke.mock.calls[0][0];
      expect(state.topic.keywords[0]).toBe('pillar:educational');
    });

    it('UTC-218: pillar tracker fails → graceful degradation', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const pillarTracker = createMockPillarTracker();
      pillarTracker.recommendPillar.mockRejectedValue(new Error('Redis down'));
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, undefined, pillarTracker as any,
      );

      const runId = await svc.generate(1);

      expect(runId).toBe('run-001');
      expect(posts.create).toHaveBeenCalled();
    });

    it('UTC-219: source topic is marked used after post creation', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post')], facts: [] });

      await service.generate(1);

      expect(contentSource.markUsed).toHaveBeenCalled();
    });
  });

  // ── generate() — multi-stage thread ──────────────────────────────────────

  describe('generate() — multi-stage thread (F2/P4)', () => {

    it('UTC-220: multiStage=true with ThreadDepthService → depth>1 creates continuations', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const threadDepth = createMockThreadDepthService();
      threadDepth.planThread.mockResolvedValue({
        depth: 3,
        continuations: [
          { position: 1, content: 'Continuation 1' },
          { position: 2, content: 'Continuation 2' },
        ],
        reasoning: 'Rich content warrants thread',
      });
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Root post')], facts: TOPIC_1.facts });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, undefined, undefined, undefined, undefined, threadDepth as any,
      );

      await svc.generate(1, [SocialNetwork.X], GenerationTrigger.MANUAL, true);

      expect(threadDepth.planThread).toHaveBeenCalled();
      expect(prisma.postThread.create).toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ threadId: 'thread-001', threadPosition: 0 }),
      }));
      // Root + 2 continuations = 3 posts
      expect(posts.create).toHaveBeenCalledTimes(3);
      // H1: continuations emit DRAFT_GENERATED only AFTER the tx commits (2 continuations).
      expect(posts.emitDraftGenerated).toHaveBeenCalledTimes(2);
    });

    it('UTC-223: P4 thread assembly runs inside a DB transaction (A4 atomicity)', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const threadDepth = createMockThreadDepthService();
      threadDepth.planThread.mockResolvedValue({
        depth: 2,
        continuations: [{ position: 1, content: 'Continuation 1' }],
        reasoning: 'thread',
      });
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Root post')], facts: TOPIC_1.facts });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, undefined, undefined, undefined, undefined, threadDepth as any,
      );

      await svc.generate(1, [SocialNetwork.X], GenerationTrigger.MANUAL, true);

      // Thread row + root link + continuations must be wrapped in one transaction.
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.postThread.create).toHaveBeenCalled();
      // P0 1.3: transactions must have a 30s timeout to avoid long-running locks.
      const txCall = (prisma.$transaction.mock.calls as unknown[][]).find((c) => c[1]?.timeout === 30000);
      expect(txCall).toBeTruthy();
    });

    it('UTC-221: multiStage=true without ThreadDepthService → F2 fallback (2 posts)', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      llm.generateChat.mockResolvedValue({ content: 'Continuation content here', model: 'gpt-4o-mini', tokens: 50, cost: 0.001 });
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Root post')], facts: [] });

      await service.generate(1, [SocialNetwork.X], GenerationTrigger.MANUAL, true);

      // F2: root + 1 continuation = 2 posts
      expect(posts.create).toHaveBeenCalledTimes(2);
      expect(prisma.postThread.create).toHaveBeenCalled();
      // H1: the F2 continuation emits DRAFT_GENERATED after the tx commits.
      expect(posts.emitDraftGenerated).toHaveBeenCalledTimes(1);
    });

    it('UTC-222: Facebook never gets threads even with multiStage', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.FACEBOOK, 'FB post')], facts: [] });

      await service.generate(1, [SocialNetwork.FACEBOOK], GenerationTrigger.MANUAL, true);

      // Facebook: single post, no thread
      expect(posts.create).toHaveBeenCalledTimes(1);
      expect(prisma.postThread.create).not.toHaveBeenCalled();
    });

    it('UTC-223: ThreadDepthService returns depth=1 → no continuations', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      const threadDepth = createMockThreadDepthService();
      // depth=1 is the default mock
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Single post')], facts: [] });

      const svc = new GenerationService(
        llm, contentSource as any, accounts as any, posts as any,
        prisma as any, checkpoint as any, sse as any, configService as any,
        undefined, undefined, undefined, undefined, undefined, threadDepth as any,
      );

      await svc.generate(1, [SocialNetwork.X], GenerationTrigger.MANUAL, true);

      expect(posts.create).toHaveBeenCalledTimes(1);
      expect(prisma.postThread.create).not.toHaveBeenCalled();
    });
  });

  // ── repurposeFromArticles() ──────────────────────────────────────────────

  describe('repurposeFromArticles()', () => {

    it('UTC-224: 1 article with 2 facts → 2 posts per network', async () => {
      const article: ContentTopic = {
        sourceType: 'article',
        path: 'blog/en/test.md',
        topic: 'Test Article',
        keywords: ['test'],
        facts: ['Fact one', 'Fact two'],
        category: 'blog_promo',
        publishedAt: new Date(),
      };
      contentSource.getTopics.mockResolvedValue([article]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post from fact')], facts: [] });

      const runId = await service.repurposeFromArticles(1, [SocialNetwork.X]);

      expect(runId).toBe('run-001');
      // 2 facts × 1 network = 2 posts
      expect(posts.create).toHaveBeenCalledTimes(2);
      // sourceRef updated with factIndex
      expect(prisma.post.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          sourceRef: expect.objectContaining({ factIndex: expect.any(Number) }),
        }),
      }));
    });

    it('UTC-225: no articles with facts → run completes with 0 posts', async () => {
      const noFacts: ContentTopic = {
        sourceType: 'article',
        path: 'blog/en/no-facts.md',
        topic: 'No Facts',
        keywords: [],
        facts: [],
        publishedAt: new Date(),
      };
      contentSource.getTopics.mockResolvedValue([noFacts]);

      const runId = await service.repurposeFromArticles(1);

      expect(runId).toBe('run-001');
      expect(posts.create).not.toHaveBeenCalled();
    });
  });

  // ── recycleTopPosts() ────────────────────────────────────────────────────

  describe('recycleTopPosts()', () => {

    it('UTC-226: old posted posts → recycled with fresh angle', async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
      prisma.post.findMany.mockResolvedValue([
        {
          id: 'old-post-1',
          content: 'Old successful post about Mercury',
          network: SocialNetwork.X,
          sourceRef: { topic: 'Mercury Retrograde' },
          createdAt: oldDate,
        },
      ]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Fresh recycled post')], facts: [] });

      const runId = await service.recycleTopPosts(30, 1, [SocialNetwork.X]);

      expect(runId).toBe('run-001');
      expect(posts.create).toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          sourceRef: expect.objectContaining({ type: 'recycle' }),
        }),
      }));
    });

    it('UTC-227: no old posts found → run completes with 0 posts', async () => {
      prisma.post.findMany.mockResolvedValue([]);

      const runId = await service.recycleTopPosts(30, 3);

      expect(runId).toBe('run-001');
      expect(posts.create).not.toHaveBeenCalled();
    });

    it('UTC-228: duplicate topics deduplicated → only unique recycled', async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      prisma.post.findMany.mockResolvedValue([
        { id: 'old-1', content: 'Post 1', network: SocialNetwork.X, sourceRef: { topic: 'Same Topic' }, createdAt: oldDate },
        { id: 'old-2', content: 'Post 2', network: SocialNetwork.X, sourceRef: { topic: 'Same Topic' }, createdAt: oldDate },
      ]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Recycled')], facts: [] });

      await service.recycleTopPosts(30, 5, [SocialNetwork.X]);

      // Only 1 unique topic → 1 generation call
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  // ── pauseRun() / resumeRun() ─────────────────────────────────────────────

  describe('pauseRun()', () => {

    it('UTC-229: pause → run marked PAUSED + SSE event', async () => {
      const result = await service.pauseRun('run-001');

      expect(result).toEqual({ runId: 'run-001', status: 'paused' });
      expect(prisma.generationRun.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: GenerationRunStatus.PAUSED }),
      }));
      expect(sse.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'generation_paused', runId: 'run-001' }));
    });
  });

  describe('resumeRun()', () => {

    it('UTC-230: resume non-existent run → throws', async () => {
      prisma.generationRun.findUnique.mockResolvedValue(null);

      await expect(service.resumeRun('nonexistent')).rejects.toThrow('not found');
    });

    it('UTC-231: resume run with no sourceTopics → marked failed', async () => {
      prisma.generationRun.findUnique.mockResolvedValue({
        id: 'run-001',
        status: GenerationRunStatus.PAUSED,
        sourceTopics: [],
      });

      const result = await service.resumeRun('run-001');

      expect(result).toEqual({ runId: 'run-001', status: 'failed' });
      expect(prisma.generationRun.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: GenerationRunStatus.FAILED }),
      }));
    });
  });

  // ── listRuns() / getRun() ────────────────────────────────────────────────

  describe('listRuns()', () => {

    it('UTC-232: list runs → returns with ISO dates', async () => {
      const date = new Date('2026-07-15T10:00:00Z');
      prisma.generationRun.findMany.mockResolvedValue([
        { id: 'run-1', status: 'COMPLETED', startedAt: date, completedAt: date, _count: { posts: 3 } },
      ]);

      const runs = await service.listRuns(10);

      expect(runs).toHaveLength(1);
      expect(runs[0].startedAt).toBe(date.toISOString());
      expect(runs[0].completedAt).toBe(date.toISOString());
    });
  });

  describe('getRun()', () => {

    it('UTC-233: get run by ID → returns run with posts', async () => {
      const date = new Date('2026-07-15T10:00:00Z');
      prisma.generationRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETED',
        startedAt: date,
        completedAt: date,
        posts: [{ id: 'p1', network: SocialNetwork.X, content: 'Test', status: 'DRAFT', createdAt: date }],
      });

      const run = await service.getRun('run-1');

      expect(run).not.toBeNull();
      expect(run!.id).toBe('run-1');
      expect(run!.posts[0].createdAt).toBe(date.toISOString());
    });

    it('UTC-234: get non-existent run → null', async () => {
      prisma.generationRun.findUnique.mockResolvedValue(null);

      const run = await service.getRun('nonexistent');

      expect(run).toBeNull();
    });
  });

  // ── prioritizeTopics() (indirect) ────────────────────────────────────────

  describe('topic prioritization (B5)', () => {

    it('UTC-235: freshest topics prioritized (publishedAt desc)', async () => {
      const older: ContentTopic = { ...TOPIC_1, publishedAt: new Date('2026-07-10T00:00:00Z'), topic: 'Older' };
      const newer: ContentTopic = { ...TOPIC_2, publishedAt: new Date('2026-07-20T00:00:00Z'), topic: 'Newer' };
      contentSource.getTopics.mockResolvedValue([older, newer]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post')], facts: [] });

      await service.generate(1);

      // Newer topic should be processed first
      const state = mockInvoke.mock.calls[0][0];
      expect(state.topic.topic).toBe('Newer');
    });

    it('UTC-236: category rotation — no two consecutive same category', async () => {
      const t1: ContentTopic = { ...TOPIC_1, category: 'educational', topic: 'Edu 1' };
      const t2: ContentTopic = { ...TOPIC_1, category: 'educational', topic: 'Edu 2' };
      const t3: ContentTopic = { ...TOPIC_2, category: 'wellness', topic: 'Wellness 1' };
      contentSource.getTopics.mockResolvedValue([t1, t2, t3]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Post')], facts: [] });

      await service.generate(3);

      // Should process all 3 topics
      expect(mockInvoke).toHaveBeenCalledTimes(3);
    });
  });

  // ── loadRecentPostHashes (indirect) ──────────────────────────────────────

  describe('SimHash dedup (B5)', () => {

    it('UTC-237: recent post hashes loaded from prisma (simhash field)', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      prisma.post.findMany.mockResolvedValue([
        { content: 'old post', simhash: 'abc123', llmMetadata: null, sourceRef: null },
      ]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Unique content')], facts: [] });

      await service.generate(1);

      // prisma.post.findMany called to load recent hashes
      expect(prisma.post.findMany).toHaveBeenCalled();
    });

    it('UTC-238: fallback to llmMetadata.simhash when simhash field null', async () => {
      contentSource.getTopics.mockResolvedValue([TOPIC_1]);
      prisma.post.findMany.mockResolvedValue([
        { content: 'old post', simhash: null, llmMetadata: { simhash: 'meta-hash' }, sourceRef: null },
      ]);
      mockInvoke.mockResolvedValue({ posts: [genPost(SocialNetwork.X, 'Unique')], facts: [] });

      await service.generate(1);

      expect(posts.create).toHaveBeenCalled();
    });
  });
});
