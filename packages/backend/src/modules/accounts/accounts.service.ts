import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SocialNetwork } from '@prisma/client';

/**
 * Accounts service — manages social account records.
 * Credentials are NEVER stored in DB — only credentialsRef (env var name).
 * On startup, seeds accounts from env config if they don't exist.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Seed accounts from env on application startup.
   * Creates accounts if they don't exist, does not update existing.
   */
  async seedFromEnv(): Promise<void> {
    const accounts = [
      {
        network: SocialNetwork.X,
        handle: this.configService.get<string>('SOCIAL_X_USERNAME', 'myzodiacai'),
        credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
      },
      {
        network: SocialNetwork.THREADS,
        handle: this.configService.get<string>('SOCIAL_THREADS_USERNAME', 'myzodiacai'),
        credentialsRef: 'SOCIAL_THREADS_USERNAME/PASSWORD',
      },
      {
        network: SocialNetwork.FACEBOOK,
        handle: this.configService.get<string>('SOCIAL_FACEBOOK_EMAIL', 'myzodiacai@facebook.com'),
        credentialsRef: 'SOCIAL_FACEBOOK_EMAIL/PASSWORD',
      },
    ];

    for (const account of accounts) {
      const existing = await this.prisma.socialAccount.findFirst({
        where: { network: account.network, handle: account.handle },
      });
      if (!existing) {
        await this.prisma.socialAccount.create({ data: account });
        this.logger.log(`Seeded account: ${account.network} @${account.handle}`);
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
