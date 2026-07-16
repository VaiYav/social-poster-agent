import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { SHARED_REDIS } from '../../infrastructure/redis/redis.module.js';

/**
 * LoginRateLimitGuard — limits POST /auth/login attempts per IP.
 *
 * Defaults: 5 attempts per minute per IP. Configurable via
 * RATE_LIMIT_LOGIN_MAX_ATTEMPTS and RATE_LIMIT_LOGIN_WINDOW_MS env vars.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SHARED_REDIS) private readonly redis: IORedis,
  ) {
    this.maxAttempts = this.configService.get<number>('RATE_LIMIT_LOGIN_MAX_ATTEMPTS', 5);
    this.windowMs = this.configService.get<number>('RATE_LIMIT_LOGIN_WINDOW_MS', 60 * 1000);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = this.getClientIp(req);
    const key = `login:rate:${ip}`;

    try {
      const results = await this.redis.multi().incr(key).pexpire(key, this.windowMs).exec();
      const count = Array.isArray(results) && results[0] ? (results[0][1] as number) : 0;

      if (count > this.maxAttempts) {
        throw new HttpException('Too many login attempts', HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (err) {
      // Re-throw 429; everything else is a Redis failure — fail-open to avoid
      // locking users out when Redis is unavailable.
      if (err instanceof HttpException) throw err;
      return true;
    }

    return true;
  }

  private getClientIp(req: Record<string, unknown>): string {
    const ip =
      (req.ip as string | undefined) ||
      ((req.socket as { remoteAddress?: string } | undefined)?.remoteAddress) ||
      ((req.connection as { remoteAddress?: string } | undefined)?.remoteAddress) ||
      'unknown';
    return ip;
  }
}
