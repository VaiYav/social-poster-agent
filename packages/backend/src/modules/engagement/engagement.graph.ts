// EngagementGraph — LangGraph StateGraph for LLM-driven engagement behavior.
//
// This is a SEPARATE graph from GenerationGraph. It does NOT generate posts.
// Instead, it manages the engagement lifecycle for a browsing session:
//
//   START → check_warmup → pick_source → scroll_feed
//                                              ↓
//                                    decide_per_post (loop)
//                                              ↓
//                                         record → END
//
// Nodes:
//   1. check_warmup    — determine warmup phase, set interaction budget
//   2. pick_source     — choose targeting source (hashtag, competitor, feed)
//   3. scroll_feed     — scroll the feed and collect post URLs
//   4. decide_per_post — for each post: extract text → LLM decision → execute
//   5. record          — save results to DB, publish SSE events
//
// The graph is invoked by BrowsingSessionService (replacing the old
// Math.random() loop). Warmup gating happens inside the graph, not outside.

import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import type { Page } from '../../domain/ports/browser-primitives';
import { SocialNetwork } from '@prisma/client';
import { Logger } from '@nestjs/common';
import type { EngagementSource } from '../../domain/ports/engagement-decision.port.js';
import type { BaseEngager } from './engagers/base.engager.js';
import type { TargetingService } from './targeting.service.js';
import type { WarmupService, WarmupStatus } from '../sessions/warmup.service.js';
import type { HumanBehaviorEngine } from './human-behavior-engine.js';

const logger = new Logger('EngagementGraph');

// ============================================================
// Types
// ============================================================

/** Result of processing a single post. */
interface PostInteractionResult {
  postUrl: string;
  action: string;
  success: boolean;
  interactionId?: string;
  error?: string;
}

// ============================================================
// State — the data flowing through the engagement graph
// ============================================================

export const EngagementState = Annotation.Root({
  // Input — set by caller
  network: Annotation<SocialNetwork>,
  accountId: Annotation<string>,
  browsingSessionId: Annotation<string>,
  durationSec: Annotation<number>,
  sessionStartMs: Annotation<number>,
  maxPosts: Annotation<number>,
  likesMaxPerSession: Annotation<number>,
  commentsMaxPerSession: Annotation<number>,
  repostsMaxPerSession: Annotation<number>,
  quotesMaxPerSession: Annotation<number>,
  // Warmup — set by check_warmup node
  warmupStatus: Annotation<WarmupStatus | null>,
  warmupPhase: Annotation<string>,
  // Budget — adjusted by check_warmup based on warmup phase
  likesBudget: Annotation<number>,
  commentsBudget: Annotation<number>,
  repostsBudget: Annotation<number>,
  quotesBudget: Annotation<number>,
  // Targeting — set by pick_source node
  source: Annotation<EngagementSource>,
  sourceUrl: Annotation<string>,
  sourceLabel: Annotation<string>,
  // Scroll results — set by scroll_feed node
  postUrls: Annotation<string[]>,
  // Processing — accumulated by decide_per_post node
  results: Annotation<PostInteractionResult[]>({
    reducer: (old: PostInteractionResult[], update: PostInteractionResult[]) => [...old, ...update],
    default: () => [],
  }),
  likesThisSession: Annotation<number>,
  commentsThisSession: Annotation<number>,
  repostsThisSession: Annotation<number>,
  quotesThisSession: Annotation<number>,
  postsProcessed: Annotation<number>,
  // Error tracking
  error: Annotation<string | null>,
});

export type EngagementStateType = typeof EngagementState.State;

// ============================================================
// Nodes
// ============================================================

/**
 * Node 1: check_warmup — determine warmup phase and adjust interaction budget.
 *
 * If account is in warmup:
 *   - browse-only: likesBudget=0, commentsBudget=0 (just scroll)
 *   - light: likesBudget=2, commentsBudget=0 (likes only)
 *   - moderate: likesBudget=5, commentsBudget=1 (likes + 1 comment)
 *   - full: use configured budgets (no reduction)
 *
 * If account is NOT in warmup (warmupEnabled=false or completed):
 *   - use configured budgets as-is
 */
