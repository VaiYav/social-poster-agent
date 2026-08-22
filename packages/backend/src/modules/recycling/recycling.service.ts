/**
 * Sprint O / F13: Content Recycling Service — refresh old top-performing posts.
 *
 * Identifies posts that performed well (posted >30 days ago) and creates
 * new draft variants with updated angles/hooks. Avoids exact duplicates via SimHash.
 */
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { PostStatus } from "../../generated/prisma/client";
import { simhash, isDuplicateAgainstCorpus } from "../generation/simhash.js";
import { GenerationService } from "../generation/generation.service.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { isOrchestratorEnabled } from "../orchestrator/feature-flag.js";

@Injectable()
export class RecyclingService implements OnModuleInit {
  private readonly logger = new Logger(RecyclingService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    // RC3: recycling re-writes content through the generation graph (no verbatim copies).
    private readonly generationService: GenerationService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Find posts eligible for recycling — posted >30 days ago, not yet recycled.
   */
  async findRecyclablePosts(
    limit = 10,
  ): Promise<{ id: string; network: string; content: string; postedAt: Date | null }[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postedAt: { lt: thirtyDaysAgo },
        // Check llmMetadata for recycled flag
        llmMetadata: { path: ["recycled"], not: true },
      },
      orderBy: { postedAt: "desc" },
      take: limit * 2, // get more than needed, filter by simhash
      select: {
        id: true,
        network: true,
        content: true,
        postedAt: true,
        accountId: true,
        sourceRef: true,
      },
    });

    // Filter out posts that are too similar to recent posts
    // 2.8.4: Use the same SimHash threshold as GenerationService (isDuplicateAgainstCorpus).
    const recentHashes = await this.loadRecentHashes();
    const recyclable = posts.filter(
      (post) => !isDuplicateAgainstCorpus(post.content, recentHashes),
    );

    return recyclable.slice(0, limit);
  }

  /**
   * RC3: recycle one post by id. Delegates to the generation graph so the new draft is a
   * genuinely re-written variant — NEVER a verbatim copy of the 30-day-old original (the
   * old implementation copied content verbatim and "will be re-written by the pipeline" —
   * but nothing rewrote it, so an approved recycled draft was an exact duplicate that
   * bypassed SimHash).
   */
  async recyclePost(postId: string): Promise<{ id: string; status: string } | null> {
    return this.generationService.recycleById(postId);
  }

  /**
   * Run recycling for all eligible posts.
   */
  async runRecycling(limit = 5): Promise<{ recycled: number; skipped: number }> {
    this.logger.log(`Running content recycling (limit: ${limit})...`);

    const candidates = await this.findRecyclablePosts(limit);

    let recycled = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        const result = await this.recyclePost(candidate.id);
        if (result) {
          recycled++;
        } else {
          skipped++;
        }
      } catch (err) {
        this.logger.error(`Failed to recycle post ${candidate.id}: ${(err as Error).message}`);
        skipped++;
      }
    }

    this.logger.log(`Recycling complete: ${recycled} recycled, ${skipped} skipped`);
    return { recycled, skipped };
  }

  /**
   * F13: expose cron configuration so the UI can show whether scheduled recycling is on.
   */
  getCronConfig(): { enabled: boolean; schedule: string } {
    return {
      enabled: parseBool(this.configService.get<string>("RECYCLING_CRON_ENABLED", "false")),
      schedule: this.configService.get<string>("RECYCLING_CRON_SCHEDULE", "0 8 * * 1"),
    };
  }

  /**
   * RC2: recycling never ran automatically — there was no scheduler, only a manual endpoint.
   * Flag-gated cron (default OFF, like the other autonomy features) so enabling auto-recycling
   * is an explicit opt-in. NOTE: until metrics land (AN1), candidate selection is by age, not
   * by real performance — recycled drafts still require approval (auto-approve is separate).
   *
   * Dynamically registered (not @Cron) so it is NOT created when orchestrator is enabled.
   */
  onModuleInit(): void {
    if (isOrchestratorEnabled()) {
      this.logger.log("Orchestrator is enabled — recycling cron NOT registered");
      return;
    }
    if (!parseBool(this.configService.get<string>("RECYCLING_CRON_ENABLED", "false"))) {
      return;
    }

    const cronExpr = this.configService.get<string>("RECYCLING_CRON_SCHEDULE", "0 8 * * 1");
    const job = new CronJob(cronExpr, async () => {
      this.logger.log("RC2: scheduled recycling run starting");
      await this.runRecycling();
    });
    try {
      this.schedulerRegistry.addCronJob("recycling", job);
      job.start();
      this.logger.log(`Recycling cron registered: ${cronExpr}`);
    } catch {
      this.logger.warn("SchedulerRegistry not available — recycling cron will not run");
    }
  }

  private async loadRecentHashes(): Promise<string[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentPosts = await this.prisma.post.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      select: { content: true, simhash: true },
      take: 100,
    });

    return recentPosts.map((p) => p.simhash ?? simhash(p.content));
  }
}
