/**
 * Sprint O: LocalhostGuard — restricts an endpoint to requests from localhost.
 *
 * Used on endpoints that trigger expensive or dangerous browser operations
 * (X trending scrape, recycling run, quote-card generation). If port 3100 is
 * exposed publicly, these endpoints become a DoS / ban vector — an attacker
 * can exhaust the Camoufox session pool or trigger repeated X scraping.
 *
 * The guard checks the socket remote address AND the X-Forwarded-For header
 * (when behind nginx). Requests from 127.0.0.1, ::1, or the Docker internal
 * network (172.16.0.0/12) are allowed.
 *
 * In test environment the guard is bypassed (NODE_ENV=test) so integration
 * tests using supertest (which connects via localhost) still work.
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Socket } from 'net';

@Injectable()
export class LocalhostGuard implements CanActivate {
  private readonly logger = new Logger(LocalhostGuard.name);

  canActivate(context: ExecutionContext): boolean {
    // Bypass in test env — supertest connects via localhost but NODE_ENV=test
    if (process.env.NODE_ENV === 'test') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const socket = request.socket as Socket | undefined;
    const remoteAddress = this.normalizeIp(socket?.remoteAddress ?? '');

    // Allow loopback and the Docker internal network (UI container → backend).
    if (this.isLoopback(remoteAddress) || this.isDockerPrivate(remoteAddress)) return true;

    // SEC1: only consult X-Forwarded-For when the DIRECT peer is a configured trusted
    // proxy. Otherwise any client could send `X-Forwarded-For: 127.0.0.1` and bypass
    // the guard. TRUSTED_PROXY_IPS is empty by default → XFF is ignored entirely.
    const trustedProxies = (process.env.TRUSTED_PROXY_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (trustedProxies.includes(remoteAddress)) {
      const xff = request.headers['x-forwarded-for'];
      // `xff[0]` is `string | undefined` (empty array / noUncheckedIndexedAccess),
      // so coalesce to '' to keep `raw` a string.
      const raw = (Array.isArray(xff) ? xff[0] : xff) ?? '';
      const firstIp = this.normalizeIp((raw.split(',')[0] ?? '').trim());
      if (this.isLoopback(firstIp) || this.isDockerPrivate(firstIp)) return true;
    }

    this.logger.warn(
      `Blocked non-localhost access to guarded endpoint: ${request.method} ${request.url} from ${remoteAddress}`,
    );
    throw new ForbiddenException('This endpoint is only accessible from localhost');
  }

  /** Strip the IPv4-mapped IPv6 prefix (::ffff:127.0.0.1 → 127.0.0.1). */
  private normalizeIp(ip: string): string {
    return ip.replace(/^::ffff:/i, '');
  }

  private isLoopback(ip: string): boolean {
    return ip === '127.0.0.1' || ip === '::1';
  }

  /** True for the Docker private range 172.16.0.0/12 (172.16.x – 172.31.x). */
  private isDockerPrivate(ip: string): boolean {
    const m = /^172\.(\d{1,3})\./.exec(ip);
    if (!m) return false;
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
}
