import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { GenerationService } from '../generation/generation.service.js';

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
 * Phase 0: skeleton — calls GenerationService.generateArticle() which is
 * a stub (article graph has stub nodes). Phase 1: real article generation.
 */
@Injectable()
export class ArticleGenerationCron implements OnModuleInit {
  private readonly logger = new Logger(ArticleGenerationCron.name);

  constructor(
    private readonly generationService: GenerationService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const cronExpr =
      this.configService?.get<string>('CRON_ARTICLE_GENERATION_SCHEDULE', '0 9 * * 1') ??
      '0 9 * * 1';

    const job = new CronJob(cronExpr, async () => {
      await this.handleArticleGeneration();
    });

    try {
      this.schedulerRegistry?.addCronJob('article-generation', job);
      job.start();
      this.logger.log(`Cron job "article-generation" registered with schedule: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — article cron will not run');
    }
  }

  /**
   * Handle the article generation cron trigger.
   * Phase 0: logs the trigger (article graph is stubbed).
   * Phase 1: calls GenerationService.generateArticle() with topics from content source.
   */
  async handleArticleGeneration(): Promise<void> {
    this.logger.log('Article generation cron triggered');
    try {
      // Phase 1: fetch topics from content source, call generateArticle() for each
      // const topics = await this.contentReader.getArticleTopics();
      // for (const topic of topics) {
      //   await this.generationService.generateArticle({ topic, ... });
      // }
      this.logger.log('Article generation cron — Phase 0 stub (no articles generated yet)');
    } catch (error) {
      this.logger.error(
        `Article generation cron failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