function makeCheckWarmupNode(warmupService?: WarmupService) {
  return async function checkWarmupNode(
    state: EngagementStateType,
  ): Promise<Partial<EngagementStateType>> {
    let warmupStatus: WarmupStatus | null = null;

    if (warmupService) {
      try {
        warmupStatus = await warmupService.getWarmupStatus(state.accountId);
      } catch (err) {
        logger.warn(`check_warmup: failed to get warmup status: ${(err as Error).message}`);
      }
    }

    if (warmupStatus) {
      const phase = warmupStatus.phase;
      logger.log(`Account ${state.accountId} in warmup phase '${phase}' — gating interactions`);

      // Adjust budgets based on warmup phase
      let likesBudget = state.likesMaxPerSession;
      let commentsBudget = state.commentsMaxPerSession;
      let repostsBudget = state.repostsMaxPerSession;
      let quotesBudget = state.quotesMaxPerSession;

      switch (phase) {
        case 'browse-only':
          likesBudget = 0;
          commentsBudget = 0;
          repostsBudget = 0;
          quotesBudget = 0;
          break;
        case 'light':
          likesBudget = Math.min(likesBudget, warmupStatus.maxInteractionsPerDay);
          commentsBudget = 0;
          repostsBudget = 0;
          quotesBudget = 0;
          break;
        case 'moderate':
          likesBudget = Math.min(likesBudget, warmupStatus.maxInteractionsPerDay);
          commentsBudget = Math.min(commentsBudget, 1);
          repostsBudget = 0;
          quotesBudget = 0;
          break;
        case 'full':
          // No reduction
          break;
      }

      return {
        warmupStatus,
        warmupPhase: phase,
        likesBudget,
        commentsBudget,
        repostsBudget,
        quotesBudget,
      };
    }

    // Not in warmup — use configured budgets
    return {
      warmupStatus: null,
      warmupPhase: 'none',
      likesBudget: state.likesMaxPerSession,
      commentsBudget: state.commentsMaxPerSession,
      repostsBudget: state.repostsMaxPerSession,
      quotesBudget: state.quotesMaxPerSession,
    };
  };
}

/**
 * Node 2: pick_source — choose a targeting source for this session.
 * Delegates to TargetingService for weighted random selection.
 */
function makePickSourceNode(targetingService: TargetingService) {
  return function pickSourceNode(
    state: EngagementStateType,
  ): Partial<EngagementStateType> {
    const target = targetingService.pickSource(state.network);
    logger.debug(`pick_source: ${target.label} for ${state.network}`);

    return {
      source: target.source,
      sourceUrl: target.url ?? '',
      sourceLabel: target.label,
    };
  };
}

/**
 * Node 3: scroll_feed — scroll the feed and collect post URLs.
 * Uses the engager's scrollFeed method (real browser scrolling).
 */
