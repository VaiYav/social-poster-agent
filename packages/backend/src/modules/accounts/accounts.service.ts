import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SocialNetwork } from '@prisma/client';
import { WarmupService } from '../sessions/warmup.service.js';
import { parseBool } from '../../infrastructure/config/parse-bool';

/**
 * Accounts service — manages social account records.
 * Credentials are NEVER stored in DB — only credentialsRef (env var name).
 * On startup, seeds accounts from env config if they don't exist.
 *
 * F20: If SOCIAL_{NETWORK}_WARMUP=true is set for a new account, warm-up
 * mode is started on seed (browse-only → gradual ramp, reduces ban risk).
 */
@Injectable()
export class AccountsService implements OnModuleInit {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly warmupService?: WarmupService,
  ) {}

  /**
   * Minor-29: Seed accounts from env on module init (moved from CronService).
   * This is the right place — AccountsService owns account lifecycle.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedFromEnv();
      this.logger.log('Accounts seeded from env');
    } catch {
      this.logger.warn('Failed to seed accounts — continuing');
    }
  }

  /**
   * Seed accounts from env on application startup.
   * Creates accounts if they don't exist, does not update existing.
   * F20: If SOCIAL_{NETWORK}_WARMUP=true, starts warm-up for the new account.
   */
  async seedFromEnv(): Promise<void> {
    const accounts = [
      {
        network: SocialNetwork.X,
        handle: this.configService.get<string>('SOCIAL_X_USERNAME', 'myzodiacai'),
        credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
        warmup: parseBool(this.configService.get<string>('SOCIAL_X_WARMUP', 'false')),
      },
      {
        network: SocialNetwork.THREADS,
        handle: this.configService.get<string>('SOCIAL_THREADS_USERNAME', 'myzodiacai'),
        credentialsRef: 'SOCIAL_THREADS_USERNAME/PASSWORD',
        warmup: parseBool(this.configService.get<string>('SOCIAL_THREADS_WARMUP', 'false')),
      },
      {
        network: SocialNetwork.FACEBOOK,
        handle: this.configService.get<string>('SOCIAL_FACEBOOK_EMAIL', 'myzodiacai@facebook.com'),
        credentialsRef: 'SOCIAL_FACEBOOK_EMAIL/PASSWORD',
        warmup: parseBool(this.configService.get<string>('SOCIAL_FACEBOOK_WARMUP', 'false')),
      },
    ];

    for (const account of accounts) {
      const existing = await this.prisma.socialAccount.findFirst({
        where: { network: account.network, handle: account.handle },
      });
      if (!existing) {
        const created = await this.prisma.socialAccount.create({
          data: {
            network: account.network,
            handle: account.handle,
            credentialsRef: account.credentialsRef,
          },
        });
        this.logger.log(`Seeded account: ${account.network} @${account.handle}`);

        // F20: Start warm-up if requested for this new account
        if (account.warmup && this.warmupService) {
          await this.warmupService.startWarmup(created.id);
          this.logger.log(`Warm-up started for ${account.network} @${account.handle}`);
        }
      }
    }
  }

  async findAll() {
    return this.prisma.socialAccount.findMany({
      where: { active: true },
      include: { sessions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  }

  async findByNetwork(network: SocialNetwork) {
    return this.prisma.socialAccount.findFirst({
      where: { network, active: true },
    });
  }

  /**
   * Get credentials from env (never from DB).
   */
  getCredentials(network: SocialNetwork): { username: string; password: string; extra?: string } {
    switch (network) {
      case SocialNetwork.X:
        return {
          username: this.configService.get<string>('SOCIAL_X_USERNAME', ''),
          password: this.configService.get<string>('SOCIAL_X_PASSWORD', ''),
        };
      case SocialNetwork.THREADS:
        return {
          username: this.configService.get<string>('SOCIAL_THREADS_USERNAME', ''),
          password: this.configService.get<string>('SOCIAL_THREADS_PASSWORD', ''),
        };
      case SocialNetwork.FACEBOOK:
        return {
          username: this.configService.get<string>('SOCIAL_FACEBOOK_EMAIL', ''),
          password: this.configService.get<string>('SOCIAL_FACEBOOK_PASSWORD', ''),
          extra: this.configService.get<string>('SOCIAL_FACEBOOK_PAGE_SLUG', ''),
        };
    }
  }
}
