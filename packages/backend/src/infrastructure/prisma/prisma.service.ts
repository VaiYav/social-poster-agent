import { Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

function buildPrismaUrl(): string | undefined {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return undefined;

  const connectionLimit = process.env.PRISMA_CONNECTION_LIMIT ?? '20';
  const poolTimeoutMs = process.env.PRISMA_POOL_TIMEOUT_MS ?? '30000';

  const url = new URL(rawUrl);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', connectionLimit);
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', String(Math.floor(Number(poolTimeoutMs) / 1000)));
  }
  return url.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['warn', 'error'],
      datasourceUrl: buildPrismaUrl(),
      transactionOptions: {
        maxWait: 5000,
        timeout: Number(process.env.PRISMA_TRANSACTION_TIMEOUT_MS ?? '30000'),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