function makeScrollFeedNode(engager: BaseEngager) {
  return async function scrollFeedNode(
    state: EngagementStateWithPageType,
  ): Promise<Partial<EngagementStateWithPageType>> {
    if (!state.page) {
      return { error: 'No page available for scroll_feed', postUrls: [] };
    }
    // Respect the overall session budget: scroll can only consume time left in the session,
    // and we cap it at 1/3 of the total duration so the remaining 2/3 is available for
    // extracting + deciding + interacting with posts.
    const sessionDeadlineMs = state.sessionStartMs + state.durationSec * 1000;
    const remainingScrollSec = Math.max(0, Math.floor((sessionDeadlineMs - Date.now()) / 1000));
    const scrollSec = Math.min(remainingScrollSec, Math.max(60, Math.floor(state.durationSec / 3)));

    // Use the source URL selected by pick_source (hashtag, competitor, explore, etc.).
    // If empty, fall back to the default home feed. If the selected source returns
    // zero posts (e.g., X search is blocked or the page requires a login wall), also
    // fall back to the home feed so the session doesn't do nothing.
    let sourceUrl = state.sourceUrl?.trim();
    let postUrls: string[] = [];
    let sourceLabel = state.sourceLabel?.trim() || 'home-feed';

    if (sourceUrl) {
      postUrls = await engager.scrollUrl(state.page as Page, sourceUrl, scrollSec);
      if (postUrls.length === 0) {
        logger.warn(`scroll_feed: source ${sourceUrl} returned 0 posts for ${state.network} — falling back to home feed`);
        sourceUrl = '';
        sourceLabel = 'home-feed';
        postUrls = await engager.scrollFeed(state.page as Page, scrollSec);
      }
    } else {
      postUrls = await engager.scrollFeed(state.page as Page, scrollSec);
    }
    logger.debug(`scroll_feed: collected ${postUrls.length} posts for ${state.network} (scroll budget ${scrollSec}s, source: ${sourceLabel})`);

    return { postUrls, source: sourceUrl ? undefined : 'home-feed', sourceUrl, sourceLabel };
  };
}

// State with page — needed by scroll_feed and decide_per_post nodes
export const EngagementStateWithPage = Annotation.Root({
  ...EngagementState.spec,
  page: Annotation<Page | null>,
});

export type EngagementStateWithPageType = typeof EngagementStateWithPage.State;

/**
 * Node 4: decide_per_post — process each discovered post.
 *
 * Delegates to HumanBehaviorEngine.processPosts() which handles:
 *   - Post text extraction
 *   - LLM decision calls
 *   - Action execution (like, comment, read, scroll, open-thread, visit-profile)
 *   - DB interaction tracking (Interaction records with IN_PROGRESS → COMPLETED/FAILED)
 *   - Rate limit checks
 *   - SSE event publishing
 *
 * The graph passes the warmup-adjusted budget to HumanBehaviorEngine.
 * This node processes ALL posts in a single invocation.
 */
function makeDecidePerPostNode(
  engager: BaseEngager,
  humanBehaviorEngine: HumanBehaviorEngine,
) {
  return async function decidePerPostNode(
    state: EngagementStateWithPageType,
  ): Promise<Partial<EngagementStateWithPageType>> {
    if (!state.page) {
      return { error: 'No page available for engagement' };
    }

    // Delegate to HumanBehaviorEngine — it handles the full per-post loop:
    // extract → decide → execute → record to DB → rate limit → SSE
    const results = await humanBehaviorEngine.processPosts(
      state.page,
      state.postUrls,
      engager,
      {
        network: state.network,
        accountId: state.accountId,
        browsingSessionId: state.browsingSessionId,
        source: state.source,
        likesMaxPerSession: state.likesBudget,
        commentsMaxPerSession: state.commentsBudget,
        repostsMaxPerSession: state.repostsBudget,
        quotesMaxPerSession: state.quotesBudget,
        maxPosts: state.maxPosts,
        durationSec: state.durationSec,
        sessionStartMs: state.sessionStartMs,
      },
    );

    const likesThisSession = results.filter((r) => r.decision.action === 'like' && r.success).length;
    const commentsThisSession = results.filter((r) => r.decision.action === 'comment' && r.success).length;
    const repostsThisSession = results.filter((r) => r.decision.action === 'repost' && r.success).length;
    const quotesThisSession = results.filter((r) => r.decision.action === 'quote' && r.success).length;

    // Convert to graph state format
    const graphResults: PostInteractionResult[] = results.map((r) => ({
      postUrl: r.postUrl,
      action: r.decision.action,
      success: r.success,
      interactionId: r.interactionId,
      error: r.error,
    }));

    return {
      results: graphResults,
      likesThisSession,
      commentsThisSession,
      repostsThisSession,
      quotesThisSession,
      postsProcessed: results.length,
    };
  };
}

