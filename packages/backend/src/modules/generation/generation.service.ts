import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { ILlmPort } from "../../domain/ports/llm.port.js";
import type { BaseCallbackHandler } from "../../domain/ports/llm-primitives.js";
import { ContentSourceService } from "../content-source/content-source.service.js";
import { AccountsService } from "../accounts/accounts.service.js";
import { AccountSettingsService } from "../accounts/account-settings.service.js";
import { PostsService, extractSourcePath } from "../posts/posts.service.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { RedisCheckpointSaver } from "../../infrastructure/checkpoint/redis-checkpoint.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";
import { TrendingService } from "../trending/trending.service.js";
import { TrendingScraperService } from "../trending/trending-scraper.service.js";
import {
  LangfuseService,
  type LangfuseHandlerOptions,
} from "../../infrastructure/langfuse/langfuse.service.js";
import { withLlmContext } from "../../infrastructure/llm/llm.service.js";
import { combineSignals } from "../../infrastructure/util/abort-signal.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { IPromptPort } from "../../domain/ports/prompt.port.js";
import { DomainConfigService } from "../../domain/domain-config/domain-config.service.js";
import {
  withPromptLabelContext,
  getRecordedPromptLabels,
} from "../../infrastructure/prompt/prompt-label-context.js";
import { getEnabledNetworks, isNetworkEnabled } from "../../domain/enabled-networks.js";
import {
  SocialNetwork,
  GenerationRunStatus,
  GenerationTrigger,
  PostStatus,
  ContentType,
  Post as PrismaPost,
} from "../../generated/prisma/client.js";
import type {
  ContentTopic,
  GenerateArticleOptions,
  ArticleGraphState,
  ArticleContent,
} from "@spa/shared";
import {
  buildGenerationGraph,
  createInitialState,
  type GeneratedPost,
  type ProgressPublisher,
} from "./generation.graph.js";
import { buildArticleGraph, createArticleInitialState } from "./article-graph.js";
import { CanonicalUrlService } from "../canonical/canonical-url.service.js";
import type { JudgeScores } from "@spa/shared";
import { simhash } from "./simhash.js";
import { prioritizeTopics as prioritizeTopicsByFreshness } from "./topic-prioritization.js";
import { checkTrendSafety } from "../content-enhancements/trend-guardrail.js";
import { ContentPillarTracker } from "../content-enhancements/content-pillar.tracker.js";
import { HookPerformanceBank } from "../content-enhancements/hook-performance-bank.js";
import { VisualConceptService } from "../content-enhancements/visual-concept.service.js";
import { ThreadDepthService } from "../content-enhancements/thread-depth.service.js";
import { ABVariantGenerator } from "../content-enhancements/ab-variant.generator.js";
import { ABVariantService } from "../content-enhancements/ab-variant.service.js";
import { OnlineEvaluationService } from "../evaluation/online-evaluation.service.js";
import {
  IAuthorContextPort,
  type AuthorContextResult,
  type IAuthorContextPort as AuthorContextPort,
} from "../../domain/ports/author-context.port.js";
import { EditorialPortfolioService } from "../persona/editorial-portfolio.service.js";
import type { EditorialAccountCandidate } from "../persona/editorial-portfolio-planner.js";
import {
  GenerationPersistenceService,
  type GenerationAccount,
  type GenerationPersistenceOptions,
  type GenerationSourceRef,
  type PersistedGenerationPost,
} from "./generation-persistence.service.js";
import { PostFactory } from "./post.factory.js";
import { GenerationRunLifecycleService } from "./generation-run-lifecycle.service.js";
import { ReviewResumeService } from "./review-resume.service.js";

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
 * Each network gets a DIFFERENT hook + angle (OQ-16: per-network angle = different content).
 *
 * Checkpoint: RedisCheckpointSaver persists state after each node.
 *   thread_id = generationRunId (enables resume after crash — B6 mitigation).
 *
 * Saves drafts as Post (status=DRAFT). Operator reviews in UI before posting.
 */

type CompiledGraph = ReturnType<ReturnType<typeof buildGenerationGraph>["compile"]>;
type AccountResult = Awaited<ReturnType<AccountsService["findFirstActiveByNetwork"]>>;

/**
 * Config object passed to `graph.invoke()`. Includes `callbacks` in the type
 * so we can attach Langfuse handlers without `as` casts.
 */
interface GraphInvokeConfig {
  configurable: { thread_id: string };
  recursionLimit: number;
  callbacks?: BaseCallbackHandler[];
  runName?: string;
  /** AbortSignal passed to graph.invoke so pause/resume can cancel the run. */
  signal?: AbortSignal;
}

