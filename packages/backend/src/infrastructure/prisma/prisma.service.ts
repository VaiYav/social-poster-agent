import { Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client.js";

function buildPrismaUrl(configService: ConfigService): string | undefined {
  const rawUrl = configService.get<string>("DATABASE_URL") ?? process.env.DATABASE_URL;
  if (!rawUrl) return undefined;

  const connectionLimit = configService.get<string>("PRISMA_CONNECTION_LIMIT", "20");
  const poolTimeoutMs = configService.get<string>("PRISMA_POOL_TIMEOUT_MS", "30000");

  const url = new URL(rawUrl);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", connectionLimit);
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(Math.floor(Number(poolTimeoutMs) / 1000)));
  }
  return url.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  private readonly slowQueryThresholdMs: number;

  constructor(private readonly configService: ConfigService) {
    const url = buildPrismaUrl(configService);
    if (!url) {
      throw new Error("DATABASE_URL is not configured");
    }
    super({
      log: [
        { emit: "event", level: "query" },
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
      adapter: new PrismaPg({ connectionString: url }),
      transactionOptions: {
        maxWait: 5000,
        timeout: Number(configService.get<string>("PRISMA_TRANSACTION_TIMEOUT_MS", "30000")),
      },
    });
    const parsedThreshold = Number(configService.get<string>("SLOW_QUERY_THRESHOLD_MS", "500"));
    this.slowQueryThresholdMs = Number.isFinite(parsedThreshold) ? parsedThreshold : 500;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.attachSlowQueryLogger();
    this.logger.log("Prisma connected to PostgreSQL");
  }

  private attachSlowQueryLogger(): void {
    if (this.slowQueryThresholdMs <= 0) return;
    (
      this as unknown as { $on(event: "query", listener: (e: Prisma.QueryEvent) => void): void }
    ).$on("query", (event: Prisma.QueryEvent) => {
      if (event.duration >= this.slowQueryThresholdMs) {
        this.logger.warn(
          `Slow query (${event.duration}ms >= ${this.slowQueryThresholdMs}ms): ${event.query}`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma disconnected");
  }
}
