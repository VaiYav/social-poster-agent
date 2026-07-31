/**
 * EngagementGraph unit tests.
 *
 * Tests the LangGraph StateGraph for engagement: warmup gating,
 * source picking, scroll, and per-post decision delegation.
 *
 * Source: packages/backend/src/modules/engagement/engagement.graph.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocialNetwork } from '@prisma/client';
import {
  buildEngagementGraph,
  createEngagementInitialState,
} from '../../../src/modules/engagement/engagement.graph';
import type { IEngagementDecisionPort, ActionDecision } from '../../../src/domain/ports/engagement-decision.port';
import type { TargetingService } from '../../../src/modules/engagement/targeting.service';
import type { WarmupService, WarmupStatus } from '../../../src/modules/sessions/warmup.service';
import type { HumanBehaviorEngine } from '../../../src/modules/engagement/human-behavior-engine.js';
import type { BaseEngager } from '../../../src/modules/engagement/engagers/base.engager';

// ── Mocks ──

function createMockDecisionPort(): IEngagementDecisionPort {
  return {
    decideAction: vi.fn().mockResolvedValue({
      action: 'scroll', reason: 'test', confidence: 0.5,
    } as ActionDecision),
    generateComment: vi.fn().mockResolvedValue('Test comment.'),
  };
}

function createMockTargetingService(): TargetingService {
  return {
    pickSource: vi.fn().mockReturnValue({
      source: 'home-feed' as const,
      url: 'https://x.com/home',
      label: 'Home Feed',
    }),
    getAvailableSources: vi.fn().mockReturnValue([]),
    getHashtags: vi.fn().mockReturnValue(['#astrology']),
    getCompetitors: vi.fn().mockReturnValue(['costarastrology']),
  } as unknown as TargetingService;
}

function createMockWarmupService(status: WarmupStatus | null = null): WarmupService {
  return {
    getWarmupStatus: vi.fn().mockResolvedValue(status),
    startWarmup: vi.fn(),
    canPost: vi.fn().mockResolvedValue(true),
    completeWarmup: vi.fn(),
  } as unknown as WarmupService;
}

function createMockHumanBehaviorEngine(): HumanBehaviorEngine {
  return {
    processPosts: vi.fn().mockResolvedValue([
      { postUrl: 'url1', decision: { action: 'scroll', reason: 'test', confidence: 0.5 }, success: true },
      { postUrl: 'url2', decision: { action: 'like', reason: 'good', confidence: 0.9 }, success: true, interactionId: 'int-1' },
    ]),
  } as unknown as HumanBehaviorEngine;
}

function createMockEngager(): BaseEngager {
  return {
    scrollFeed: vi.fn().mockResolvedValue(['url1', 'url2', 'url3']),
    scrollUrl: vi.fn().mockResolvedValue(['url1', 'url2', 'url3']),
    extractPostText: vi.fn(),
    openCommentsThread: vi.fn(),
    navigateBack: vi.fn(),
    visitProfile: vi.fn(),
    like: vi.fn(),
    comment: vi.fn(),
    repost: vi.fn(),
    quote: vi.fn(),
  } as unknown as BaseEngager;
}

describe('EngagementGraph', () => {
  let engager: BaseEngager;
  let targetingService: TargetingService;
  let warmupService: WarmupService;
  let humanBehaviorEngine: HumanBehaviorEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engager = createMockEngager();
    targetingService = createMockTargetingService();
    warmupService = createMockWarmupService();
    humanBehaviorEngine = createMockHumanBehaviorEngine();
  });

  // ── Graph building ──

  it('EG-001: buildEngagementGraph returns a compilable graph', () => {
    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    expect(graph).toBeDefined();
    // Should compile without error
    expect(() => graph.compile()).not.toThrow();
  });

  it('EG-002: createEngagementInitialState returns correct initial state', () => {
    const state = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 60,
      maxPosts: 10,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      repostsMaxPerSession: 0,
      quotesMaxPerSession: 0,
      page: null,
    });
    expect(state.network).toBe(SocialNetwork.X);
    expect(state.accountId).toBe('acc-1');
    expect(state.browsingSessionId).toBe('sess-1');
    expect(state.durationSec).toBe(60);
    expect(state.maxPosts).toBe(10);
    expect(state.likesMaxPerSession).toBe(15);
    expect(state.commentsMaxPerSession).toBe(4);
    expect(state.repostsMaxPerSession).toBe(0);
    expect(state.quotesMaxPerSession).toBe(0);
    expect(state.warmupPhase).toBe('none');
    expect(state.results).toEqual([]);
    expect(state.page).toBeNull();
  });

  // ── Graph invocation ──

  it('EG-003: graph calls check_warmup → pick_source → scroll_feed → decide_per_post', async () => {
    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      repostsMaxPerSession: 0,
      quotesMaxPerSession: 0,
      page: {} as never, // mock page
    });

    const finalState = await compiled.invoke(initialState);

    // check_warmup was called (via warmupService.getWarmupStatus)
    expect(warmupService.getWarmupStatus).toHaveBeenCalledWith('acc-1');

    // pick_source was called
    expect(targetingService.pickSource).toHaveBeenCalledWith(SocialNetwork.X);

    // scroll_feed was called (via scrollUrl because the mock targeting service returns a URL)
    expect(engager.scrollUrl).toHaveBeenCalled();

    // decide_per_post was called (via humanBehaviorEngine.processPosts)
    expect(humanBehaviorEngine.processPosts).toHaveBeenCalled();
  });

  it('EG-004: warmup browse-only phase sets likesBudget=0, commentsBudget=0', async () => {
    warmupService = createMockWarmupService({
      accountId: 'acc-1',
      daysElapsed: 0,
      daysTotal: 7,
      phase: 'browse-only',
      canPost: false,
      canInteract: false,
      maxInteractionsPerDay: 0,
    });

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(finalState.warmupPhase).toBe('browse-only');
    expect(finalState.likesBudget).toBe(0);
    expect(finalState.commentsBudget).toBe(0);
  });

  it('EG-005: warmup light phase sets likesBudget=2, commentsBudget=0', async () => {
    warmupService = createMockWarmupService({
      accountId: 'acc-1',
      daysElapsed: 2,
      daysTotal: 7,
      phase: 'light',
      canPost: false,
      canInteract: true,
      maxInteractionsPerDay: 2,
    });

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(finalState.warmupPhase).toBe('light');
    expect(finalState.likesBudget).toBe(2);
    expect(finalState.commentsBudget).toBe(0);
  });

  it('EG-006: warmup moderate phase sets commentsBudget=1', async () => {
    warmupService = createMockWarmupService({
      accountId: 'acc-1',
      daysElapsed: 5,
      daysTotal: 7,
      phase: 'moderate',
      canPost: true,
      canInteract: true,
      maxInteractionsPerDay: 5,
    });

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(finalState.warmupPhase).toBe('moderate');
    expect(finalState.likesBudget).toBe(5);
    expect(finalState.commentsBudget).toBe(1);
  });

  it('EG-007: no warmup (null status) uses configured budgets', async () => {
    warmupService = createMockWarmupService(null);

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(finalState.warmupPhase).toBe('none');
    expect(finalState.likesBudget).toBe(15);
    expect(finalState.commentsBudget).toBe(4);
  });

  it('EG-008: graph passes warmup-adjusted budget to HumanBehaviorEngine', async () => {
    warmupService = createMockWarmupService({
      accountId: 'acc-1',
      daysElapsed: 0,
      daysTotal: 7,
      phase: 'browse-only',
      canPost: false,
      canInteract: false,
      maxInteractionsPerDay: 0,
    });

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    await compiled.invoke(initialState);

    // HumanBehaviorEngine should receive the warmup-adjusted budget
    expect(humanBehaviorEngine.processPosts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        likesMaxPerSession: 0, // browse-only → 0
        commentsMaxPerSession: 0,
      }),
    );
  });

  it('EG-009: graph records source label from TargetingService', async () => {
    targetingService = createMockTargetingService();
    (targetingService.pickSource as ReturnType<typeof vi.fn>).mockReturnValue({
      source: 'hashtag' as const,
      url: 'https://x.com/search?q=%23astrology',
      label: 'Hashtag #astrology',
    });

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(finalState.sourceLabel).toBe('Hashtag #astrology');
    expect(finalState.sourceUrl).toBe('https://x.com/search?q=%23astrology');
    expect(engager.scrollUrl).toHaveBeenCalledWith(
      expect.anything(),
      'https://x.com/search?q=%23astrology',
      expect.any(Number),
    );
  });

  it('EG-010: graph handles scroll_feed failure gracefully', async () => {
    engager = createMockEngager();
    (engager.scrollUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Browser crashed'));

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    // Graph should propagate the error
    await expect(compiled.invoke(initialState)).rejects.toThrow('Browser crashed');
  });

  it('EG-013: scroll_feed falls back to home feed when source returns empty', async () => {
    targetingService = createMockTargetingService();
    (targetingService.pickSource as ReturnType<typeof vi.fn>).mockReturnValue({
      source: 'hashtag' as const,
      url: 'https://x.com/search?q=%23astrology',
      label: 'Hashtag #astrology',
    });
    engager = createMockEngager();
    (engager.scrollUrl as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    expect(engager.scrollUrl).toHaveBeenCalledWith(
      expect.anything(),
      'https://x.com/search?q=%23astrology',
      expect.any(Number),
    );
    expect(engager.scrollFeed).toHaveBeenCalled();
    expect(finalState.sourceLabel).toBe('home-feed');
    expect(finalState.postUrls).toEqual(['url1', 'url2', 'url3']);
  });

  it('EG-011: graph works without warmupService (undefined)', async () => {
    const graph = buildEngagementGraph(engager, {
      targetingService,
      warmupService: undefined,
      humanBehaviorEngine,
    });
    const compiled = graph.compile();
    const initialState = createEngagementInitialState({
      network: SocialNetwork.X,
      accountId: 'acc-1',
      browsingSessionId: 'sess-1',
      durationSec: 30,
      maxPosts: 5,
      likesMaxPerSession: 15,
      commentsMaxPerSession: 4,
      page: {} as never,
    });

    const finalState = await compiled.invoke(initialState);

    // Should use configured budgets (no warmup gating)
    expect(finalState.warmupPhase).toBe('none');
    expect(finalState.likesBudget).toBe(15);
  });
});