@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);
  private brandVoice: string | null = null;
  private compiledGraph: CompiledGraph | null = null;
  /** Article generation graph (lazy-compiled, like social graph) */
  private compiledArticleGraph: Awaited<ReturnType<typeof buildArticleGraph>> | null = null;
  private readonly persistenceService: GenerationPersistenceService;
  private readonly runLifecycle: GenerationRunLifecycleService;
  private readonly reviewResumeService: ReviewResumeService;

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    private readonly contentSourceService: ContentSourceService,
    private readonly accountsService: AccountsService,
    private readonly postsService: PostsService,
    private readonly prisma: PrismaService,
    private readonly checkpointSaver: RedisCheckpointSaver,
    private readonly sseService: SseService,
    private readonly configService: ConfigService,
    @Optional() private readonly trendingService?: TrendingService,
    @Optional() private readonly trendingScraper?: TrendingScraperService,
    @Optional() private readonly pillarTracker?: ContentPillarTracker,
    @Optional() private readonly hookBank?: HookPerformanceBank,
    @Optional() private readonly visualService?: VisualConceptService,
    @Optional() private readonly threadDepthController?: ThreadDepthService,
    @Optional() private readonly abGenerator?: ABVariantGenerator,
    @Optional() private readonly abVariantService?: ABVariantService,
    @Optional() private readonly langfuse?: LangfuseService,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
    @Optional() private readonly domainConfig?: DomainConfigService,
    // M1.3: per-account brand voice overrides (AccountSettings.brandVoice)
    @Optional() private readonly accountSettings?: AccountSettingsService,
    @Optional() private readonly onlineEvaluator?: OnlineEvaluationService,
    @Optional()
    @Inject(IAuthorContextPort)
    private readonly authorContextPort?: AuthorContextPort,
    @Optional() private readonly editorialPortfolio?: EditorialPortfolioService,
    @Optional() persistenceService?: GenerationPersistenceService,
    @Optional() runLifecycle?: GenerationRunLifecycleService,
    @Optional() reviewResumeService?: ReviewResumeService,
  ) {
    this.persistenceService =
      persistenceService ??
      new GenerationPersistenceService(
        postsService,
        abVariantService,
        onlineEvaluator,
        new PostFactory(llm),
      );
    this.runLifecycle =
      runLifecycle ?? new GenerationRunLifecycleService(prisma, sseService, checkpointSaver);
    this.reviewResumeService =
      reviewResumeService ??
      new ReviewResumeService(accountsService, sseService, this.persistenceService);
  }

  /**
   * Lazy-compile the graph with the checkpoint saver and SSE progress publisher.
   * Done on first use (not constructor) to ensure Redis is connected.
   */
  private getGraph(): CompiledGraph {
    if (!this.compiledGraph) {
      const progressPublisher: ProgressPublisher = (event) => {
        this.sseService.publish({
          type: "generation_progress",
          node: event.node,
          topic: event.topic,
          postsCount: event.postsCount,
          error: event.error ?? undefined,
        });
      };
      // Q8: judge-gated refine loop threshold (0 disables the retry loop)
      const rawThreshold = Number(this.configService.get<string>("JUDGE_REFINE_THRESHOLD", "0.6"));
      const rawHardFail = Number(
        this.configService.get<string>("JUDGE_HARD_FAIL_THRESHOLD", "0.25"),
      );
      const rawHardFailAntiAi = Number(
        this.configService.get<string>("JUDGE_HARD_FAIL_ANTI_AI", ""),
      );
      const rawHardFailFactual = Number(
        this.configService.get<string>("JUDGE_HARD_FAIL_FACTUAL", ""),
      );
      const rawHardFailCharacter = Number(
        this.configService.get<string>("JUDGE_HARD_FAIL_CHARACTER", ""),
      );
      const rawSkipAB = Number(this.configService.get<string>("JUDGE_SKIP_AB_THRESHOLD", "0.6"));
      const judgeRefineThreshold = Number.isFinite(rawThreshold) ? rawThreshold : 0.6;
      const judgeHardFailThreshold = Number.isFinite(rawHardFail) ? rawHardFail : 0.25;
      const graphBuilder = buildGenerationGraph(
        this.llm,
        progressPublisher,
        this.hookBank,
        this.visualService,
        this.abGenerator,
        this.abVariantService,
        this.promptPort,
        {
          judgeRefineThreshold,
          judgeHardFailThreshold,
          judgeHardFailAntiAi: Number.isFinite(rawHardFailAntiAi)
            ? rawHardFailAntiAi
            : judgeHardFailThreshold,
          judgeHardFailFactual: Number.isFinite(rawHardFailFactual)
            ? rawHardFailFactual
            : judgeHardFailThreshold,
          judgeHardFailCharacter: Number.isFinite(rawHardFailCharacter)
            ? rawHardFailCharacter
            : judgeHardFailThreshold,
          judgeSkipABThreshold: Number.isFinite(rawSkipAB) ? rawSkipAB : 0.6,
          getRecordedPromptLabels,
          temperatures: {
            hook: Number(this.configService.get<number>("GENERATION_TEMPERATURE_HOOK", 0.95)),
            draft: Number(this.configService.get<number>("GENERATION_TEMPERATURE_DRAFT", 0.8)),
            refine: Number(this.configService.get<number>("GENERATION_TEMPERATURE_REFINE", 0.6)),
          },
        },
      );
      this.compiledGraph = graphBuilder.compile({ checkpointer: this.checkpointSaver });
      this.logger.log(
        "LangGraph workflow compiled with Redis checkpoint saver + SSE progress (§10.3 parallel graph)",
      );
    }
    return this.compiledGraph;
  }

  /**
   * Lazy-compile the article generation graph.
   * Done on first use (not constructor) to ensure dependencies are ready.
   *
   * Phase 0: stub nodes. Phase 1 (P1-05): real LLM implementations.
   *
   * Note: CanonicalUrlService is injected via ModuleRef to avoid a circular
   * dependency (CanonicalModule → PrismaModule, GenerationModule → ...).
   */
  private async getArticleGraph() {
    if (!this.compiledArticleGraph) {
      // CanonicalUrlService is optional in Phase 0 — the graph works without it
      // (set_canonical node handles null gracefully via a fallback slugify)
      let canonicalService: CanonicalUrlService | undefined;
      try {
        const { ModuleRef } = await import("@nestjs/core");
        const moduleRef = (this as unknown as { moduleRef?: InstanceType<typeof ModuleRef> })
          .moduleRef;
        if (moduleRef) {
          canonicalService = moduleRef.get(CanonicalUrlService, { strict: false });
        }
      } catch {
        // CanonicalUrlService not registered yet (SYNDICATION_ENABLED=false)
      }

      // Fallback canonical service if not available
      const blogBaseUrl = this.blogBaseUrl;
      const fallbackCanonical = {
        buildBlogUrl: (slug: string) => `${blogBaseUrl}/blog/${slug}`,
        slugify: (title: string) =>
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, ""),
        setCanonical: async () => {},
        addSyndicatedUrl: async () => {},
        verifyCanonical: async () => true,
      } as unknown as CanonicalUrlService;

      this.compiledArticleGraph = buildArticleGraph({
        llm: this.llm,
        promptPort: this.promptPort ?? null,
        canonicalService: canonicalService ?? fallbackCanonical,
      });
      this.logger.log("Article generation graph compiled (Phase 0 stub nodes)");
    }
    return this.compiledArticleGraph;
  }

  /**
   * Generate an article using the article LangGraph.
   *
   * Flow: research_extract → outline → draft_article → judge_article →
   *   [refine_article loop, max 3] → set_canonical → save_to_db
   *
   * Phase 0: stub nodes — returns placeholder article.
   * Phase 1 (P1-05): real LLM implementations.
   *
   * @param options - Article generation options (topic, keywords, language, targetNetworks)
   * @returns Final article state with canonical URL
   */
  async generateArticle(options: GenerateArticleOptions): Promise<ArticleGraphState> {
    const runId = `article-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.logger.log(`generateArticle: topic="${options.topic}", runId=${runId}`);

    // English-only article generation.
    const englishOptions = { ...options, language: "en" };
    const initialState = createArticleInitialState(englishOptions, runId);
    const config = {
      configurable: { thread_id: `${runId}:${options.topic}` },
      recursionLimit: 50,
    };

    try {
      const graph = await this.getArticleGraph();
      const finalState = await graph.invoke(initialState, config);
      this.logger.log(
        `Article generation complete: topic="${options.topic}", canonical=${finalState.canonicalUrl}`,
      );
      return finalState as ArticleGraphState;
    } catch (error) {
      this.logger.error(
        `Article generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ...initialState,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Invoke the LangGraph workflow with Langfuse tracing attached.
   *
   * Centralises the callback wiring that was previously duplicated across 3
   * call sites: create a CallbackHandler from the given options, attach it
   * to the config, and wrap the invoke in AsyncLocalStorage so all
   * llm.generateChat() calls inside graph nodes nest under the trace.
   *
   * Also wraps the invocation in a prompt-label context so PromptRegistry can
   * record the exact Langfuse labels used for each prompt in this run.
   *
   * When Langfuse is disabled (no LANGFUSE_PUBLIC_KEY), this is a plain
   * graph.invoke() with zero overhead.
   */
  private async tracedGraphInvoke(
    config: GraphInvokeConfig,
    handlerOpts: LangfuseHandlerOptions,
    input: Parameters<ReturnType<ReturnType<typeof buildGenerationGraph>["compile"]>["invoke"]>[0],
    runId: string,
    model?: string,
  ): Promise<{
    finalState: Record<string, unknown>;
    promptLabels: Record<string, { label: string; isFallback?: boolean }>;
  }> {
    const handler = this.langfuse?.createHandler(handlerOpts);
    const callbacks = handler ? [handler] : [];
    if (callbacks.length > 0) {
      config.callbacks = callbacks;
    }
    const invokeGraph = async (): Promise<Record<string, unknown>> =>
      (await this.getGraph().invoke(input, config)) as Record<string, unknown>;
    return withPromptLabelContext(() =>
      withLlmContext(
        { callbacks, signal: config.signal, budgetScope: "generation", budgetRunId: runId, model },
        async () => {
          let finalState: Record<string, unknown>;
          if (this.langfuse?.isEnabled) {
            const traceMetadata = handlerOpts.traceMetadata ?? {};
            const traceInput = {
              run_id: runId,
              topic: typeof traceMetadata.topic === "string" ? traceMetadata.topic : "unknown",
              language:
                typeof traceMetadata.language === "string" ? traceMetadata.language : "unknown",
              networks:
                typeof traceMetadata.networks === "string" ? traceMetadata.networks : "unknown",
            } as const;
            finalState = await this.langfuse.withTrace(
              {
                rootName: "agent.generation",
                feature: "generation",
                sessionId: handlerOpts.sessionId ?? runId,
                tags: handlerOpts.tags,
                metadata: traceMetadata,
                input: traceInput,
                output: () => ({ status: "completed", run_id: runId }),
              },
              invokeGraph,
            );
          } else {
            finalState = await invokeGraph();
          }
          const promptLabels = getRecordedPromptLabels();
          return { finalState, promptLabels };
        },
      ),
    );
  }

  // Compatibility delegators keep the public GenerationService surface stable while the
  // persistence/factory implementation lives in GenerationPersistenceService.
  private buildPostLlmMetadata(
    genPost: GeneratedPost,
    postSimhash: string,
    promptLabels: Record<string, { label: string; isFallback?: boolean }>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    this.persistenceService.configureOptionalServices(this.abVariantService, this.onlineEvaluator);
    return this.persistenceService.buildPostLlmMetadata(
      genPost,
      postSimhash,
      promptLabels,
      overrides,
    );
  }

  private persistGeneratedPosts(
    generatedPosts: GeneratedPost[],
    accountsByNetwork: Map<SocialNetwork, AccountResult[] | AccountResult | null | undefined>,
    runId: string,
    sourceRef: GenerationSourceRef,
    options: GenerationPersistenceOptions = {},
  ): Promise<PersistedGenerationPost[]> {
    this.persistenceService.configureOptionalServices(this.abVariantService, this.onlineEvaluator);
    return this.persistenceService.persistGeneratedPosts(
      generatedPosts,
      accountsByNetwork,
      runId,
      sourceRef,
      options,
    );
  }

  private persistPostVariants(
    postId: string,
    genPost: GeneratedPost,
    judgeScores?: JudgeScores,
  ): Promise<void> {
    this.persistenceService.configureOptionalServices(this.abVariantService, this.onlineEvaluator);
    return this.persistenceService.persistPostVariants(postId, genPost, judgeScores);
  }

  private persistPostVariantForContent(
    postId: string,
    network: SocialNetwork,
    content: string,
    judgeScores?: JudgeScores,
  ): Promise<void> {
    this.persistenceService.configureOptionalServices(this.abVariantService, this.onlineEvaluator);
    return this.persistenceService.persistPostVariantForContent(
      postId,
      network,
      content,
      judgeScores,
    );
  }

  private evaluateOnlineOutput(postId: string, generated: GeneratedPost): Promise<void> {
    this.persistenceService.configureOptionalServices(this.abVariantService, this.onlineEvaluator);
    return this.persistenceService.evaluateOnlineOutput(postId, generated);
  }

  /**
   * Resolve target networks to only enabled ones.
   * If no subset is provided, fall back to all enabled networks.
   */
  private resolveTargetNetworks(networks?: SocialNetwork[] | null): SocialNetwork[] {
    if (!networks) {
      return getEnabledNetworks();
    }
    return networks.filter(isNetworkEnabled);
  }

  /**
   * Run generation: get topics → generate posts per topic (all networks in parallel) → save drafts.
   *
   * @param count Number of topics to generate posts for (each topic → 3 posts, one per network)
   * @param networks Optional subset of networks (default: all enabled)
   * @param triggeredBy Trigger source (manual/cron)
   * @param multiStage F2: if true, generate hook + continuation posts linked as a thread
   * @param humanReview Whether to pause for human review before saving drafts
   * @param model F3: optional explicit provider/model override (e.g. "openai/gpt-5-nano")
   * @returns generation run ID
   */
  async generate(
    count = 3,
    networks?: SocialNetwork[],
    triggeredBy: GenerationTrigger = GenerationTrigger.MANUAL,
    multiStage = false,
    humanReview = false,
    model?: string,
    signal?: AbortSignal,
    options?: { accountIds?: string[] },
  ): Promise<string> {
    const run = await this.runLifecycle.start(triggeredBy, count);

    // AbortController enables pause/resume to actually stop the in-flight run.
    const controller = this.runLifecycle.register(run.id);

    // Merge internal pause/resume controller with any external abort signal
    // (e.g. orchestrator execute-node timeout / stop).
    const stopSignal = combineSignals(controller.signal, signal);

    try {
      let topics = await this.contentSourceService.getTopics(count);

      // INTEL-101 / F22: Enrich topics with trending topics (Google Trends + X + domain calendar)
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
            const trendingCount = Math.min(Math.ceil(count * 0.4), trendingTopics.length);
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
        this.logger.warn("No topics found from content sources");
        await this.markRunCompleted(run.id, [], "No topics found");
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
        this.logger.warn("P5: All topics rejected by trend guardrail — no topics to generate");
        await this.markRunCompleted(run.id, [], "All topics rejected by trend guardrail");
        return run.id;
      }
      topics = safeTopics;

      // P6: Content Pillar Rotation — get a recommendation for which pillar
      // to prioritize. The recommended pillar is injected into each topic's
      // keywords so the generation graph steers the LLM toward the
      // underrepresented pillar. Graceful degradation: if the tracker is
      // unavailable (Redis down), generation continues without steering.
      let pillarHint = "";
      if (this.pillarTracker) {
        try {
          const rec = await this.pillarTracker.recommendPillar();
          pillarHint = rec.recommended;
          this.logger.log(`P6: Recommending pillar "${pillarHint}" — ${rec.reason}`);
        } catch (err) {
          this.logger.warn(
            `P6: Pillar recommendation failed (non-blocking): ${(err as Error).message}`,
          );
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

      const targetNetworks = networks ?? getEnabledNetworks();
      const brandVoice = await this.loadBrandVoice();

      // Sprint L: Parallel topic generation — up to 3 topics in parallel
      // (limited to avoid overwhelming LLM providers with too many concurrent calls)
      const MAX_CONCURRENCY = 3;
      const postIds: string[] = [];
      // P2: Judge score samples + run metrics for end-of-run calibration summary
      const judgeScoreSamples: Array<{
        network: SocialNetwork;
        anti_ai_tone: number;
        hook_strength: number;
        factual_accuracy: number;
        character_limit: number;
        qualityScore: number;
      }> = [];
      let runTokens = 0;
      let runCost = 0;

      // Process topics in batches of MAX_CONCURRENCY
      for (let i = 0; i < prioritizedTopics.length; i += MAX_CONCURRENCY) {
        if (stopSignal?.aborted) {
          this.logger.warn(`Generation run ${run.id} aborted — stopping topic batch`);
          break;
        }

        const batch = prioritizedTopics.slice(i, i + MAX_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((topic) => {
            // Generation is deliberately English-only. Source/topic language metadata
            // remains immutable, but it never changes the generated post language.
            const language = "en";
            this.logger.debug(`Generating topic "${topic.topic.slice(0, 40)}" in ${language}`);
            return this.generatePostsForTopic(
              topic,
              targetNetworks,
              brandVoice,
              run.id,
              multiStage,
              humanReview,
              language,
              model,
              stopSignal,
              options?.accountIds,
            );
          }),
        );

        for (let r = 0; r < results.length; r++) {
          const result = results[r];
          if (!result) continue;
          const topic = batch[r];
          if (result.status === "fulfilled") {
            // 2.8.1: Mark the topic as used after successful generation so
            // it is not selected again in the next cycle.
            if (topic) {
              try {
                await this.contentSourceService.markUsed(topic);
              } catch (err) {
                this.logger.debug(
                  `markUsed failed for topic (non-blocking): ${(err as Error).message}`,
                );
              }
            }
            postIds.push(...result.value.map((p) => p.id));
            // P2: Collect judge scores for calibration summary
            for (const post of result.value) {
              const meta = post.llmMetadata as Record<string, unknown> | null;
              const scores = meta?.judgeScores as Record<string, unknown> | null;
              if (scores && typeof scores.anti_ai_tone === "number") {
                judgeScoreSamples.push({
                  network: post.network,
                  anti_ai_tone: scores.anti_ai_tone as number,
                  hook_strength: (scores.hook_strength as number) ?? 0,
                  factual_accuracy: (scores.factual_accuracy as number) ?? 0,
                  character_limit: (scores.character_limit as number) ?? 0,
                  qualityScore: (meta?.qualityScore as number) ?? 0,
                });
              }
              if (meta) {
                const tokens = typeof meta.tokens === "number" ? meta.tokens : 0;
                const cost = typeof meta.cost === "number" ? meta.cost : 0;
                runTokens += tokens;
                runCost += cost;
              }
            }
          } else {
            this.logger.error(
              `Failed to generate posts for topic: ${(result.reason as Error)?.message ?? "unknown"}`,
            );
          }
        }
      }

      // P2: Judge calibration summary — log aggregate judge scores per run so
      // operators can correlate anti_ai_tone with approve/reject decisions and
      // adjust JUDGE_REFINE_THRESHOLD or the judge prompt over time.
      if (judgeScoreSamples.length > 0) {
        const avg = (
          key: "anti_ai_tone" | "hook_strength" | "factual_accuracy" | "character_limit",
        ) =>
          Number(
            (judgeScoreSamples.reduce((s, x) => s + x[key], 0) / judgeScoreSamples.length).toFixed(
              2,
            ),
          );
        const threshold =
          Number(this.configService.get<string>("JUDGE_REFINE_THRESHOLD", "0.6")) || 0.6;
        const belowThreshold = judgeScoreSamples.filter((s) => s.anti_ai_tone < threshold).length;
        const promptVersion = this.llm.getPromptVersion?.() ?? "unknown";
        this.logger.log(
          `Judge calibration [run ${run.id}]: ${judgeScoreSamples.length} posts scored — ` +
            `avg anti_ai=${avg("anti_ai_tone")} hook=${avg("hook_strength")} ` +
            `factual=${avg("factual_accuracy")} chars=${avg("character_limit")} — ` +
            `${belowThreshold}/${judgeScoreSamples.length} below refine threshold — ` +
            `tokens=${runTokens} cost=$${runCost.toFixed(6)} promptVersion=${promptVersion}`,
        );
      }

      // If the run was paused, do not mark it as completed.
      if (stopSignal?.aborted) {
        if (signal?.aborted) {
          throw new Error("Generation aborted by orchestrator");
        }
        this.logger.warn(`Generation run ${run.id} ended early (paused or aborted)`);
        return run.id;
      }

      await this.markRunCompleted(
        run.id,
        prioritizedTopics.map((t) => t.topic),
      );
      this.logger.log(
        `Generation run ${run.id}: ${postIds.length} drafts created — tokens=${runTokens} cost=$${runCost.toFixed(6)}`,
      );
      // Sprint I: SSE generation_completed event
      await this.sseService.publish({
        type: "generation_completed",
        runId: run.id,
        postCount: postIds.length,
      });
      return run.id;
    } catch (err) {
      // Distinguish pause/resume (internal controller aborted) from orchestrator
      // abort (external signal) so the run status is not overwritten.
      if (stopSignal?.aborted && !signal?.aborted) {
        this.logger.warn(`Generation run ${run.id} ended early (paused or aborted)`);
        return run.id;
      }

      const message = signal?.aborted
        ? "Generation aborted by orchestrator"
        : (err as Error).message;
      await this.runLifecycle.markFailed(run.id, message);
      throw new Error(message);
    } finally {
      this.runLifecycle.remove(run.id);
      // Abort the internal controller so the combined signal cleans up its
      // listeners on the external orchestrator signal.
      controller.abort();
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
        .filter((t) => t.sourceType === "article" && t.facts.length > 0)
        .slice(0, articleCount);

      if (articles.length === 0) {
        this.logger.warn("F10: No articles with facts found for repurposing");
        await this.markRunCompleted(run.id, [], "No articles with facts found");
        return run.id;
      }

      const targetNetworks = networks ?? getEnabledNetworks();
      const brandVoice = await this.loadBrandVoice();
      const postIds: string[] = [];
      const sourceTopics: string[] = [];

      for (const article of articles) {
        sourceTopics.push(article.topic);
        this.logger.log(
          `F10: Repurposing "${article.topic}" — ${article.facts.length} facts extracted`,
        );

        for (let factIdx = 0; factIdx < article.facts.length; factIdx++) {
          const fact = article.facts[factIdx]!;
          try {
            // Create a synthetic topic from each fact
            const factTopic: ContentTopic = {
              ...article,
              topic: `${article.topic} — Fact ${factIdx + 1}`,
              facts: [fact],
            };
            const posts = await this.generatePostsForTopic(
              factTopic,
              targetNetworks,
              brandVoice,
              run.id,
              false,
            );
            // Tag posts with fact_index in sourceRef
            for (const post of posts) {
              const sourceRef = {
                type: "article" as const,
                path: article.path,
                topic: article.topic,
                factIndex: factIdx,
                keywords: article.keywords,
              };
              await this.prisma.post.update({
                where: { id: post.id },
                data: {
                  sourceRef,
                  sourcePath: extractSourcePath(sourceRef),
                },
              });
            }
            postIds.push(...posts.map((p) => p.id));
          } catch (err) {
            this.logger.error(
              `F10: Failed to generate post for fact ${factIdx + 1} of "${article.topic}": ${(err as Error).message}`,
            );
          }
        }

        // 2.8.1: Mark the source article as used after it has been consumed.
        try {
          await this.contentSourceService.markUsed(article);
        } catch (err) {
          this.logger.debug(
            `markUsed failed for article (non-blocking): ${(err as Error).message}`,
          );
        }
      }

      await this.markRunCompleted(run.id, sourceTopics);
      this.logger.log(
        `F10: Generation run ${run.id}: ${postIds.length} posts from ${articles.length} articles`,
      );
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
          language: true,
          sourceRef: true,
          createdAt: true,
          llmMetadata: true,
        },
        orderBy: { createdAt: "desc" },
        take: postCount * 3, // Get more than needed — dedup by topic
      });

      if (oldPosts.length === 0) {
        this.logger.warn(`F13: No posted posts older than ${minAgeDays} days found for recycling`);
        await this.markRunCompleted(run.id, [], "No old posts found for recycling");
        return run.id;
      }

      // Deduplicate by sourceRef topic — only recycle each topic once
      const seenTopics = new Set<string>();
      const uniquePosts = oldPosts
        .filter((p) => {
          const topic =
            p.sourceRef && typeof p.sourceRef === "object" && "topic" in p.sourceRef
              ? String((p.sourceRef as Record<string, unknown>).topic)
              : p.content.slice(0, 80);
          if (seenTopics.has(topic)) return false;
          seenTopics.add(topic);
          return true;
        })
        .slice(0, postCount);

      if (uniquePosts.length === 0) {
        this.logger.warn("F13: All old posts are duplicates — nothing to recycle");
        await this.markRunCompleted(run.id, [], "All old posts already recycled");
        return run.id;
      }

      const targetNetworks = networks ?? getEnabledNetworks();
      const brandVoice = await this.loadBrandVoice();
      const postIds: string[] = [];
      const sourceTopics: string[] = [];

      for (const oldPost of uniquePosts) {
        // Extract topic from sourceRef or content
        const topicStr =
          oldPost.sourceRef && typeof oldPost.sourceRef === "object" && "topic" in oldPost.sourceRef
            ? String((oldPost.sourceRef as Record<string, unknown>).topic)
            : oldPost.content.slice(0, 80);

        sourceTopics.push(topicStr);
        this.logger.log(
          `F13: Recycling "${topicStr}" (original post: ${oldPost.id}, age: ${Math.round((Date.now() - oldPost.createdAt.getTime()) / (1000 * 60 * 60 * 24))} days)`,
        );

        const metadata = (oldPost.llmMetadata as Record<string, unknown> | null) ?? {};
        if (metadata.recycled === true) {
          this.logger.debug(`F13: post ${oldPost.id} already recycled — skipping`);
          continue;
        }

        try {
          // Create a synthetic topic for regeneration with "evergreen" angle
          const recycledTopic: ContentTopic = {
            sourceType: "topic",
            path: `recycle://${oldPost.id}`,
            topic: `${topicStr} (evergreen revival)`,
            keywords: [],
            facts: [],
            category: "evergreen",
            publishedAt: new Date(),
            language: oldPost.language,
          };

          const posts = await this.generatePostsForTopic(
            recycledTopic,
            targetNetworks,
            brandVoice,
            run.id,
            false,
            false,
            recycledTopic.language,
          );

          // Tag posts with recycle metadata
          for (const post of posts) {
            const sourceRef = {
              type: "recycle" as const,
              path: recycledTopic.path,
              originalPostId: oldPost.id,
              originalTopic: topicStr,
              topic: recycledTopic.topic,
              keywords: recycledTopic.keywords,
              recycledAt: new Date().toISOString(),
            };
            await this.prisma.post.update({
              where: { id: post.id },
              data: {
                sourceRef,
                sourcePath: extractSourcePath(sourceRef),
              },
            });
          }
          postIds.push(...posts.map((p) => p.id));

          // 2.8.3: Mark the original as recycled only after successful generation.
          await this.prisma.post.update({
            where: { id: oldPost.id },
            data: {
              llmMetadata: { ...metadata, recycled: true, recycledAt: new Date().toISOString() },
            },
          });
        } catch (err) {
          this.logger.error(
            `F13: Failed to recycle post ${oldPost.id} ("${topicStr}"): ${(err as Error).message}`,
          );
        }
      }

      await this.markRunCompleted(run.id, sourceTopics);
      this.logger.log(
        `F13: Generation run ${run.id}: ${postIds.length} recycled posts from ${uniquePosts.length} old posts`,
      );
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
   * RC3: recycle ONE specific posted post by id — re-writes its content through the
   * generation graph (NOT a verbatim copy). Marks the original as recycled and returns the
   * first new draft, or null if the post isn't eligible. Used by RecyclingService so the
   * manual recycle endpoints can never emit a verbatim 30-day-old duplicate that bypasses
   * SimHash (the old RecyclingService.recyclePost copied content verbatim and nothing
   * rewrote it).
   */
  async recycleById(
    postId: string,
    networks?: SocialNetwork[],
  ): Promise<{ id: string; status: string } | null> {
    const original = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        content: true,
        network: true,
        language: true,
        sourceRef: true,
        status: true,
        llmMetadata: true,
      },
    });
    if (!original || original.status !== PostStatus.POSTED) {
      return null;
    }

    // 2.8.3: Do not mark the original as recycled until generation succeeds.
    // Also guard against double-recycling.
    const metadata = (original.llmMetadata as Record<string, unknown> | null) ?? {};
    if (metadata.recycled === true) {
      this.logger.warn(`RC3: post ${postId} is already recycled`);
      return null;
    }

    const topicStr =
      original.sourceRef && typeof original.sourceRef === "object" && "topic" in original.sourceRef
        ? String((original.sourceRef as Record<string, unknown>).topic)
        : original.content.slice(0, 80);

    const targetNetworks = this.resolveTargetNetworks(networks ?? [original.network]);
    if (targetNetworks.length === 0) {
      this.logger.debug(
        `RC3: skipping recycle of ${postId} — network ${original.network} is disabled`,
      );
      return null;
    }
    const brandVoice = await this.loadBrandVoice();
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy: GenerationTrigger.MANUAL, sourceTopics: [topicStr] },
    });

    try {
      const recycledTopic: ContentTopic = {
        sourceType: "topic",
        path: `recycle://${original.id}`,
        topic: `${topicStr} (evergreen revival)`,
        keywords: [],
        facts: [],
        category: "evergreen",
        publishedAt: new Date(),
        language: original.language,
      };
      const posts = await this.generatePostsForTopic(
        recycledTopic,
        targetNetworks,
        brandVoice,
        run.id,
        false,
        false,
        recycledTopic.language,
      );
      for (const post of posts) {
        const sourceRef = {
          type: "recycle" as const,
          path: recycledTopic.path,
          originalPostId: original.id,
          originalTopic: topicStr,
          topic: recycledTopic.topic,
          keywords: recycledTopic.keywords,
          recycledAt: new Date().toISOString(),
        };
        await this.prisma.post.update({
          where: { id: post.id },
          data: {
            sourceRef,
            sourcePath: extractSourcePath(sourceRef),
          },
        });
      }

      // 2.8.3: Mark the original as recycled only after successful generation.
      await this.prisma.post.update({
        where: { id: postId },
        data: {
          llmMetadata: { ...metadata, recycled: true, recycledAt: new Date().toISOString() },
        },
      });

      await this.markRunCompleted(run.id, [topicStr]);
      this.logger.log(
        `RC3: recycled post ${postId} → ${posts.length} re-written draft(s) via graph`,
      );
      return posts[0] ? { id: posts[0].id, status: PostStatus.DRAFT } : null;
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

  // P2-04: Networks eligible for social promo posts triggered by article/social publish.
  private static readonly SOCIAL_PROMO_NETWORKS = new Set<SocialNetwork>([
    SocialNetwork.X,
    SocialNetwork.THREADS,
    SocialNetwork.FACEBOOK,
    SocialNetwork.BLUESKY,
    SocialNetwork.MASTODON,
    SocialNetwork.TELEGRAM,
    SocialNetwork.LINKEDIN,
  ]);

  /**
   * P2-04: Social promo trigger — when a post is published and verified, spin up
   * platform-native promo posts for all enabled social networks.
   *
   * The original post becomes the content source: articles become topics from the
   * article title/excerpt/tags; social posts become topics from their content.
   * Generated promo posts inherit the original canonical URL (for articles) and
   * are linked via `originalPostId` in sourceRef.
   */
  async generateSocialPromo(
    originalPost: PrismaPost,
    targetNetworks?: SocialNetwork[],
  ): Promise<string | null> {
    if (originalPost.status !== PostStatus.POSTED && originalPost.status !== PostStatus.VERIFIED) {
      this.logger.debug(
        `Social promo skipped for post ${originalPost.id} — status ${originalPost.status}`,
      );
      return null;
    }

    const topic = this.buildPromoTopic(originalPost);
    if (!topic) {
      this.logger.warn(`Social promo could not build a topic from post ${originalPost.id}`);
      return null;
    }

    const networks = this.resolveTargetNetworks(
      targetNetworks ??
        Array.from(GenerationService.SOCIAL_PROMO_NETWORKS).filter(
          (n) => n !== originalPost.network,
        ),
    );
    if (networks.length === 0) {
      this.logger.debug(`Social promo: no eligible networks for post ${originalPost.id}`);
      return null;
    }

    const run = await this.prisma.generationRun.create({
      data: { triggeredBy: GenerationTrigger.CRON, sourceTopics: [topic.topic] },
    });

    try {
      this.logger.log(
        `Social promo: generating posts for "${topic.topic}" from ${originalPost.id} → ${networks.join(", ")}`,
      );

      const brandVoice = await this.loadBrandVoice();
      const savedPosts = await this.generatePostsForTopic(
        topic,
        networks,
        brandVoice,
        run.id,
        false,
        false,
        topic.language,
      );

      // Inherit canonical URL from the original post (articles) and tag the source.
      if (originalPost.canonicalUrl) {
        await this.prisma.post.updateMany({
          where: { id: { in: savedPosts.map((p) => p.id) } },
          data: { canonicalUrl: originalPost.canonicalUrl },
        });
      }

      const postCount = savedPosts.length;
      await this.markRunCompleted(run.id, [topic.topic]);
      this.logger.log(
        `Social promo run ${run.id}: ${postCount} promo drafts created from ${originalPost.id}`,
      );
      return run.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Social promo failed for ${originalPost.id}: ${message}`);
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: GenerationRunStatus.FAILED,
          completedAt: new Date(),
          errorMessage: message,
        },
      });
      return null;
    }
  }

  /**
   * Build a ContentTopic from a published post so the social generation graph can
   * create platform-native promo posts from it.
   */
  private buildPromoTopic(originalPost: PrismaPost): ContentTopic | null {
    const base: ContentTopic = {
      sourceType: "topic" as const,
      path: `promo://${originalPost.id}`,
      topic: originalPost.content.slice(0, 120),
      keywords: [],
      facts: [originalPost.content],
      originalPostId: originalPost.id,
      language: originalPost.language,
    };

    if (originalPost.contentType === ContentType.ARTICLE) {
      let article: ArticleContent;
      try {
        article = JSON.parse(originalPost.content) as ArticleContent;
      } catch {
        this.logger.warn(
          `Social promo: post ${originalPost.id} has ARTICLE contentType but invalid JSON`,
        );
        return null;
      }

      return {
        ...base,
        sourceType: "article" as const,
        path: originalPost.canonicalUrl || `promo://article/${article.slug || originalPost.id}`,
        topic: article.title || base.topic,
        keywords: article.tags || [],
        facts: [article.excerpt || article.bodyMarkdown.slice(0, 200)],
        originalTopic: article.title,
        canonicalUrl: originalPost.canonicalUrl || undefined,
      };
    }

    if (originalPost.sourceRef && typeof originalPost.sourceRef === "object") {
      const ref = originalPost.sourceRef as Record<string, unknown>;
      if (typeof ref.path === "string") base.path = ref.path;
      if (typeof ref.topic === "string") {
        base.topic = ref.topic;
        base.originalTopic = ref.topic;
      }
      if (Array.isArray(ref.keywords)) base.keywords = ref.keywords as string[];
    }

    return base;
  }

  /**
   * M1.3: group target networks by the effective brand voice of their primary
   * account. Networks whose account has no settings.brandVoice override share
   * the global brand-voice group; each distinct override gets its own group
   * (and therefore its own graph invocation). Order is preserved.
   */
  private async groupNetworksByBrandVoice(
    networks: SocialNetwork[],
    accountsByNetwork: Map<SocialNetwork, AccountResult[]>,
    globalVoice: string,
  ): Promise<Map<string, SocialNetwork[]>> {
    const groups = new Map<string, SocialNetwork[]>();
    for (const network of networks) {
      let effective = globalVoice;
      const primary = accountsByNetwork.get(network)?.[0];
      if (primary && this.accountSettings) {
        try {
          const { values } = await this.accountSettings.resolve(primary.id);
          if (values.brandVoice && values.brandVoice.trim() !== "") {
            effective = values.brandVoice;
          }
        } catch (err) {
          this.logger.warn(
            `Brand-voice override lookup failed for account ${primary.id} — using global voice`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const list = groups.get(effective);
      if (list) list.push(network);
      else groups.set(effective, [network]);
    }
    return groups;
  }

  /**
   * Resolve a versioned author context for the account selected for each
   * network. Resolution is best-effort for legacy/test deployments: a failed
   * lookup falls back to the global brand voice and never fabricates identity.
   */
  private async resolveAuthorContexts(
    networks: SocialNetwork[],
    accountsByNetwork: Map<SocialNetwork, AccountResult[]>,
    retrievalQuery?: string,
    retrievalDomain?: string,
  ): Promise<Partial<Record<SocialNetwork, AuthorContextResult>>> {
    const contexts: Partial<Record<SocialNetwork, AuthorContextResult>> = {};
    if (!this.authorContextPort) return contexts;

    await Promise.all(
      networks.map(async (network) => {
        const account = accountsByNetwork.get(network)?.[0];
        if (!account) return;
        try {
          contexts[network] = await this.authorContextPort!.resolve({
            accountId: account.id,
            network,
            retrievalQuery,
            retrievalDomain,
          });
        } catch (err) {
          this.logger.warn(
            `Author context lookup failed for account ${account.id} — using global fallback`,
            err instanceof Error ? err.message : String(err),
          );
          contexts[network] = {
            accountId: account.id,
            network,
            personaId: null,
            personaRevisionId: null,
            voiceMode: "default",
            experimentAssignmentId: null,
            profile: null,
            disclosure: null,
            safetyPolicyVersion: null,
            source: "GLOBAL_FALLBACK",
          };
        }
      }),
    );
    return contexts;
  }

  private async planPortfolioDispatch(
    topic: ContentTopic,
    activeNetworks: readonly SocialNetwork[],
    accountsByNetwork: Map<SocialNetwork, AccountResult[]>,
    humanReview: boolean,
  ): Promise<Map<SocialNetwork, { accountId: string; assignmentId?: string } | null>> {
    const dispatch = new Map<SocialNetwork, { accountId: string; assignmentId?: string } | null>();
    if (!this.editorialPortfolio || !this.authorContextPort) return dispatch;
    const domain = topic.category ?? "general";

    for (const network of activeNetworks) {
      const accounts = (accountsByNetwork.get(network) ?? []).filter(
        (account): account is NonNullable<AccountResult> => Boolean(account),
      );
      if (accounts.length === 0) continue;
      try {
        const thesisHash = createHash("sha256")
          .update(`${network}:${topic.topic}:${domain}`, "utf8")
          .digest("hex");
        const opportunity = await this.editorialPortfolio.ensureOpportunity({
          sourceType: topic.sourceType,
          sourceRef: { path: topic.path, topic: topic.topic, network },
          canonicalTopic: topic.topic,
          thesis: topic.topic,
          thesisHash,
          domain,
          riskTier: "LOW",
          funnelIntent: "AWARENESS",
          validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
          status: "OPEN",
        });
        const existing = await this.editorialPortfolio.findActiveAssignment(opportunity.id);
        if (existing?.accountId) {
          dispatch.set(network, { accountId: existing.accountId, assignmentId: existing.id });
          continue;
        }

        const candidates: EditorialAccountCandidate[] = await Promise.all(
          accounts.map(async (account) => {
            const context = await this.authorContextPort!.resolve({
              accountId: account.id,
              network,
              retrievalQuery: topic.topic,
              retrievalDomain: domain,
            });
            const ageDays = topic.publishedAt
              ? Math.max(0, (Date.now() - topic.publishedAt.getTime()) / 86_400_000)
              : 0;
            return {
              accountId: account.id,
              personaRevisionId: context.personaRevisionId ?? "",
              network,
              voiceMode: context.voiceMode,
              policyMode: humanReview ? "HUMAN_APPROVAL_REQUIRED" : "SUGGEST_ONLY",
              healthy: account.active,
              allowedActions: ["OWN_POST"],
              personaFit: context.source === "PERSONA" ? 1 : 0.25,
              audienceDemand: 0.5,
              sourceFreshness: Math.max(0, Math.min(1, 1 - ageDays / 30)),
              novelty: 1,
              pillarDeficit: 0.5,
              funnelDeficit: 0.5,
              conversationOpportunity: 0,
              expectedCost: 0.5,
              reviewCapacity: humanReview ? 1 : 0.5,
            } satisfies EditorialAccountCandidate;
          }),
        );
        const assignment = await this.editorialPortfolio.planAndPersist({
          opportunity: {
            opportunityId: opportunity.id,
            canonicalTopic: topic.topic,
            thesis: topic.topic,
            thesisHash,
            domain,
            riskTier: "LOW",
            funnelIntent: "AWARENESS",
            validUntil: new Date(opportunity.validUntil ?? Date.now() + 86_400_000),
            status: "OPEN",
          },
          candidates,
        });
        if (assignment?.accountId && assignment.action === "OWN_POST") {
          dispatch.set(network, {
            accountId: assignment.accountId,
            assignmentId: assignment.assignmentId,
          });
        } else {
          dispatch.set(network, null);
        }
      } catch (err) {
        this.logger.warn(
          `PERSONA-103 portfolio dispatch unavailable for ${network}; retaining legacy account selection: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return dispatch;
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
    _language = "en",
    model?: string,
    signal?: AbortSignal,
    accountIds?: string[],
  ): Promise<{ id: string; network: SocialNetwork; llmMetadata: Prisma.JsonValue }[]> {
    // English-only generation: ignore any non-English language passed from
    // topic/language rotation and always generate in English.
    const language = "en";

    // Only generate for networks that are enabled in configuration.
    const resolvedTargetNetworks = this.resolveTargetNetworks(targetNetworks);

    // Check which networks have active accounts.
    // Q11 (N+1 fix): load each network's account ONCE and reuse the map in the
    // save loop below (previously findByNetwork was re-queried per generated
    // post); per-network checks run in parallel instead of sequentially.
    const accountsByNetwork = new Map<SocialNetwork, AccountResult[]>();
    const activeNetworks: SocialNetwork[] = [];
    const networkChecks = await Promise.all(
      resolvedTargetNetworks.map(async (network) => {
        const accounts = accountIds?.length
          ? (await Promise.all(accountIds.map((id) => this.accountsService.findById(id)))).filter(
              (account): account is NonNullable<AccountResult> =>
                Boolean(account?.active && account.network === network),
            )
          : (await this.accountsService.findByNetwork(network)).filter(
              (account): account is NonNullable<AccountResult> => Boolean(account?.active),
            );
        if (accounts.length === 0)
          return { network, accounts: [] as AccountResult[], recentCount: 0 };
        const recent = await this.postsService.findBySourceAndNetwork(
          topic.path,
          network,
          Number(this.configService.get<string>("DEDUP_SINCE_DAYS", "14")) || 14,
        );
        return { network, accounts, recentCount: recent.length };
      }),
    );
    for (const check of networkChecks) {
      accountsByNetwork.set(check.network, check.accounts);
      if (check.accounts.length === 0) {
        this.logger.warn(`No active account for ${check.network}`);
      } else if (check.recentCount > 0) {
        this.logger.debug(`Skipping ${check.network} — already posted about ${topic.path}`);
      } else {
        activeNetworks.push(check.network);
      }
    }

    if (activeNetworks.length === 0) {
      this.logger.debug(`No active networks for topic "${topic.topic}" — skipping`);
      return [];
    }

    // Build initial state — graph will fan out to all active networks.
    // M1.3: networks whose primary account has a settings.brandVoice override
    // are split into their own graph invocation so each account's posts sound
    // like that account; the rest share the global brand-voice run.
    const portfolioDispatch = await this.planPortfolioDispatch(
      topic,
      activeNetworks,
      accountsByNetwork,
      humanReview,
    );
    for (const [network, selection] of portfolioDispatch) {
      if (!selection) continue;
      const accounts = (accountsByNetwork.get(network) ?? []).filter(
        (account): account is NonNullable<AccountResult> => Boolean(account),
      );
      const selected = accounts.find((account) => account.id === selection.accountId);
      if (selected) {
        accountsByNetwork.set(network, [
          selected,
          ...accounts.filter((account) => account.id !== selected.id),
        ]);
      }
    }
    const dispatchedNetworks = activeNetworks.filter(
      (network) => !portfolioDispatch.has(network) || portfolioDispatch.get(network) !== null,
    );
    const voiceGroups = await this.groupNetworksByBrandVoice(
      dispatchedNetworks,
      accountsByNetwork,
      brandVoice,
    );
    const authorContexts = await this.resolveAuthorContexts(
      dispatchedNetworks,
      accountsByNetwork,
      topic.topic,
      topic.category,
    );

    const generatedPosts: GeneratedPost[] = [];
    const finalFacts: string[] = [];
    const promptLabelsAcc: Record<string, { label: string; isFallback?: boolean }> = {};

    for (const [effectiveVoice, groupNetworks] of voiceGroups) {
      const initialState = createInitialState(
        topic,
        groupNetworks,
        effectiveVoice,
        humanReview,
        language,
        authorContexts,
      );

      // Invoke the LangGraph workflow with checkpoint
      // thread_id = runId:topic[:group] enables resume after crash (B6 mitigation)
      const config: GraphInvokeConfig = {
        configurable: {
          thread_id:
            voiceGroups.size > 1
              ? `${runId}:${topic.topic}:${groupNetworks.join("-").toLowerCase()}`
              : `${runId}:${topic.topic}`,
        },
        recursionLimit: 50, // P3+P7 added 6 nodes; Q8 judge-retry adds up to 2 supersteps per network
        runName: "generation.workflow",
        signal,
      };

      this.logger.debug(
        `Invoking LangGraph for "${topic.topic}" → ${groupNetworks.join(", ")} (thread: ${config.configurable.thread_id}, voice: ${effectiveVoice === brandVoice ? "global" : "account-override"})`,
      );

      // Langfuse tracing: sessionId=runId groups all LLM calls across topics
      // in the same run. tags + traceMetadata enable filtering in the Langfuse UI.
      // promptNames links this trace to the Langfuse Prompt Management prompts used.
      const { finalState, promptLabels } = await this.tracedGraphInvoke(
        config,
        {
          sessionId: runId,
          tags: ["generation", language, ...groupNetworks.map((n) => n.toLowerCase())],
          traceMetadata: {
            topic: topic.topic,
            runId,
            language,
            networks: groupNetworks.join(","),
            authorContexts: Object.fromEntries(
              groupNetworks.map((network) => {
                const context = authorContexts[network];
                return [
                  network,
                  {
                    accountId: context?.accountId ?? null,
                    personaRevisionId: context?.personaRevisionId ?? null,
                    voiceMode: context?.voiceMode ?? null,
                    source: context?.source ?? "GLOBAL_FALLBACK",
                  },
                ];
              }),
            ),
            promptNames: "research-extract,hook-generation,draft-post,critique-post,refine-post",
          },
        },
        initialState,
        runId,
        model,
      );
      generatedPosts.push(...((finalState as { posts?: GeneratedPost[] }).posts ?? []));
      // P4: Extract facts from final state for thread depth planning
      finalFacts.push(...((finalState as { facts?: string[] }).facts ?? []));
      // Merge per-group prompt labels (later groups win on name collisions —
      // labels are identical across groups unless a per-account Langfuse label
      // overrides them).
      Object.assign(promptLabelsAcc, promptLabels);
    }

    // Save each generated post as DRAFT
    // B5: SimHash dedup — skip near-duplicate posts (Hamming distance ≤ 8)
    const recentHashes = await this.loadRecentPostHashes(topic.topic);
    const editorialAssignmentIds = Object.fromEntries(
      [...portfolioDispatch.entries()]
        .filter((entry): entry is [SocialNetwork, { accountId: string; assignmentId: string }] =>
          Boolean(entry[1]?.assignmentId),
        )
        .map(([network, selection]) => [network, selection.assignmentId]),
    ) as Partial<Record<SocialNetwork, string>>;

    const savedPosts = await this.persistGeneratedPosts(
      generatedPosts,
      accountsByNetwork,
      runId,
      {
        type: topic.sourceType,
        path: topic.path,
        topic: topic.topic,
        keywords: topic.keywords,
        ...(topic.originalPostId ? { originalPostId: topic.originalPostId } : {}),
        ...(topic.originalTopic ? { originalTopic: topic.originalTopic } : {}),
      },
      {
        language,
        recentHashes,
        promptLabels: promptLabelsAcc,
        canonicalUrl: topic.canonicalUrl,
        editorialAssignmentIds,
      },
    );

    // F2/P4: Multi-Stage Posting with Thread Depth Service.
    // Map persisted root posts by network so the continuation loop can reuse them.
    const rootPostsByNetwork = new Map<SocialNetwork, (typeof savedPosts)[0]>();
    for (const post of savedPosts) {
      rootPostsByNetwork.set(post.network, post);
    }

    for (const genPost of generatedPosts) {
      if (!genPost.content) continue;

      const post = rootPostsByNetwork.get(genPost.network);
      if (!post) continue;

      const account = (accountsByNetwork.get(genPost.network) ?? []).find(
        (candidate): candidate is NonNullable<AccountResult> => candidate?.id === post.accountId,
      );
      if (!account) continue;

      if (
        multiStage &&
        (genPost.network === SocialNetwork.X || genPost.network === SocialNetwork.THREADS)
      ) {
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
              const contPosts = await this.prisma.$transaction(
                async (tx) => {
                  const thread = await tx.postThread.create({
                    data: { accountId: account.id, status: PostStatus.DRAFT },
                  });
                  // Link root post to thread and mark it as multi-stage.
                  // F2: root must carry the multiStage flag so the posting worker
                  // can decide whether to post all replies at once (legacy) or
                  // schedule them with a 30-minute delay.
                  await tx.post.update({
                    where: { id: post.id },
                    data: {
                      threadId: thread.id,
                      threadPosition: 0,
                      llmMetadata: {
                        ...(typeof post.llmMetadata === "object" && post.llmMetadata !== null
                          ? post.llmMetadata
                          : {}),
                        multiStage: true,
                        threadDepth: plan.depth,
                      } as Prisma.InputJsonValue,
                    },
                  });
                  // Create continuation posts (same tx client → all-or-nothing)
                  const created: {
                    id: string;
                    network: SocialNetwork;
                    accountId: string;
                    llmMetadata: Prisma.JsonValue;
                  }[] = [];
                  for (const cont of plan.continuations) {
                    created.push({
                      ...(await this.postsService.create(
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
                          llmMetadata: this.buildPostLlmMetadata(
                            genPost,
                            simhash(cont.content),
                            {},
                            {
                              angleType: "continuation",
                              multiStage: true,
                              threadDepth: plan.depth,
                            },
                          ) as Prisma.InputJsonValue,
                        },
                        tx,
                        { emitEvent: false }, // H1: emit after the tx commits, not inside it
                      )),
                      accountId: account.id,
                    });
                  }
                  this.logger.debug(
                    `P4: Created ${plan.continuations.length} continuation posts for ${genPost.network} thread ${thread.id} — ${plan.reasoning}`,
                  );
                  return created;
                },
                {
                  timeout: Number(
                    this.configService.get<string>("PRISMA_TRANSACTION_TIMEOUT_MS", "30000"),
                  ),
                },
              );
              // H1: emit DRAFT_GENERATED only AFTER the tx commits, so the async
              // auto-approve + SSE listeners never read a not-yet-committed row.
              for (const cp of contPosts) {
                this.postsService.emitDraftGenerated(cp.id, genPost.network);
              }
              savedPosts.push(...contPosts);
              for (let i = 0; i < contPosts.length; i++) {
                const cont = plan.continuations[i];
                if (cont) {
                  await this.evaluateOnlineOutput(contPosts[i]!.id, {
                    ...genPost,
                    content: cont.content,
                  });
                  await this.persistPostVariantForContent(
                    contPosts[i]!.id,
                    genPost.network,
                    cont.content,
                    genPost.judgeScores,
                  );
                }
              }
            }
          } catch (err) {
            this.logger.warn(
              `P4: Thread planning failed, falling back to F2: ${(err as Error).message}`,
            );
            await this.fallbackF2Continuation(genPost, post, account, topic, runId, savedPosts);
          }
        } else {
          // F2 fallback: fixed 2-post thread (backward compatibility)
          await this.fallbackF2Continuation(genPost, post, account, topic, runId, savedPosts);
        }
      }
    }

    // 2.8.1: Mark the source topic as used after it has been consumed by the
    // generation graph. This is a no-op for filesystem-backed readers.
    try {
      await this.contentSourceService.markUsed(topic);
    } catch (err) {
      this.logger.debug(`markUsed failed (non-blocking): ${(err as Error).message}`);
    }

    return savedPosts;
  }

  /**
   * F2 fallback: fixed 2-post thread (backward compatibility when P4 is unavailable).
   * Extracted from the original F2 inline block.
   */
  private async fallbackF2Continuation(
    genPost: GeneratedPost,
    post: { id: string; llmMetadata?: Prisma.JsonValue | null },
    account: { id: string },
    topic: ContentTopic,
    runId: string,
    savedPosts: { id: string }[],
  ): Promise<void> {
    // LLM continuation generation runs OUTSIDE the transaction (slow call must
    // not hold a DB tx open). A4: the thread + root link + continuation write
    // are then committed atomically.
    const continuationContent = await this.generateContinuationContent(
      genPost.hook,
      genPost.content,
      topic.topic,
    );
    const continuationPost = await this.prisma.$transaction(
      async (tx) => {
        const thread = await tx.postThread.create({
          data: { accountId: account.id, status: PostStatus.DRAFT },
        });
        // F2: mark root as multi-stage so the posting worker schedules
        // the continuation with a 30-minute delay instead of posting both now.
        await tx.post.update({
          where: { id: post.id },
          data: {
            threadId: thread.id,
            threadPosition: 0,
            llmMetadata: {
              ...(typeof post.llmMetadata === "object" && post.llmMetadata !== null
                ? post.llmMetadata
                : {}),
              multiStage: true,
              threadDepth: 2,
            } as Prisma.InputJsonValue,
          },
        });
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
              keywords: topic.keywords,
            },
            llmMetadata: this.buildPostLlmMetadata(
              genPost,
              simhash(continuationContent),
              {},
              {
                angleType: "continuation",
                multiStage: true,
              },
            ) as Prisma.InputJsonValue,
          },
          tx,
          { emitEvent: false }, // H1: emit after the tx commits, not inside it
        );
        this.logger.debug(
          `F2: Created continuation post for ${genPost.network} thread ${thread.id}`,
        );
        return created;
      },
      { timeout: Number(this.configService.get<string>("PRISMA_TRANSACTION_TIMEOUT_MS", "30000")) },
    );
    // H1: emit DRAFT_GENERATED only AFTER the tx commits.
    this.postsService.emitDraftGenerated(continuationPost.id, genPost.network);
    savedPosts.push(continuationPost);
    await this.persistPostVariantForContent(
      continuationPost.id,
      genPost.network,
      continuationContent,
      genPost.judgeScores,
    );
  }

  /**
   * F2: Generate continuation content for the second post in a multi-stage thread.
   * Uses LLM to create a natural follow-up that references the root post.
   * Falls back to a heuristic if the LLM call fails.
   */
  private async generateContinuationContent(
    hook: string,
    rootContent: string,
    topic: string,
  ): Promise<string> {
    try {
      const brandVoice = await this.loadBrandVoice();
      const systemPrompt = `You are a social media writer for ${this.brandName}, ${this.domainDescription}.
${brandVoice}
Write a short follow-up post (under 280 chars) that continues the conversation from the root post.
Do NOT use "link in bio" — instead tease more content or ask an engaging question.
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
        const lastPeriod = truncated.lastIndexOf(".");
        return truncated.slice(0, lastPeriod > 100 ? lastPeriod + 1 : 277) + "…";
      }
      // Empty response — fall through to heuristic
    } catch (err) {
      this.logger.warn(
        `F2 continuation LLM call failed: ${(err as Error).message} — using heuristic`,
      );
    }

    // Heuristic fallback — no links in posts (text-only per brand voice).
    // P9 compliance: no engagement bait ("share below", "comment", "tag").
    // Close with a value-first CTA (no URL).
    const rootSentence = rootContent.split(".")[0]?.trim() ?? hook;
    return `${rootSentence}.\n\nWhat's your take on ${topic.toLowerCase()}? ✨`;
  }

  private get brandName(): string {
    return this.domainConfig?.brandName ?? "Social Poster Agent";
  }

  private get domainDescription(): string {
    return (
      this.domainConfig?.domainDescription ?? "an AI-assisted multi-network social posting system"
    );
  }

  private get blogBaseUrl(): string {
    return this.domainConfig?.blogBaseUrl ?? "https://example.com";
  }

  private async loadBrandVoice(): Promise<string> {
    if (this.brandVoice) return this.brandVoice;
    this.brandVoice = this.domainConfig
      ? await this.domainConfig.getBrandVoice()
      : "Be specific, opinionated, and human. No fear-mongering, no absolute predictions, no medical/financial advice, no engagement bait. No hashtags or URLs in posts.";
    return this.brandVoice;
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
   * INTEL-101 / F22: Fetch trending topics (Google Trends + X + domain calendar) and
   * convert them to ContentTopic format so they can be used by the generation
   * graph alongside content-source topics.
   *
   * Returns an empty array when trending scraping is disabled or fails.
   */
  private async fetchTrendingAsContentTopics(limit: number): Promise<ContentTopic[]> {
    if (!this.trendingScraper) return [];

    // Get domain calendar trending topics from TrendingService (if available)
    const calendarTopics: Array<{ topic: string; networks: string[] }> = [];
    if (this.trendingService) {
      try {
        const trending = this.trendingService.getTrendingTopics();
        for (const t of trending) {
          if (t.trending) {
            calendarTopics.push({ topic: t.topic, networks: t.networks });
          }
        }
      } catch {
        // Domain calendar trending is optional
      }
    }

    // Get merged trending (domain calendar + Google Trends + X)
    const skipXInDryRun = parseBool(this.configService.get<string>("SPA_DRY_RUN", "false"));
    const merged = await this.trendingScraper.getMergedTrending(calendarTopics, {
      includeX: !skipXInDryRun,
    });

    // Convert to ContentTopic format
    return merged.slice(0, limit).map((t) => {
      // Include topic slug in path so dedup is per-topic, not per-source
      // (otherwise all Google Trends topics share "trending/google_trends" and
      // only the first one ever gets posted)
      const slug = t.topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 50);
      return {
        sourceType: "topic" as const,
        path: `trending/${t.sources.join("+")}/${slug}`,
        topic: t.topic,
        keywords: t.sources, // use sources as keywords for LLM context
        facts: [],
        category: "trending",
        publishedAt: t.scrapedAt ?? new Date(),
        language: "en",
      };
    });
  }

  private prioritizeTopics(topics: ContentTopic[], count: number): ContentTopic[] {
    // A6: pure sort + round-robin lives in topic-prioritization.ts; the wrapper
    // keeps the B5 debug log.
    const result = prioritizeTopicsByFreshness(topics, count);
    this.logger.debug(
      `B5: Prioritized ${result.length}/${topics.length} topics — ` +
        `categories: ${result.map((t) => t.category ?? "uncategorized").join(", ")}`,
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
      (t) => t.sourceType !== "topic" || !t.path.startsWith("trending/"),
    );
    const trending = topics.filter(
      (t) => t.sourceType === "topic" && t.path.startsWith("trending/"),
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
            this.logger.warn(`P5: Rejected trending topic "${topic.topic}" — ${result.reason}`);
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

    this.logger.debug(
      `Loaded ${hashes.length} recent post hashes for dedup (topic: "${currentTopic}")`,
    );
    return hashes;
  }

  private async markRunCompleted(
    runId: string,
    topics: string[],
    errorMessage?: string,
  ): Promise<void> {
    await this.runLifecycle.markCompleted(runId, topics, errorMessage);
  }

  /**
   * List generation runs (most recent first).
   * Dates are converted to ISO strings for proper JSON serialization.
   */
  async listRuns(limit = 20) {
    const runs = await this.prisma.generationRun.findMany({
      orderBy: { startedAt: "desc" },
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
          orderBy: { createdAt: "asc" },
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
    const result = await this.runLifecycle.pause(runId);
    this.logger.log(`Generation run ${runId} paused`);
    return result;
  }

  /**
   * Resume an interrupted generation run from the last checkpoint.
   * Loads the run, re-fetches topics, and re-invokes the graph with the same thread_ids.
   * LangGraph's checkpoint saver will skip already-completed nodes.
   *
   * Includes SimHash dedup (B5) and SSE progress events for UI consistency.
   */
  async resumeRun(runId: string): Promise<{ runId: string; status: string }> {
    const run = await this.runLifecycle.prepareResume(runId);

    // Re-fetch topics from sourceTopics stored in the run
    const sourceTopics = (run.sourceTopics as string[]) ?? [];
    if (sourceTopics.length === 0) {
      // No topics stored — can't resume from checkpoint, mark as failed
      this.logger.warn(`Run ${runId} has no stored sourceTopics — cannot resume`);
      await this.markRunCompleted(runId, [], "Cannot resume: no sourceTopics stored");
      return { runId, status: "failed" };
    }

    // Get all topics and filter to the ones in this run
    const allTopics = await this.contentSourceService.getTopics(sourceTopics.length * 3);
    const topics = allTopics.filter((t) => sourceTopics.includes(t.topic));

    if (topics.length === 0) {
      await this.markRunCompleted(runId, sourceTopics, "No topics found for resume");
      return { runId, status: "completed" };
    }

    const brandVoice = await this.loadBrandVoice();
    const targetNetworks = this.resolveTargetNetworks();
    const controller = this.runLifecycle.register(runId);

    // Resume in background — don't block the API response
    void (async () => {
      const postIds: string[] = [];
      // Pre-load accounts for all target networks once, then reuse in the loop.
      const accountByNetwork = new Map<SocialNetwork, AccountResult>();
      await Promise.all(
        targetNetworks.map(async (network) => {
          const account = await this.accountsService.getNextAccountForNetwork(network);
          accountByNetwork.set(network, account);
        }),
      );
      try {
        for (const topic of topics) {
          if (controller.signal.aborted) break;
          try {
            // Same thread_id as original — LangGraph will resume from checkpoint
            const config: GraphInvokeConfig = {
              configurable: { thread_id: `${runId}:${topic.topic}` },
              recursionLimit: 30, // Q8: judge-retry can add up to 2 supersteps per network
              runName: "generation.workflow",
              signal: controller.signal,
            };
            const initialState = createInitialState(topic, targetNetworks, brandVoice);
            // Langfuse tracing for resume — same sessionId as original run
            const { finalState, promptLabels } = await this.tracedGraphInvoke(
              config,
              {
                sessionId: runId,
                tags: ["generation", "resume"],
                traceMetadata: { topic: topic.topic, runId, mode: "resume" },
              },
              initialState,
              runId,
            );
            const generatedPosts = (finalState as { posts?: GeneratedPost[] }).posts ?? [];

            // B5: SimHash dedup — load recent hashes and skip near-duplicates
            const recentHashes = await this.loadRecentPostHashes(topic.topic);
            const savedPosts = await this.persistGeneratedPosts(
              generatedPosts,
              accountByNetwork,
              runId,
              {
                type: topic.sourceType,
                path: topic.path,
                topic: topic.topic,
                keywords: topic.keywords,
              },
              { recentHashes, promptLabels },
            );
            postIds.push(...savedPosts.map((p) => p.id));
          } catch (err) {
            this.logger.error(
              `Resume failed for topic "${topic.topic}": ${(err as Error).message}`,
            );
          }
        }
        await this.markRunCompleted(
          runId,
          topics.map((t) => t.topic),
        );
        this.runLifecycle.remove(runId);
        await this.sseService.publish({
          type: "generation_completed",
          runId,
          postCount: postIds.length,
        });
      } catch (outerErr) {
        // Outer error handler — ensures run is never stuck in RUNNING forever
        this.logger.error(
          `Resume run ${runId} failed unexpectedly: ${(outerErr as Error).message}`,
        );
        this.runLifecycle.remove(runId);
        await this.runLifecycle.markFailed(runId, `Resume failed: ${(outerErr as Error).message}`);
      }
    })();

    return { runId, status: "resumed" };
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
    return this.reviewResumeService.resume(
      runId,
      topic,
      approved,
      edits,
      (config, command, context) =>
        this.tracedGraphInvoke(
          config,
          {
            sessionId: context.runId,
            tags: ["generation", "review-resume"],
            traceMetadata: {
              topic: context.topic,
              runId: context.runId,
              mode: "review-resume",
              approved: context.approved,
            },
          },
          command,
          context.runId,
        ),
      (reviewTopic) => this.loadRecentPostHashes(reviewTopic),
    );
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
