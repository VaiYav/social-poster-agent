import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import type { Response } from "express";
import { AdminGuard } from "../auth/admin.guard";
import { Public } from "../auth/public.decorator";
import * as Sentry from "@sentry/nestjs";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import IORedis from "ioredis";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";
import { withTimeout } from "../../infrastructure/util/with-timeout.js";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    private readonly configService: ConfigService,
    @Optional() private readonly queueFactory?: QueueFactory,
  ) {
    // BUG-8: bound each dependency probe so a hung Redis/DB connection can never
    // hang the whole /health endpoint (which would trip the k8s liveness probe).
    this.timeoutMs =
      Number(this.configService.get<string>("HEALTH_CHECK_TIMEOUT_MS", "2000")) || 2000;
  }

  /**
   * Live probe — always returns 200 so Kubernetes does not restart a pod that is
   * merely waiting for dependencies to come up.
   */
  @Get()
  @Get("live")
  @Public()
  @ApiOperation({ summary: "Liveness probe — always 200" })
  @ApiResponse({ status: 200, description: "Liveness status" })
  live(@Res() res: Response): void {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Readiness probe — returns 503 when a dependency is unavailable so traffic
   * is routed away until the service recovers.
   */
  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Readiness probe — 503 when dependencies are down" })
  @ApiResponse({ status: 200, description: "All dependencies healthy" })
  @ApiResponse({ status: 503, description: "One or more dependencies unavailable" })
  async ready(@Res() res: Response): Promise<void> {
    // Check PostgreSQL (BUG-8: bounded so a hung connection can't hang /health)
    let dbStatus = "connected";
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, this.timeoutMs, "db health");
    } catch {
      dbStatus = "disconnected";
    }

    // Check Redis (Sprint L: uses shared connection; BUG-8: bounded ping)
    let redisStatus = "connected";
    try {
      await withTimeout(this.redis.ping(), this.timeoutMs, "redis health");
    } catch {
      redisStatus = "disconnected";
    }

    // Check BullMQ queue connectivity (BUG-8: bounded; optional for tests)
    let queueStatus = "connected";
    if (this.queueFactory) {
      try {
        await withTimeout(
          this.queueFactory.getJobCounts("x", "posting"),
          this.timeoutMs,
          "queue health",
        );
      } catch {
        queueStatus = "disconnected";
      }
    }

    const allOk =
      dbStatus === "connected" && redisStatus === "connected" && queueStatus === "connected";
    const status = allOk ? "ok" : "degraded";
    const statusCode = allOk ? 200 : 503;

    res.status(statusCode).json({
      status,
      database: dbStatus,
      redis: redisStatus,
      queue: queueStatus,
      timestamp: new Date().toISOString(),
    });
  }

  @Get("debug-sentry")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Sentry test — throws an intentional error" })
  @ApiResponse({ status: 500, description: "Intentional error for Sentry verification" })
  getError(): never {
    if (this.configService.get<string>("NODE_ENV", "development") === "production") {
      throw new NotFoundException("debug-sentry endpoint is not available in production");
    }
    Sentry.logger.info("User triggered test error", {
      action: "test_error_endpoint",
    });
    throw new Error("My first Sentry error!");
  }
}
