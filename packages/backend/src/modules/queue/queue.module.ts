import { Module, type OnModuleInit, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { QueueFactory } from '../../infrastructure/queue/queue.factory';
import { PostingModule } from '../posting/posting.module';
import { PostingService } from '../posting/posting.service';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { SocialNetwork } from '@prisma/client';
import { parseBool } from '../../infrastructure/config/parse-bool';
import { getEnabledNetworks } from '../../domain/enabled-networks.js';

/**
 * Queue module — wires BullMQ workers to PostingService and BrowsingSessionService.
 *
 * On bootstrap, registers:
 * 1. A posting worker per network (X, THREADS, FACEBOOK) — calls PostingService.postById()
 * 2. An engagement worker per network — calls BrowsingSessionService.runBrowsingSession()
 *
 * Both use concurrency=1 per network queue (B9 mitigation — no parallel actions to same network).
 * Engagement worker is registered lazily via ModuleRef to avoid circular dependency
 * (QueueModule → EngagementModule → QueueModule).
 */
@Module({
  imports: [QueueInfraModule, PostingModule],
  providers: [QueueService, QueueController],
  controllers: [QueueController],
  exports: [QueueService, QueueInfraModule],
})
export class QueueModule implements OnModuleInit {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    private readonly queueFactory: QueueFactory,
    private readonly postingService: PostingService,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    // SPA_DRY_RUN: skip worker registration in dry-run mode — the dry-run runner
    // calls postById() directly to avoid race conditions with BullMQ workers
    // that would start posting before the browser session is established.
    const isDryRun = parseBool(this.configService.get<string>('SPA_DRY_RUN', 'false'));
    if (isDryRun) {
      this.logger.warn('SPA_DRY_RUN=true — BullMQ workers NOT registered (dry-run runner controls flow)');
      return;
    }

    // Register posting workers (one per enabled network)
    for (const network of getEnabledNetworks()) {
      this.queueFactory.registerWorker(network, async (job) => {
        const { postId } = job.data as { postId: string };
        const result = await this.postingService.postById(postId);
        if (!result.success) {
          // retryable === false means postById already resolved the post to a terminal
          // state (e.g. network disabled) — retrying can never succeed, so resolve the
          // job instead of burning the full retry budget on a guaranteed repeat failure.
          if (result.retryable === false) {
            this.logger.warn(`Post ${postId} failed permanently (non-retryable): ${result.error}`);
            return;
          }
          throw new Error(result.error ?? 'Posting failed');
        }
      });
    }

    // Register engagement workers (one per enabled network) — lazily resolve BrowsingSessionService
    // to avoid circular dependency: QueueModule → EngagementModule → QueueModule
    for (const network of getEnabledNetworks()) {
      this.queueFactory.registerWorker(
        network,
        async (job) => {
          this.logger.log(
            `Engagement worker received job ${job.id} for ${network}: ${JSON.stringify(job.data)}`,
          );
          const { action, network: jobNetwork } = job.data as {
            action: string;
            network: string;
            durationSec?: number;
            commentDbId?: string;
            commentId?: string;
            postId?: string;
            postUrl?: string;
            replyText?: string;
          };
          if (action === 'browsing-session') {
            // Lazily import to avoid circular dependency at module load time
            const { BrowsingSessionService } = await import(
              '../engagement/browsing-session.service.js'
            );
            // moduleRef.get(..., { strict: false }) throws UnknownElementException rather than
            // returning undefined when the provider isn't registered ANYWHERE in the app (as
            // opposed to merely out of the current module's scope) — which is exactly what
            // happens when ENGAGEMENT_ENABLED=false excludes EngagementModule entirely. Without
            // this try/catch, leftover BullMQ delayed jobs enqueued before the flag was flipped
            // off crash the worker on every delivery instead of hitting the intended skip below.
            let browsingService: InstanceType<typeof BrowsingSessionService> | undefined;
            try {
              browsingService = this.moduleRef.get(BrowsingSessionService, { strict: false });
            } catch {
              browsingService = undefined;
            }
            if (browsingService) {
              await browsingService.runBrowsingSession(
                jobNetwork as SocialNetwork,
                job.data?.durationSec,
              );
            } else {
              this.logger.warn(
                `BrowsingSessionService not available — engagement job ${job.id} skipped`,
              );
            }
          } else if (action === 'reply') {
            // RP1: delayed auto-reply job. Lazily resolve RepliesMonitorService (absent
            // unless REPLIES_ENABLED) to avoid a static import cycle. Throwing on failure
            // lets BullMQ retry + DLQ-alert via the shared worker 'failed' handler.
            const { RepliesMonitorService } = await import(
              '../replies/replies-monitor.service.js'
            );
            // Same UnknownElementException issue as the browsing-session branch above.
            let repliesMonitor: InstanceType<typeof RepliesMonitorService> | undefined;
            try {
              repliesMonitor = this.moduleRef.get(RepliesMonitorService, { strict: false });
            } catch {
              repliesMonitor = undefined;
            }
            if (repliesMonitor && job.data?.commentDbId && job.data?.postUrl && job.data?.replyText) {
              await repliesMonitor.postScheduledReply({
                commentDbId: job.data.commentDbId,
                commentId: job.data.commentId ?? String(job.id),
                postId: job.data.postId ?? '',
                network: jobNetwork,
                postUrl: job.data.postUrl,
                replyText: job.data.replyText,
              });
            } else {
              this.logger.warn(
                `RepliesMonitorService unavailable or reply job ${job.id} malformed — skipped`,
              );
            }
          } else if (
            action === 'like' ||
            action === 'comment' ||
            action === 'follow' ||
            action === 'repost' ||
            action === 'quote'
          ) {
            // Individual engagement actions. Lazily resolve EngagementService to avoid
            // a static import cycle with EngagementModule.
            const { EngagementService } = await import(
              '../engagement/engagement.service.js'
            );
            let engagementService: InstanceType<typeof EngagementService> | undefined;
            try {
              engagementService = this.moduleRef.get(EngagementService, { strict: false });
            } catch {
              engagementService = undefined;
            }
            if (!engagementService) {
              this.logger.warn(
                `EngagementService unavailable — ${action} job ${job.id} skipped`,
              );
              return;
            }
            switch (action) {
              case 'like': {
                if (job.data?.postUrl) {
                  await engagementService.like(jobNetwork as SocialNetwork, job.data.postUrl as string);
                }
                break;
              }
              case 'comment': {
                if (job.data?.postUrl && job.data?.text) {
                  await engagementService.comment(
                    jobNetwork as SocialNetwork,
                    job.data.postUrl as string,
                    job.data.text as string,
                  );
                }
                break;
              }
              case 'follow': {
                if (job.data?.handleOrUrl) {
                  await engagementService.follow(
                    jobNetwork as SocialNetwork,
                    job.data.handleOrUrl as string,
                  );
                }
                break;
              }
              case 'repost': {
                if (job.data?.postUrl) {
                  await engagementService.repost(jobNetwork as SocialNetwork, job.data.postUrl as string);
                }
                break;
              }
              case 'quote': {
                if (job.data?.postUrl && job.data?.text) {
                  await engagementService.quote(
                    jobNetwork as SocialNetwork,
                    job.data.postUrl as string,
                    job.data.text as string,
                  );
                }
                break;
              }
            }
          }
        },
        'engagement',
      );
    }
  }
}
