import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { ContentSourceService } from '../content-source/content-source.service';
import { AccountsService } from '../accounts/accounts.service';
import { PostsService } from '../posts/posts.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import { RedisCheckpointSaver } from '../../infrastructure/checkpoint/redis-checkpoint.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { TrendingService } from '../trending/trending.service.js';
import { TrendingScraperService } from '../trending/trending-scraper.service.js';
import {
  SocialNetwork,
  GenerationRunStatus,
  GenerationTrigger,
  PostStatus,
} from '@prisma/client';
import type { ContentTopic } from '@spa/shared';
import { buildGenerationGraph, createInitialState, type GeneratedPost, type ProgressPublisher } from './generation.graph.js';
import { Command } from '@langchain/langgraph';
import { simhash, hammingDistance } from './simhash.js';
import { prioritizeTopics as prioritizeTopicsByFreshness } from './topic-prioritization.js';
import { checkTrendSafety } from '../content-enhancements/trend-guardrail.js';
import {
  ContentPillarTracker,
  classifyPillar,
  type ContentPillar,
} from '../content-enhancements/content-pillar.tracker.js';
import { HookPerformanceBank } from '../content-enhancements/hook-performance-bank.js';
import { VisualConceptService } from '../content-enhancements/visual-concept.service.js';
import { ThreadDepthController } from '../content-enhancements/thread-depth.controller.js';
import { ABVariantGenerator } from '../content-enhancements/ab-variant.generator.js';

