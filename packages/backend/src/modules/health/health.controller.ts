import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private redis: IORedis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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

    // Check Redis
    let redisStatus = 'connected';
    try {
      if (!this.redis) {
        const redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6381');
        this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
      }
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
