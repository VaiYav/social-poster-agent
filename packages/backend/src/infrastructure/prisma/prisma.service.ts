import { Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

function buildPrismaUrl(configService: ConfigService): string | undefined {
  const rawUrl = configService.get<string>('DATABASE_URL');
  if (!rawUrl) return undefined;

  const connectionLimit = configService.get<string>('PRISMA_CONNECTION_LIMIT', '20');
  const poolTimeoutMs = configService.get<string>('PRISMA_POOL_TIMEOUT_MS', '30000');

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

  private readonly slowQueryThresholdMs: number;

  constructor(private readonly configService: ConfigService) {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
      datasourceUrl: buildPrismaUrl(configService),
      transactionOptions: {
        maxWait: 5000,
        timeout: Number(configService.get<string>('PRISMA_TRANSACTION_TIMEOUT_MS', '30000')),
      },
    });
    const parsedThreshold = Number(configService.get<string>('SLOW_QUERY_THRESHOLD_MS', '500'));
    this.slowQueryThresholdMs = Number.isFinite(parsedThreshold) ? parsedThreshold : 500;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.attachSlowQueryLogger();
    this.logger.log('Prisma connected to PostgreSQL');
  }

  private attachSlowQueryLogger(): void {
    if (this.slowQueryThresholdMs <= 0) return;
    (this as any).$on('query', (event: Prisma.QueryEvent) => {
      if (event.duration >= this.slowQueryThresholdMs) {
        this.logger.warn(
          `Slow query (${event.duration}ms >= ${this.slowQueryThresholdMs}ms): ${event.query}`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