/**
 * Generation service — uses LangGraph workflow for creating social post drafts.
 *
 * Flow (§10.3 parallel per-network graph):
 *   START → research_extract → hook_generation → angle_per_network
 *     → [draft_x || draft_threads || draft_facebook]  (parallel)
 *     → [critique_x || critique_threads || critique_facebook]  (parallel)
 *     → [refine_x || refine_threads || refine_facebook]  (parallel)
 *     → save_to_db → END
 *
 * One graph invocation per topic generates posts for ALL target networks.
 * Each network gets a DIFFERENT hook + angle (OQ-16: per-network angle = разный контент).
 *
 * Checkpoint: RedisCheckpointSaver persists state after each node.
 *   thread_id = generationRunId (enables resume after crash — B6 mitigation).
 *
 * Saves drafts as Post (status=DRAFT). Operator reviews in UI before posting.
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);
  private brandVoice: string | null = null;
  private compiledGraph: ReturnType<ReturnType<typeof buildGenerationGraph>['compile']> | null = null;
  /** Active run cancellations — runId → AbortController */
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly contentSourceService: ContentSourceService,
    private readonly accountsService: AccountsService,
    private readonly postsService: PostsService,
    private readonly prisma: PrismaService,
    private readonly checkpointSaver: RedisCheckpointSaver,
    private readonly sseService: SseService,
    @Optional() private readonly trendingService?: TrendingService,
    @Optional() private readonly trendingScraper?: TrendingScraperService,
    @Optional() private readonly pillarTracker?: ContentPillarTracker,
    @Optional() private readonly hookBank?: HookPerformanceBank,
    @Optional() private readonly visualService?: VisualConceptService,
    @Optional() private readonly threadDepthController?: ThreadDepthController,
    @Optional() private readonly abGenerator?: ABVariantGenerator,
  ) {}

  /**
   * Lazy-compile the graph with the checkpoint saver and SSE progress publisher.
   * Done on first use (not constructor) to ensure Redis is connected.
   */
  private getGraph() {
    if (!this.compiledGraph) {
      const progressPublisher: ProgressPublisher = (event) => {
        this.sseService.publish({
          type: 'generation_progress',
          node: event.node,
          topic: event.topic,
          postsCount: event.postsCount,
          error: event.error ?? undefined,
        });
      };
      const graphBuilder = buildGenerationGraph(this.llm, progressPublisher, this.hookBank, this.visualService, this.abGenerator);
      this.compiledGraph = graphBuilder.compile({ checkpointer: this.checkpointSaver });
      this.logger.log('LangGraph workflow compiled with Redis checkpoint saver + SSE progress (§10.3 parallel graph)');
    }
    return this.compiledGraph;
  }

  /**
   * Run generation: get topics → generate posts per topic (all networks in parallel) → save drafts.
   *
   * @param count Number of topics to generate posts for (each topic → 3 posts, one per network)
   * @param networks Optional subset of networks (default: all 3)
   * @param triggeredBy Trigger source (manual/cron)
   * @param multiStage F2: if true, generate hook + continuation posts linked as a thread
   * @returns generation run ID
   */
  async generate(
    count = 3,
    networks?: SocialNetwork[],
    triggeredBy: GenerationTrigger = GenerationTrigger.MANUAL,
    multiStage = false,
    humanReview = false,
  ): Promise<string> {
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy, sourceTopics: [] },
    });

    // Sprint I: SSE generation_started event
    await this.sseService.publish({ type: 'generation_started', runId: run.id, count });

    try {
      let topics = await this.contentSourceService.getTopics(count);

      // Sprint P / F22: Enrich topics with trending topics (Google Trends + X + astro)
      // Trending topics are ADDED ON TOP of content-source topics (not replacing them).
      // This way, if the trend guardrail rejects trending topics, we still have
      // the full set of content-source topics to fall back on.
      // Graceful degradation — if scraping fails, generation continues with
      // content-source topics only.
      if (this.trendingScraper) {
        try {
          const trendingTopics = await this.fetchTrendingAsContentTopics(count);
          if (trendingTopics.length > 0) {
            // Add trending topics on top of content-source topics.
            // The guardrail (P5) will filter out unsafe trending topics,
            // and the prioritization step (B5) will trim to `count`.
            // Target mix: ~60% content, ~40% trending — but content topics
            // are never reduced to make room for trending.
            const trendingCount = Math.min(
              Math.ceil(count * 0.4),
              trendingTopics.length,
            );
            const trendSlice = trendingTopics.slice(0, trendingCount);
            topics = [...topics, ...trendSlice];
            this.logger.log(
              `F22: Enriched with ${trendSlice.length} trending topics (Google Trends + X) — total ${topics.length} topics (content ${topics.length - trendSlice.length} + trending ${trendSlice.length})`,
            );
          }
        } catch (trendErr) {
          // Graceful degradation — continue with content-source topics only
          this.logger.warn(
            `F22: Trending enrichment failed (non-blocking): ${(trendErr as Error).message}`,
          );
        }
      }

      if (topics.length === 0) {
        this.logger.warn('No topics found from content sources');
        await this.markRunCompleted(run.id, [], 'No topics found');
        return run.id;
      }

      // P5: Trend-Jacking Guardrail — filter trending topics through a
      // two-layer safety check (deterministic blocklist + LLM opportunity
      // scoring). Non-trending sources (briefs, articles, create_runs) bypass
      // the guardrail — they are already brand-safe (CAP-vetted).
      // Trending topics that fail the guardrail are removed; content-source
      // topics pass through unchanged, so rejected trending slots are
      // automatically backfilled by the remaining content topics.
      const safeTopics = await this.filterTrendingTopics(topics);
      if (safeTopics.length === 0) {
        this.logger.warn('P5: All topics rejected by trend guardrail — no topics to generate');
        await this.markRunCompleted(run.id, [], 'All topics rejected by trend guardrail');
        return run.id;
      }
      topics = safeTopics;

      // P6: Content Pillar Rotation — get a recommendation for which pillar
      // to prioritize. The recommended pillar is injected into each topic's
      // keywords so the generation graph steers the LLM toward the
      // underrepresented pillar. Graceful degradation: if the tracker is
      // unavailable (Redis down), generation continues without steering.
      let pillarHint = '';
      if (this.pillarTracker) {
        try {
          const rec = await this.pillarTracker.recommendPillar();
          pillarHint = rec.recommended;
          this.logger.log(`P6: Recommending pillar "${pillarHint}" — ${rec.reason}`);
        } catch (err) {
          this.logger.warn(`P6: Pillar recommendation failed (non-blocking): ${(err as Error).message}`);
        }
      }
      if (pillarHint) {
        // Inject the pillar hint as the first keyword for each topic
        topics = topics.map((t) => ({
          ...t,
          keywords: [`pillar:${pillarHint}`, ...t.keywords],
        }));
      }

      // B5: Category diversity + freshness priority
      // 1. Sort by publishedAt descending (freshest first)
      // 2. Rotate categories — no two consecutive topics from same category
      const prioritizedTopics = this.prioritizeTopics(topics, count);

      const targetNetworks = networks ?? [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
      const brandVoice = await this.loadBrandVoice();

      // Sprint L: Parallel topic generation — up to 3 topics in parallel
      // (limited to avoid overwhelming LLM providers with too many concurrent calls)
      const MAX_CONCURRENCY = 3;
      const postIds: string[] = [];

      // Process topics in batches of MAX_CONCURRENCY
      for (let i = 0; i < prioritizedTopics.length; i += MAX_CONCURRENCY) {
        const batch = prioritizedTopics.slice(i, i + MAX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((topic) =>
            this.generatePostsForTopic(topic, targetNetworks, brandVoice, run.id, multiStage, humanReview),
          ),
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            postIds.push(...result.value.map((p) => p.id));
          } else {
            this.logger.error(
              `Failed to generate posts for topic: ${(result.reason as Error)?.message ?? 'unknown'}`,
            );
          }
        }
      }

      await this.markRunCompleted(run.id, prioritizedTopics.map((t) => t.topic));
      this.logger.log(`Generation run ${run.id}: ${postIds.length} drafts created`);
      // Sprint I: SSE generation_completed event
      await this.sseService.publish({ type: 'generation_completed', runId: run.id, postCount: postIds.length });
      return run.id;
    } catch (err) {
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.FAILED,
          completedAt: new Date(),
          errorMessage: (err as Error).message,
        },
      });
      // Sprint I: SSE generation_failed event
      await this.sseService.publish({ type: 'generation_failed', runId: run.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * F10: Content Repurposing — deep fact extraction from articles.
   * Each article → multiple posts (one per fact), maximizing content ROI.
   * One article with 5 facts × 3 networks = up to 15 posts from a single source.
   *
   * @param articleCount Number of articles to repurpose
   * @param networks Optional subset of networks (default: all 3)
   * @param triggeredBy Trigger source
   * @returns generation run ID
   */
  async repurposeFromArticles(
    articleCount = 2,
    networks?: SocialNetwork[],
    triggeredBy: GenerationTrigger = GenerationTrigger.MANUAL,
  ): Promise<string> {
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy, sourceTopics: [] },
    });

    try {
      // Get articles only (not briefs/topics) — they have facts
      const allTopics = await this.contentSourceService.getTopics(articleCount * 3);
      const articles = allTopics
        .filter((t) => t.sourceType === 'article' && t.facts.length > 0)
        .slice(0, articleCount);

      if (articles.length === 0) {
        this.logger.warn('F10: No articles with facts found for repurposing');
        await this.markRunCompleted(run.id, [], 'No articles with facts found');
        return run.id;
      }

      const targetNetworks = networks ?? [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
      const brandVoice = await this.loadBrandVoice();
      const postIds: string[] = [];
      const sourceTopics: string[] = [];

      for (const article of articles) {
        sourceTopics.push(article.topic);
        this.logger.log(`F10: Repurposing "${article.topic}" — ${article.facts.length} facts extracted`);

        for (let factIdx = 0; factIdx < article.facts.length; factIdx++) {
          const fact = article.facts[factIdx]!;
          try {
            // Create a synthetic topic from each fact
            const factTopic: ContentTopic = {
              ...article,
              topic: `${article.topic} — Fact ${factIdx + 1}`,
              facts: [fact],
            };
            const posts = await this.generatePostsForTopic(factTopic, targetNetworks, brandVoice, run.id, false);
            // Tag posts with fact_index in sourceRef
            for (const post of posts) {
              await this.prisma.post.update({
                where: { id: post.id },
                data: {
                  sourceRef: {
                    type: 'article',
                    path: article.path,
                    topic: article.topic,
                    factIndex: factIdx,
                  },
                },
              });
            }
            postIds.push(...posts.map((p) => p.id));
          } catch (err) {
            this.logger.error(`F10: Failed to generate post for fact ${factIdx + 1} of "${article.topic}": ${(err as Error).message}`);
          }
        }
      }

      await this.markRunCompleted(run.id, sourceTopics);
      this.logger.log(`F10: Generation run ${run.id}: ${postIds.length} posts from ${articles.length} articles`);
      return run.id;
    } catch (err) {
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.FAILED,
          completedAt: new Date(),
          errorMessage: (err as Error).message,
        },
      });
      throw err;
    }
  }

  /**
   * F13: Content Recycling — find old top posts and regenerate with a fresh angle.
   * Evergreen revival: takes posts that were successfully posted (POSTED status),
   * extracts their topic, and generates new posts with a different angle.
   *
   * @param minAgeDays Minimum age of posts to consider (default: 30 days)
   * @param postCount Number of old posts to recycle (default: 3)
   * @param networks Optional subset of networks (default: all 3)
   * @param triggeredBy Trigger source
   * @returns generation run ID
   */
  async recycleTopPosts(
    minAgeDays = 30,
    postCount = 3,
    networks?: SocialNetwork[],
    triggeredBy: GenerationTrigger = GenerationTrigger.MANUAL,
  ): Promise<string> {
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy, sourceTopics: [] },
    });

    try {
      // Find old POSTED posts — these are "top posts" (successfully posted)
      const minAge = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);
      const oldPosts = await this.prisma.post.findMany({
        where: {
          status: PostStatus.POSTED,
          createdAt: { lte: minAge },
        },
        select: {
          id: true,
          content: true,
          network: true,
          sourceRef: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: postCount * 3, // Get more than needed — dedup by topic
      });

      if (oldPosts.length === 0) {
        this.logger.warn(`F13: No posted posts older than ${minAgeDays} days found for recycling`);
        await this.markRunCompleted(run.id, [], 'No old posts found for recycling');
        return run.id;
      }

      // Deduplicate by sourceRef topic — only recycle each topic once
      const seenTopics = new Set<string>();
      const uniquePosts = oldPosts.filter((p) => {
        const topic = p.sourceRef && typeof p.sourceRef === 'object' && 'topic' in p.sourceRef
          ? String((p.sourceRef as Record<string, unknown>).topic)
          : p.content.slice(0, 80);
        if (seenTopics.has(topic)) return false;
        seenTopics.add(topic);
        return true;
      }).slice(0, postCount);

      if (uniquePosts.length === 0) {
        this.logger.warn('F13: All old posts are duplicates — nothing to recycle');
        await this.markRunCompleted(run.id, [], 'All old posts already recycled');
        return run.id;
      }

      const targetNetworks = networks ?? [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
      const brandVoice = await this.loadBrandVoice();
      const postIds: string[] = [];
      const sourceTopics: string[] = [];

      for (const oldPost of uniquePosts) {
        // Extract topic from sourceRef or content
        const topicStr = oldPost.sourceRef && typeof oldPost.sourceRef === 'object' && 'topic' in oldPost.sourceRef
          ? String((oldPost.sourceRef as Record<string, unknown>).topic)
          : oldPost.content.slice(0, 80);

        sourceTopics.push(topicStr);
        this.logger.log(`F13: Recycling "${topicStr}" (original post: ${oldPost.id}, age: ${Math.round((Date.now() - oldPost.createdAt.getTime()) / (1000 * 60 * 60 * 24))} days)`);

        try {
          // Create a synthetic topic for regeneration with "evergreen" angle
          const recycledTopic: ContentTopic = {
            sourceType: 'topic',
            path: `recycle://${oldPost.id}`,
            topic: `${topicStr} (evergreen revival)`,
            keywords: [],
            facts: [],
            category: 'evergreen',
            publishedAt: new Date(),
          };

          const posts = await this.generatePostsForTopic(recycledTopic, targetNetworks, brandVoice, run.id, false);

          // Tag posts with recycle metadata
          for (const post of posts) {
            await this.prisma.post.update({
              where: { id: post.id },
              data: {
                sourceRef: {
                  type: 'recycle',
                  originalPostId: oldPost.id,
                  originalTopic: topicStr,
                  recycledAt: new Date().toISOString(),
                },
              },
            });
          }
          postIds.push(...posts.map((p) => p.id));
        } catch (err) {
          this.logger.error(`F13: Failed to recycle post ${oldPost.id} ("${topicStr}"): ${(err as Error).message}`);
        }
      }

      await this.markRunCompleted(run.id, sourceTopics);
      this.logger.log(`F13: Generation run ${run.id}: ${postIds.length} recycled posts from ${uniquePosts.length} old posts`);
      return run.id;
    } catch (err) {
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.FAILED,
          completedAt: new Date(),
          errorMessage: (err as Error).message,
        },
      });
      throw err;
    }
  }

  /**
   * Generate posts for a single topic across all target networks.
   * Uses the §10.3 parallel LangGraph workflow — one invocation, 3 posts.
   */
  private async generatePostsForTopic(
    topic: ContentTopic,
    targetNetworks: SocialNetwork[],
    brandVoice: string,
    runId: string,
    multiStage = false,
    humanReview = false,
  ): Promise<{ id: string }[]> {
    // Check which networks have active accounts
    const activeNetworks: SocialNetwork[] = [];
    for (const network of targetNetworks) {
      const account = await this.accountsService.findByNetwork(network);
      if (account) {
        // Dedup — skip if we already posted about this source recently for this network
        const recent = await this.postsService.findBySourceAndNetwork(topic.path, network);
        if (recent.length === 0) {
          activeNetworks.push(network);
        } else {
          this.logger.debug(`Skipping ${network} — already posted about ${topic.path}`);
        }
      } else {
        this.logger.warn(`No active account for ${network}`);
      }
    }

    if (activeNetworks.length === 0) {
      this.logger.debug(`No active networks for topic "${topic.topic}" — skipping`);
      return [];
    }

    // Build initial state — graph will fan out to all active networks
    const initialState = createInitialState(topic, activeNetworks, brandVoice, humanReview);

    // Invoke the LangGraph workflow with checkpoint
    // thread_id = runId:topic enables resume after crash (B6 mitigation)
    const config = {
      configurable: { thread_id: `${runId}:${topic.topic}` },
      recursionLimit: 40, // P3+P7 added 6 more nodes (visual_concept + ab_variant per network)
    };

    this.logger.debug(
      `Invoking LangGraph for "${topic.topic}" → ${activeNetworks.join(', ')} (thread: ${config.configurable.thread_id})`,
    );

    const finalState = await this.getGraph().invoke(initialState, config);
    const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];
    // P4: Extract facts from final state for thread depth planning
    const finalFacts = (finalState as { facts?: string[] }).facts ?? [];

    // Save each generated post as DRAFT
    // B5: SimHash dedup — skip near-duplicate posts (Hamming distance ≤ 3)
    const savedPosts: { id: string }[] = [];

    // Load recent post hashes for this network to check against
    const recentHashes = await this.loadRecentPostHashes(topic.topic);

    for (const genPost of generatedPosts) {
      if (!genPost.content) {
        this.logger.warn(`Graph produced empty content for ${genPost.network} / "${topic.topic}"`);
        continue;
      }

      // B5: SimHash dedup check
      const candidateHash = simhash(genPost.content);
      const isDup = recentHashes.some(
        (existing) => hammingDistance(candidateHash, existing) <= 3,
      );

      if (isDup) {
        this.logger.warn(
          `Skipping near-duplicate post for ${genPost.network} / "${topic.topic}" — SimHash match`,
        );
        continue;
      }

      const account = await this.accountsService.findByNetwork(genPost.network);
      if (!account) continue;

      const post = await this.postsService.create({
        accountId: account.id,
        network: genPost.network,
        content: genPost.content,
        generationRunId: runId,
        simhash: candidateHash, // Sprint L: dedicated field for fast dedup
        sourceRef: {
          type: topic.sourceType,
          path: topic.path,
          topic: topic.topic,
        },
        llmMetadata: {
          model: genPost.model,
          promptVersion: this.llm.getPromptVersion?.() ?? '0.3.0', // Sprint J: from LlmService
          hook: genPost.hook,
          hookTechnique: genPost.hookTechnique, // P1: for performance tracking
          contentStyleId: genPost.contentStyleId, // Anti-AI-detection style rotation
          angleType: genPost.angle.split('—')[0]?.trim(),
          simhash: candidateHash, // B5: store hash for future dedup
          qualityScore: genPost.qualityScore, // Sprint Q: LLM quality score (1-10)
          visualConcept: genPost.visualConcept ?? null, // P3: image concept for poster
          abVariants: genPost.abVariants ?? null, // P7: A/B emoji/hashtag variants
        } as Prisma.InputJsonValue,
      });

      savedPosts.push(post);
      recentHashes.push(candidateHash); // add to in-memory set for this run
      this.logger.debug(
        `Created draft post for ${genPost.network} (score: ${genPost.qualityScore ?? 'n/a'}/10): ${genPost.content.slice(0, 50)}...`,
      );

      // P6: Record this post against its content pillar for rotation tracking.
      // Graceful degradation: if the tracker is unavailable, skip recording.
      if (this.pillarTracker) {
        try {
          // P6: Strip the injected `pillar:<name>` hint from keywords before
          // classification — the hint is steering for the LLM, not a real
          // keyword. Without this, classifyPillar() sees `pillar:educational`
          // and falls through to the default (daily_weather), recording the
          // wrong pillar for every steered post.
          const cleanKeywords = topic.keywords.filter((k) => !k.startsWith('pillar:'));
          const pillar: ContentPillar = classifyPillar(topic.topic, cleanKeywords);
          await this.pillarTracker.recordPillar(pillar);
        } catch (err) {
          this.logger.debug(`P6: Pillar recording failed (non-blocking): ${(err as Error).message}`);
        }
      }

      // F2/P4: Multi-Stage Posting with Thread Depth Controller.
      // P4 replaces the fixed 2-post F2 with configurable thread depth (1-5).
      // When ThreadDepthController is available, it decides depth based on
      // content richness, network, and pillar. Falls back to fixed F2 when
      // the controller is unavailable (backward compatibility).
      if (multiStage && (genPost.network === SocialNetwork.X || genPost.network === SocialNetwork.THREADS)) {
        if (this.threadDepthController) {
          // P4: Configurable thread depth
          try {
            const plan = await this.threadDepthController.planThread(
              genPost.network,
              genPost.content,
              finalFacts,
              topic.topic,
              topic.keywords,
            );
            if (plan.depth > 1 && plan.continuations.length > 0) {
              // A4: thread assembly (thread row + root link + continuations) is
              // atomic — a mid-assembly crash must not leave an orphan PostThread
              // or a thread with position gaps. planThread() (LLM) already ran
              // above, so only fast DB writes live inside the transaction.
              const contPosts = await this.prisma.$transaction(async (tx) => {
                const thread = await tx.postThread.create({
                  data: { accountId: account.id, status: PostStatus.DRAFT },
                });
                // Link root post to thread
                await tx.post.update({
                  where: { id: post.id },
                  data: { threadId: thread.id, threadPosition: 0 },
                });
                // Create continuation posts (same tx client → all-or-nothing)
                const created: { id: string }[] = [];
                for (const cont of plan.continuations) {
                  created.push(
                    await this.postsService.create(
                      {
                        accountId: account.id,
                        network: genPost.network,
                        content: cont.content,
                        threadId: thread.id,
                        threadPosition: cont.position,
                        generationRunId: runId,
                        sourceRef: {
                          type: topic.sourceType,
                          path: topic.path,
                          topic: topic.topic,
                        },
                        llmMetadata: {
                          model: genPost.model,
                          promptVersion: '0.3.0-p4',
                          hook: genPost.hook,
                          angleType: 'continuation',
                          simhash: simhash(cont.content),
                          multiStage: true,
                          threadDepth: plan.depth,
                        },
                      },
                      tx,
                    ),
                  );
                }
                this.logger.debug(
                  `P4: Created ${plan.continuations.length} continuation posts for ${genPost.network} thread ${thread.id} — ${plan.reasoning}`,
                );
                return created;
              });
              savedPosts.push(...contPosts);
            }
          } catch (err) {
            this.logger.warn(`P4: Thread planning failed, falling back to F2: ${(err as Error).message}`);
            await this.fallbackF2Continuation(genPost, post, account, topic, runId, savedPosts);
          }
        } else {
          // F2 fallback: fixed 2-post thread (backward compatibility)
          await this.fallbackF2Continuation(genPost, post, account, topic, runId, savedPosts);
        }
      }
    }

    return savedPosts;
  }

  /**
   * F2 fallback: fixed 2-post thread (backward compatibility when P4 is unavailable).
   * Extracted from the original F2 inline block.
   */
  private async fallbackF2Continuation(
    genPost: GeneratedPost,
    post: { id: string },
    account: { id: string },
    topic: ContentTopic,
    runId: string,
    savedPosts: { id: string }[],
  ): Promise<void> {
    // LLM continuation generation runs OUTSIDE the transaction (slow call must
    // not hold a DB tx open). A4: the thread + root link + continuation write
    // are then committed atomically.
    const continuationContent = await this.generateContinuationContent(genPost.hook, genPost.content, topic.topic);
    const continuationPost = await this.prisma.$transaction(async (tx) => {
      const thread = await tx.postThread.create({
        data: { accountId: account.id, status: PostStatus.DRAFT },
      });
      await tx.post.update({ where: { id: post.id }, data: { threadId: thread.id, threadPosition: 0 } });
      const created = await this.postsService.create(
        {
          accountId: account.id,
          network: genPost.network,
          content: continuationContent,
          threadId: thread.id,
          threadPosition: 1,
          generationRunId: runId,
          sourceRef: {
            type: topic.sourceType,
            path: topic.path,
            topic: topic.topic,
          },
          llmMetadata: {
            model: genPost.model,
            promptVersion: '0.3.0-f2',
            hook: genPost.hook,
            angleType: 'continuation',
            simhash: simhash(continuationContent),
            multiStage: true,
          },
        },
        tx,
      );
      this.logger.debug(`F2: Created continuation post for ${genPost.network} thread ${thread.id}`);
      return created;
    });
    savedPosts.push(continuationPost);
  }

  /**
   * F2: Generate continuation content for the second post in a multi-stage thread.
   * Uses LLM to create a natural follow-up that references the root post.
   * Falls back to a heuristic if the LLM call fails.
   */
  private async generateContinuationContent(hook: string, rootContent: string, topic: string): Promise<string> {
    try {
      const systemPrompt = `You are a social media writer for My Zodiac AI, an astrology platform.
Write a short follow-up post (under 280 chars) that continues the conversation from the root post.
Do NOT use "link in bio" — instead tease more content or ask an engaging question.
Keep it mystical-but-grounded, accessible, empowering. No fear-mongering.
Return ONLY the post text, no preamble.`;

      const userPrompt = `Topic: ${topic}
Root post hook: ${hook}
Root post content: ${rootContent}

Write a follow-up post that adds a new angle or asks an engaging question:`;

      const response = await this.llm.generateChat(systemPrompt, userPrompt, { temperature: 0.8 });
      const content = response.content.trim();
      if (content.length > 0 && content.length <= 280) {
        return content;
      }
      // If too long, truncate at last sentence boundary
      if (content.length > 280) {
        const truncated = content.slice(0, 277);
        const lastPeriod = truncated.lastIndexOf('.');
        return truncated.slice(0, lastPeriod > 100 ? lastPeriod + 1 : 277) + '…';
      }
      // Empty response — fall through to heuristic
    } catch (err) {
      this.logger.warn(`F2 continuation LLM call failed: ${(err as Error).message} — using heuristic`);
    }

    // Heuristic fallback — no links in posts (text-only per brand voice).
    // P9 compliance: no engagement bait ("share below", "comment", "tag").
    // Close with a value-first CTA (no URL).
    const rootSentence = rootContent.split('.')[0]?.trim() ?? hook;
    return `${rootSentence}.\n\nWhat's your take on ${topic.toLowerCase()}? ✨`;
  }

  private async loadBrandVoice(): Promise<string> {
    if (this.brandVoice) return this.brandVoice;
    try {
      // D5 fix: resolve from project root, works in both dev (ts) and prod (compiled)
      const brandVoicePath = join(process.cwd(), 'brand-voice.md');
      this.brandVoice = await readFile(brandVoicePath, 'utf-8');
      return this.brandVoice;
    } catch {
      this.logger.warn('brand-voice.md not found — using minimal guidelines');
      this.brandVoice = 'Mystical-but-grounded, accessible, empowering. No fear-mongering.';
      return this.brandVoice;
    }
  }

  /**
   * B5: Category diversity + freshness priority.
   *
   * Sorts topics by publishedAt (freshest first), then rotates categories
   * so no two consecutive topics share the same category.
   * Topics without a category are treated as 'uncategorized'.
   * Topics without a publishedAt are sorted last (stable).
   */
  /**
   * Sprint P / F22: Fetch trending topics (Google Trends + X + astro) and
   * convert them to ContentTopic format so they can be used by the generation
   * graph alongside content-source topics.
   *
   * Returns an empty array when trending scraping is disabled or fails.
   */
  private async fetchTrendingAsContentTopics(limit: number): Promise<ContentTopic[]> {
    if (!this.trendingScraper) return [];

    // Get astro trending topics from TrendingService (if available)
    const astroTopics: Array<{ topic: string; networks: string[] }> = [];
    if (this.trendingService) {
      try {
        const trending = this.trendingService.getTrendingTopics();
        for (const t of trending) {
          if (t.trending) {
            astroTopics.push({ topic: t.topic, networks: t.networks });
          }
        }
      } catch {
        // Astro trending is optional
      }
    }

    // Get merged trending (astro + Google Trends + X)
    const merged = await this.trendingScraper.getMergedTrending(astroTopics);

    // Convert to ContentTopic format
    return merged.slice(0, limit).map((t) => ({
      sourceType: 'topic' as const,
      path: `trending/${t.sources.join('+')}`,
      topic: t.topic,
      keywords: t.sources, // use sources as keywords for LLM context
      facts: [],
      category: 'trending',
      publishedAt: t.scrapedAt ?? new Date(),
    }));
  }

  private prioritizeTopics(topics: ContentTopic[], count: number): ContentTopic[] {
    // A6: pure sort + round-robin lives in topic-prioritization.ts; the wrapper
    // keeps the B5 debug log.
    const result = prioritizeTopicsByFreshness(topics, count);
    this.logger.debug(
      `B5: Prioritized ${result.length}/${topics.length} topics — ` +
        `categories: ${result.map((t) => t.category ?? 'uncategorized').join(', ')}`,
    );
    return result;
  }

  /**
   * P5: Filter trending topics through the trend-jacking guardrail.
   *
   * Non-trending topics (briefs, articles, create_runs) pass through unchanged.
   * Trending topics are checked via `checkTrendSafety()` — those that fail are
   * removed and logged. When a trending topic passes with a suggested angle,
   * the angle is injected into the topic's keywords so the generation graph
   * can use it.
   *
   * Runs LLM checks in parallel (up to 3 concurrent) to avoid serial latency.
   */
  private async filterTrendingTopics(topics: ContentTopic[]): Promise<ContentTopic[]> {
    const nonTrending = topics.filter(
      (t) => t.sourceType !== 'topic' || !t.path.startsWith('trending/'),
    );
    const trending = topics.filter(
      (t) => t.sourceType === 'topic' && t.path.startsWith('trending/'),
    );

    if (trending.length === 0) {
      return nonTrending;
    }

    this.logger.debug(`P5: Checking ${trending.length} trending topics through guardrail`);

    // Check trending topics in parallel (limit concurrency to 3)
    const MAX_CONCURRENT = 3;
    const results: ContentTopic[] = [];
    for (let i = 0; i < trending.length; i += MAX_CONCURRENT) {
      const batch = trending.slice(i, i + MAX_CONCURRENT);
      const checked = await Promise.all(
        batch.map(async (topic) => {
          const result = await checkTrendSafety(
            topic.topic,
            topic.sourceType,
            topic.path,
            this.llm,
          );
          if (!result.safe) {
            this.logger.warn(
              `P5: Rejected trending topic "${topic.topic}" — ${result.reason}`,
            );
            return null;
          }
          this.logger.debug(
            `P5: Accepted trending topic "${topic.topic}" — score ${result.opportunityScore}, angle: ${result.suggestedAngle}`,
          );
          // Inject the suggested angle as the first keyword for the LLM to use
          if (result.suggestedAngle) {
            return {
              ...topic,
              keywords: [result.suggestedAngle, ...topic.keywords],
            };
          }
          return topic;
        }),
      );
      for (const t of checked) {
        if (t) results.push(t);
      }
    }

    this.logger.log(
      `P5: Trend guardrail — ${results.length}/${trending.length} trending topics accepted`,
    );
    return [...nonTrending, ...results];
  }

  /**
   * B5: Load SimHash values from recent posts for dedup checking.
   * Looks at posts from the last 30 days across all networks.
   */
  private async loadRecentPostHashes(currentTopic: string): Promise<string[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Sprint L: Use dedicated simhash field with index for fast query.
    // Only select content for fallback computation when simhash is null.
    const recentPosts = await this.prisma.post.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        content: true,
        simhash: true,
        llmMetadata: true,
        sourceRef: true,
      },
      take: 200, // limit to recent 200 posts for performance
    });

    const hashes: string[] = [];

    for (const post of recentPosts) {
      // Sprint L: Prefer dedicated simhash field (precomputed)
      if (post.simhash) {
        hashes.push(post.simhash);
      } else {
        // Fallback: try llmMetadata.simhash for older posts
        const metadata = post.llmMetadata as { simhash?: string } | null;
        if (metadata?.simhash) {
          hashes.push(metadata.simhash);
        } else {
          // Compute hash on the fly for very old posts without stored hash
          hashes.push(simhash(post.content));
        }
      }
    }

    this.logger.debug(`Loaded ${hashes.length} recent post hashes for dedup (topic: "${currentTopic}")`);
    return hashes;
  }

  private async markRunCompleted(runId: string, topics: string[], errorMessage?: string): Promise<void> {
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: errorMessage ? GenerationRunStatus.FAILED : GenerationRunStatus.COMPLETED,
        completedAt: new Date(),
        sourceTopics: topics,
        errorMessage,
      },
    });
  }

  /**
   * List generation runs (most recent first).
   * Dates are converted to ISO strings for proper JSON serialization.
   */
  async listRuns(limit = 20) {
    const runs = await this.prisma.generationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { _count: { select: { posts: true } } },
    });
    return runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Get a single generation run with its posts.
   * Dates are converted to ISO strings for proper JSON serialization.
   */
  async getRun(id: string) {
    const run = await this.prisma.generationRun.findUnique({
      where: { id },
      include: {
        posts: {
          select: { id: true, network: true, content: true, status: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!run) return null;
    return {
      ...run,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      posts: run.posts.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  // ============================================================
  // Sprint I: Resumability — pause, resume, checkpoint inspection
  // ============================================================

  /**
   * Pause a running generation by aborting the active loop.
   * The checkpoint is already saved in Redis — resume picks up from last node.
   * Uses PAUSED status (not FAILED) so health monitor doesn't alert on manual pauses.
   */
  async pauseRun(runId: string): Promise<{ runId: string; status: string }> {
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
      this.activeRuns.delete(runId);
    }
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: { status: GenerationRunStatus.PAUSED, completedAt: new Date(), errorMessage: 'Paused by operator' },
    });
    await this.sseService.publish({ type: 'generation_paused', runId });
    this.logger.log(`Generation run ${runId} paused`);
    return { runId, status: 'paused' };
  }

  /**
   * Resume an interrupted generation run from the last checkpoint.
   * Loads the run, re-fetches topics, and re-invokes the graph with the same thread_ids.
   * LangGraph's checkpoint saver will skip already-completed nodes.
   *
   * Includes SimHash dedup (B5) and SSE progress events for UI consistency.
   */
  async resumeRun(runId: string): Promise<{ runId: string; status: string }> {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error(`Generation run ${runId} not found`);

    // Mark as RUNNING again
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: { status: GenerationRunStatus.RUNNING, completedAt: null, errorMessage: null },
    });

    await this.sseService.publish({ type: 'generation_resumed', runId });

    // Re-fetch topics from sourceTopics stored in the run
    const sourceTopics = (run.sourceTopics as string[]) ?? [];
    if (sourceTopics.length === 0) {
      // No topics stored — can't resume from checkpoint, mark as failed
      this.logger.warn(`Run ${runId} has no stored sourceTopics — cannot resume`);
      await this.markRunCompleted(runId, [], 'Cannot resume: no sourceTopics stored');
      return { runId, status: 'failed' };
    }

    // Get all topics and filter to the ones in this run
    const allTopics = await this.contentSourceService.getTopics(sourceTopics.length * 3);
    const topics = allTopics.filter((t) => sourceTopics.includes(t.topic));

    if (topics.length === 0) {
      await this.markRunCompleted(runId, sourceTopics, 'No topics found for resume');
      return { runId, status: 'completed' };
    }

    const brandVoice = await this.loadBrandVoice();
    const targetNetworks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    // Resume in background — don't block the API response
    void (async () => {
      const postIds: string[] = [];
      try {
        for (const topic of topics) {
          if (controller.signal.aborted) break;
          try {
            // Same thread_id as original — LangGraph will resume from checkpoint
            const config = {
              configurable: { thread_id: `${runId}:${topic.topic}` },
              recursionLimit: 25,
            };
            const initialState = createInitialState(topic, targetNetworks, brandVoice);
            const finalState = await this.getGraph().invoke(initialState, config);
            const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];

            // B5: SimHash dedup — load recent hashes and skip near-duplicates
            const recentHashes = await this.loadRecentPostHashes(topic.topic);

            for (const genPost of generatedPosts) {
              if (!genPost.content) continue;

              const candidateHash = simhash(genPost.content);
              const isDup = recentHashes.some(
                (existing) => hammingDistance(candidateHash, existing) <= 3,
              );
              if (isDup) {
                this.logger.warn(`Resume: skipping near-duplicate for ${genPost.network} / "${topic.topic}"`);
                continue;
              }

              const account = await this.accountsService.findByNetwork(genPost.network);
              if (!account) continue;

              const post = await this.postsService.create({
                accountId: account.id,
                network: genPost.network,
                content: genPost.content,
                generationRunId: runId,
                sourceRef: { type: topic.sourceType, path: topic.path, topic: topic.topic },
                llmMetadata: {
                  model: genPost.model,
                  promptVersion: this.llm.getPromptVersion?.() ?? '0.4.0-resume',
                  hook: genPost.hook,
                  simhash: candidateHash,
                },
              });
              postIds.push(post.id);
              recentHashes.push(candidateHash);
            }
          } catch (err) {
            this.logger.error(`Resume failed for topic "${topic.topic}": ${(err as Error).message}`);
          }
        }
        await this.markRunCompleted(runId, topics.map((t) => t.topic));
        this.activeRuns.delete(runId);
        await this.sseService.publish({ type: 'generation_completed', runId, postCount: postIds.length });
      } catch (outerErr) {
        // Outer error handler — ensures run is never stuck in RUNNING forever
        this.logger.error(`Resume run ${runId} failed unexpectedly: ${(outerErr as Error).message}`);
        this.activeRuns.delete(runId);
        await this.prisma.generationRun.update({
          where: { id: runId },
          data: {
            status: GenerationRunStatus.FAILED,
            completedAt: new Date(),
            errorMessage: `Resume failed: ${(outerErr as Error).message}`,
          },
        });
        await this.sseService.publish({
          type: 'generation_failed',
          runId,
          error: `Resume failed: ${(outerErr as Error).message}`,
        });
      }
    })();

    return { runId, status: 'resumed' };
  }

  /**
   * Sprint I: Resume a generation run that was interrupted by the HITL human_review node.
   *
   * The graph paused at the `human_review` node via `interrupt()`.
   * This method resumes it by passing a Command with the reviewer's decision.
   *
   * @param runId Generation run ID
   * @param topic Topic name (thread_id = runId:topic)
   * @param approved Whether the reviewer approved the drafts
   * @param edits Optional per-network edited draft text
   */
  async resumeWithReview(
    runId: string,
    topic: string,
    approved: boolean,
    edits?: Record<string, string>,
  ): Promise<{ runId: string; topic: string; status: string }> {
    const config = {
      configurable: { thread_id: `${runId}:${topic}` },
      recursionLimit: 25,
    };

    // Resume the graph by passing a Command with the resume payload.
    // The interrupt() call in human_review node will return this value.
    const resumePayload = { approved, edits };
    const finalState = await this.getGraph().invoke(new Command({ resume: resumePayload }), config);
    const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];

    // Save the generated posts (same logic as generatePostsForTopic)
    const postIds: string[] = [];
    const recentHashes = await this.loadRecentPostHashes(topic);

    for (const genPost of generatedPosts) {
      if (!genPost.content) continue;

      const candidateHash = simhash(genPost.content);
      const isDup = recentHashes.some((existing) => hammingDistance(candidateHash, existing) <= 3);
      if (isDup) {
        this.logger.warn(`Review resume: skipping near-duplicate for ${genPost.network} / "${topic}"`);
        continue;
      }

      const account = await this.accountsService.findByNetwork(genPost.network);
      if (!account) continue;

      const post = await this.postsService.create({
        accountId: account.id,
        network: genPost.network,
        content: genPost.content,
        generationRunId: runId,
        sourceRef: { type: 'review', path: '', topic },
        llmMetadata: {
          model: genPost.model,
          promptVersion: this.llm.getPromptVersion?.() ?? '0.4.0-review',
          hook: genPost.hook,
          simhash: candidateHash,
        },
      });
      postIds.push(post.id);
      recentHashes.push(candidateHash);
    }

    await this.sseService.publish({
      type: 'generation_completed',
      runId,
      postCount: postIds.length,
    });

    return { runId, topic, status: 'completed' };
  }

  /**
   * List checkpoints for a generation run — enables time-travel debugging.
   */
  async listCheckpoints(runId: string, limit = 10): Promise<unknown[]> {
    const keys = await this.checkpointSaver.listKeysForThread(runId, limit);
    return keys;
  }

  /**
   * Get the state of a generation run at a specific checkpoint.
   * Requires a topic to construct the correct thread_id (format: `${runId}:${topic}`).
   */
  async getCheckpointState(runId: string, topic: string, checkpointId?: string): Promise<unknown> {
    const threadId = `${runId}:${topic}`;
    const state = await this.getGraph().getState({
      configurable: { thread_id: threadId, checkpoint_id: checkpointId },
    });
    return state;
  }
}
