import { Controller, Get, Inject, NotFoundException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { withTimeout } from '../../infrastructure/util/with-timeout.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
    private readonly configService: ConfigService,
  ) {
    // BUG-8: bound each dependency probe so a hung Redis/DB connection can never
    // hang the whole /health endpoint (which would trip the k8s liveness probe).
    this.timeoutMs = Number(this.configService.get<string>('HEALTH_CHECK_TIMEOUT_MS', '2000')) || 2000;
  }

  @Get()
  @ApiOperation({ summary: 'Health check — database + Redis connectivity' })
  @ApiResponse({ status: 200, description: 'Health status with DB and Redis check' })
  async check(): Promise<{
    status: string;
    database: string;
    redis: string;
    timestamp: string;
  }> {
    // Check PostgreSQL (BUG-8: bounded so a hung connection can't hang /health)
    let dbStatus = 'connected';
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, this.timeoutMs, 'db health');
    } catch {
      dbStatus = 'disconnected';
    }

    // Check Redis (Sprint L: uses shared connection; BUG-8: bounded ping)
    let redisStatus = 'connected';
    try {
      await withTimeout(this.redis.ping(), this.timeoutMs, 'redis health');
    } catch {
      redisStatus = 'disconnected';
    }

    const allOk = dbStatus === 'connected' && redisStatus === 'connected';

    return {
      status: allOk ? 'ok' : 'degraded',
      database: dbStatus,
      redis: redisStatus,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('debug-sentry')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Sentry test — throws an intentional error' })
  @ApiResponse({ status: 500, description: 'Intentional error for Sentry verification' })
  getError(): never {
    if (this.configService.get<string>('NODE_ENV', 'development') === 'production') {
      throw new NotFoundException('debug-sentry endpoint is not available in production');
    }
    Sentry.logger.info('User triggered test error', {
      action: 'test_error_endpoint',
    });
    throw new Error('My first Sentry error!');
  }
}
