import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { GenerationService } from "../generation/generation.service.js";
import { IContentPort, type IContentPort as ContentPort } from "../../domain/ports/content.port.js";
import { AccountsService } from "../accounts/accounts.service.js";
import { PostsService } from "../posts/posts.service.js";
import { ContentType, PostStatus, SocialNetwork } from "../../generated/prisma/client.js";

/**
 * ArticleGenerationCron — triggers article generation on a weekly schedule.
 *
 * Dynamic registration via SchedulerRegistry.addCronJob() in onModuleInit()
 * (same pattern as all other cron services post-refactor).
 *
 * Schedule: CRON_ARTICLE_GENERATION_SCHEDULE (default: `0 9 * * 1` — Monday 9am).
 *
 * This cron is only registered when SYNDICATION_ENABLED=true (the
 * SyndicationModule that provides this service is only imported when the
 * flag is on). No need to check the flag here — the module won't be loaded.
 *
 * Generation remains a draft-only operation; approval is the side-effect gate.
 */
@Injectable()
export class ArticleGenerationCron implements OnModuleInit {
  private readonly logger = new Logger(ArticleGenerationCron.name);

  constructor(
    private readonly generationService: GenerationService,
    @Inject(IContentPort) private readonly contentPort: ContentPort,
    private readonly accountsService: AccountsService,
    private readonly postsService: PostsService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const cronExpr =
      this.configService?.get<string>("CRON_ARTICLE_GENERATION_SCHEDULE", "0 9 * * 1") ??
      "0 9 * * 1";

    const job = new CronJob(cronExpr, async () => {
      await this.handleArticleGeneration();
    });

    try {
      this.schedulerRegistry?.addCronJob("article-generation", job);
      job.start();
      this.logger.log(`Cron job "article-generation" registered with schedule: ${cronExpr}`);
    } catch {
      this.logger.warn("SchedulerRegistry not available — article cron will not run");
    }
  }

  /**
   * Handle the article generation cron trigger.
   * Generate configured topics and persist one reviewable draft per target network.
   */
  async handleArticleGeneration(): Promise<void> {
    this.logger.log("Article generation cron triggered");
    try {
      const topics = await this.contentPort.getTopics(5);
      const networks = this.configuredNetworks();
      if (topics.length === 0 || networks.length === 0) return;

      for (const topic of topics) {
        if (!topic.topic.trim()) continue;
        const state = await this.generationService.generateArticle({
          topic: topic.topic,
          keywords: topic.keywords,
          language: "en",
          targetNetworks: networks,
        });
        const article = state.finalArticle ?? state.draft;
        if (!article || state.error) {
          this.logger.warn(`Article generation produced no draft for "${topic.topic}"`);
          continue;
        }
        const canonicalUrl = state.canonicalUrl ?? topic.canonicalUrl ?? null;
        let persisted = false;
        for (const network of networks) {
          const account = await this.accountsService.getNextAccountForNetwork(network);
          if (!account) continue;
          await this.postsService.create({
            accountId: account.id,
            network,
            language: "en",
            content: JSON.stringify(article),
            contentType: ContentType.ARTICLE,
            status: PostStatus.DRAFT,
            canonicalUrl,
            sourceRef: {
              type: topic.sourceType,
              path: topic.path,
              topic: topic.topic,
              keywords: topic.keywords,
              canonicalUrl,
            },
            llmMetadata: {
              article: true,
              judgeScores: state.judgeScores,
              judgeRetried: state.judgeRetried,
              runId: state.runId,
            },
            ...(state.judgeScores ? { judgeScores: state.judgeScores } : {}),
            judgeRetried: state.judgeRetried,
          });
          persisted = true;
        }
        if (persisted) await this.contentPort.markUsed(topic);
      }
    } catch (error) {
      this.logger.error(
        `Article generation cron failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private configuredNetworks(): SocialNetwork[] {
    const raw = this.configService.get<string>("SYNDICATION_NETWORKS", "DEVTO");
    const allowed = new Set<SocialNetwork>([
      SocialNetwork.DEVTO,
      SocialNetwork.HASHNODE,
      SocialNetwork.LINKEDIN,
    ]);
    return [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()))].filter(
      (value): value is SocialNetwork => allowed.has(value as SocialNetwork),
    );
  }
}
