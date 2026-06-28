import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';

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
    // Check PostgreSQL
    let dbStatus = 'connected';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'disconnected';
    }

    // Check Redis (Sprint L: uses shared connection)
    let redisStatus = 'connected';
    try {
      await this.redis.ping();
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
