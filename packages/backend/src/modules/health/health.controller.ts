import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';
import { withTimeout } from '../../infrastructure/util/with-timeout.js';

// BUG-8: bound each dependency probe so a hung Redis/DB connection can never
// hang the whole /health endpoint (which would trip the k8s liveness probe).
const HEALTH_CHECK_TIMEOUT_MS = 2000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {}

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
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS, 'db health');
    } catch {
      dbStatus = 'disconnected';
    }

    // Check Redis (Sprint L: uses shared connection; BUG-8: bounded ping)
    let redisStatus = 'connected';
    try {
      await withTimeout(this.redis.ping(), HEALTH_CHECK_TIMEOUT_MS, 'redis health');
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
}