/**
 * Node 5: record — finalize results, publish SSE events.
 * Actual DB updates happen in BrowsingSessionService after graph completes.
 * This node just formats the final state.
 */
function recordNode(state: EngagementStateType): Partial<EngagementStateType> {
  const successCount = state.results.filter((r) => r.success).length;
  const likeCount = state.results.filter((r) => r.action === 'like' && r.success).length;
  const commentCount = state.results.filter((r) => r.action === 'comment' && r.success).length;
  const repostCount = state.results.filter((r) => r.action === 'repost' && r.success).length;
  const quoteCount = state.results.filter((r) => r.action === 'quote' && r.success).length;

  logger.log(
    `record: ${state.results.length} posts processed, ${successCount} successful, ` +
      `${likeCount} likes, ${commentCount} comments, ${repostCount} reposts, ${quoteCount} quotes ` +
      `(warmup: ${state.warmupPhase})`,
  );

  return {};
}

// ============================================================
// Graph builder
// ============================================================

export interface EngagementGraphDeps {
  targetingService: TargetingService;
  warmupService?: WarmupService;
  humanBehaviorEngine: HumanBehaviorEngine;
}

/**
 * Build the EngagementGraph.
 *
 * Flow:
 *   START → check_warmup → pick_source → scroll_feed → decide_per_post → record → END
 *
 * The graph is invoked once per browsing session. All post processing
 * happens inside the decide_per_post node (which delegates to
 * HumanBehaviorEngine for the per-post LLM decision loop + DB tracking).
 */
export function buildEngagementGraph(
  engager: BaseEngager,
  deps: EngagementGraphDeps,
) {
  const graph = new StateGraph(EngagementStateWithPage)
    .addNode('check_warmup', makeCheckWarmupNode(deps.warmupService))
    .addNode('pick_source', makePickSourceNode(deps.targetingService))
    .addNode('scroll_feed', makeScrollFeedNode(engager))
    .addNode('decide_per_post', makeDecidePerPostNode(engager, deps.humanBehaviorEngine))
    .addNode('record', recordNode)
    .addEdge(START, 'check_warmup')
    .addEdge('check_warmup', 'pick_source')
    .addEdge('pick_source', 'scroll_feed')
    .addEdge('scroll_feed', 'decide_per_post')
    .addEdge('decide_per_post', 'record')
    .addEdge('record', END);

  return graph;
}

/**
 * Create initial state for an engagement graph invocation.
 */
export function createEngagementInitialState(opts: {
  network: SocialNetwork;
  accountId: string;
  browsingSessionId: string;
  durationSec: number;
  maxPosts: number;
  likesMaxPerSession: number;
  commentsMaxPerSession: number;
  repostsMaxPerSession: number;
  quotesMaxPerSession: number;
  page: Page | null;
}): EngagementStateWithPageType {
  return {
    network: opts.network,
    accountId: opts.accountId,
    browsingSessionId: opts.browsingSessionId,
    durationSec: opts.durationSec,
    sessionStartMs: Date.now(),
    maxPosts: opts.maxPosts,
    likesMaxPerSession: opts.likesMaxPerSession,
    commentsMaxPerSession: opts.commentsMaxPerSession,
    repostsMaxPerSession: opts.repostsMaxPerSession,
    quotesMaxPerSession: opts.quotesMaxPerSession,
    warmupStatus: null,
    warmupPhase: 'none',
    likesBudget: opts.likesMaxPerSession,
    commentsBudget: opts.commentsMaxPerSession,
    repostsBudget: opts.repostsMaxPerSession,
    quotesBudget: opts.quotesMaxPerSession,
    source: 'home-feed',
    sourceUrl: '',
    sourceLabel: '',
    postUrls: [],
    results: [],
    likesThisSession: 0,
    commentsThisSession: 0,
    repostsThisSession: 0,
    quotesThisSession: 0,
    postsProcessed: 0,
    error: null,
    page: opts.page,
  };
}
