import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { ContentSourceService } from '../content-source/content-source.service';
import { AccountsService } from '../accounts/accounts.service';
import { PostsService } from '../posts/posts.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisCheckpointSaver } from '../../infrastructure/checkpoint/redis-checkpoint.js';
import {
  SocialNetwork,
  GenerationRunStatus,
  GenerationTrigger,
} from '@prisma/client';
import type { ContentTopic } from '@spa/shared';
import { buildGenerationGraph, createInitialState, type GeneratedPost } from './generation.graph.js';
import { simhash, hammingDistance } from './simhash.js';

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

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly contentSourceService: ContentSourceService,
    private readonly accountsService: AccountsService,
    private readonly postsService: PostsService,
    private readonly prisma: PrismaService,
    private readonly checkpointSaver: RedisCheckpointSaver,
  ) {}

  /**
   * Lazy-compile the graph with the checkpoint saver.
   * Done on first use (not constructor) to ensure Redis is connected.
   */
  private getGraph() {
    if (!this.compiledGraph) {
      const graphBuilder = buildGenerationGraph(this.llm);
      this.compiledGraph = graphBuilder.compile({ checkpointer: this.checkpointSaver });
      this.logger.log('LangGraph workflow compiled with Redis checkpoint saver (§10.3 parallel graph)');
    }
    return this.compiledGraph;
  }

  /**
   * Run generation: get topics → generate posts per topic (all networks in parallel) → save drafts.
   *
   * @param count Number of topics to generate posts for (each topic → 3 posts, one per network)
   * @param networks Optional subset of networks (default: all 3)
   * @param triggeredBy Trigger source (manual/cron)
   * @returns generation run ID
   */
  async generate(
    count = 3,
    networks?: SocialNetwork[],
    triggeredBy: GenerationTrigger = GenerationTrigger.MANUAL,
  ): Promise<string> {
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy, sourceTopics: [] },
    });

    try {
      const topics = await this.contentSourceService.getTopics(count);
      if (topics.length === 0) {
        this.logger.warn('No topics found from content sources');
        await this.markRunCompleted(run.id, [], 'No topics found');
        return run.id;
      }

      // B5: Category diversity + freshness priority
      // 1. Sort by publishedAt descending (freshest first)
      // 2. Rotate categories — no two consecutive topics from same category
      const prioritizedTopics = this.prioritizeTopics(topics, count);

      const targetNetworks = networks ?? [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
      const brandVoice = await this.loadBrandVoice();

      const postIds: string[] = [];
      for (const topic of prioritizedTopics) {
        try {
          // One graph invocation per topic — generates posts for ALL networks in parallel
          const posts = await this.generatePostsForTopic(topic, targetNetworks, brandVoice, run.id);
          postIds.push(...posts.map((p) => p.id));
        } catch (err) {
          this.logger.error(
            `Failed to generate posts for topic "${topic.topic}": ${(err as Error).message}`,
          );
        }
      }

      await this.markRunCompleted(run.id, prioritizedTopics.map((t) => t.topic));
      this.logger.log(`Generation run ${run.id}: ${postIds.length} drafts created`);
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
    const initialState = createInitialState(topic, activeNetworks, brandVoice);

    // Invoke the LangGraph workflow with checkpoint
    // thread_id = runId:topic enables resume after crash (B6 mitigation)
    const config = {
      configurable: { thread_id: `${runId}:${topic.topic}` },
      recursionLimit: 25, // 7 steps × 3 networks parallel, but LangGraph counts each node visit
    };

    this.logger.debug(
      `Invoking LangGraph for "${topic.topic}" → ${activeNetworks.join(', ')} (thread: ${config.configurable.thread_id})`,
    );

    const finalState = await this.getGraph().invoke(initialState, config);
    const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];

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
        sourceRef: {
          type: topic.sourceType,
          path: topic.path,
          topic: topic.topic,
        },
        llmMetadata: {
          model: genPost.model,
          promptVersion: '0.3.0', // §10.3 parallel graph
          hook: genPost.hook,
          angleType: genPost.angle.split('—')[0]?.trim(),
          simhash: candidateHash, // B5: store hash for future dedup
        },
      });

      savedPosts.push(post);
      recentHashes.push(candidateHash); // add to in-memory set for this run
      this.logger.debug(`Created draft post for ${genPost.network}: ${genPost.content.slice(0, 50)}...`);
    }

    return savedPosts;
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
  private prioritizeTopics(topics: ContentTopic[], count: number): ContentTopic[] {
    // Sort by publishedAt descending (freshest first); topics without date go last
    const sorted = [...topics].sort((a, b) => {
      const aTime = a.publishedAt?.getTime() ?? 0;
      const bTime = b.publishedAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    // Rotate categories — pick topics round-robin from different categories
    const result: ContentTopic[] = [];
    const remaining = [...sorted];
    let lastCategory: string | null = null;

    while (remaining.length > 0 && result.length < count) {
      // Find first topic with a different category than last picked
      let idx = remaining.findIndex(
        (t) => (t.category ?? 'uncategorized') !== lastCategory,
      );

      // If all remaining are same category, just take the first
      if (idx === -1) idx = 0;

      const picked = remaining.splice(idx, 1)[0]!;
      result.push(picked);
      lastCategory = picked.category ?? 'uncategorized';
    }

    this.logger.debug(
      `B5: Prioritized ${result.length}/${topics.length} topics — ` +
        `categories: ${result.map((t) => t.category ?? 'uncategorized').join(', ')}`,
    );

    return result;
  }

  /**
   * B5: Load SimHash values from recent posts for dedup checking.
   * Looks at posts from the last 30 days across all networks.
   */
  private async loadRecentPostHashes(currentTopic: string): Promise<string[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const recentPosts = await this.prisma.post.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        content: true,
        llmMetadata: true,
        sourceRef: true,
      },
      take: 200, // limit to recent 200 posts for performance
    });

    const hashes: string[] = [];

    for (const post of recentPosts) {
      // Try to get stored simhash from llmMetadata
      const metadata = post.llmMetadata as { simhash?: string } | null;
      if (metadata?.simhash) {
        hashes.push(metadata.simhash);
      } else {
        // Compute hash on the fly for older posts without stored hash
        hashes.push(simhash(post.content));
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
}
