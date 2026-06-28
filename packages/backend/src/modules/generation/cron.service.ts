import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { GenerationService } from './generation.service';
import { AccountsService } from '../accounts/accounts.service';
import { GenerationTrigger } from '@prisma/client';

/**
 * Cron service — triggers generation on schedule.
 *
 * B4 fix: cron expression is env-configurable via CRON_GENERATION_SCHEDULE.
 * Default: 2x/day at 9:00 and 21:00 (0 9,21 * * *).
 *
 * Uses SchedulerRegistry.addCronJob() instead of @Cron() decorator
 * because @Cron() requires a static expression at decoration time.
 */
@Injectable()
export class CronService implements OnModuleInit {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly generationService: GenerationService,
    private readonly accountsService: AccountsService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    // Minor-29: seedFromEnv moved to AccountsService.onModuleInit

    // SPA_DRY_RUN: skip cron registration in dry-run mode
    const isDryRun = this.configService?.get<string>('SPA_DRY_RUN', 'false') === 'true';
    if (isDryRun) {
      this.logger.warn('SPA_DRY_RUN=true — cron jobs NOT registered');
      return;
    }

    // B4: Register dynamic cron job from env
    const cronExpr = this.configService?.get<string>(
      'CRON_GENERATION_SCHEDULE',
      '0 9,21 * * *',
    ) ?? '0 9,21 * * *';

    const job = new CronJob(cronExpr, async () => { await this.handleCronGeneration(); });
    try {
      this.schedulerRegistry?.addCronJob('generation', job);
      job.start();
      this.logger.log(`Cron job "generation" registered with schedule: ${cronExpr}`);
    } catch {
      this.logger.warn('SchedulerRegistry not available — cron job will not run');
    }
  }

  async handleCronGeneration(): Promise<void> {
    this.logger.log('Cron generation triggered');
    try {
      const runId = await this.generationService.generate(
        3, // 3 topics per run
        undefined, // all networks
        GenerationTrigger.CRON,
      );
      this.logger.log(`Cron generation completed: run ${runId}`);
    } catch (err) {
      this.logger.error(`Cron generation failed: ${(err as Error).message}`);
    }
  }
}
