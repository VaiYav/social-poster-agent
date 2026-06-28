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
    const remoteAddress = socket?.remoteAddress ?? '';
    const forwardedFor = request.headers['x-forwarded-for'] as string | undefined;

    // Allow loopback (IPv4 + IPv6)
    const allowedRemote = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    if (allowedRemote.includes(remoteAddress)) return true;

    // Allow Docker internal network (172.16.0.0/12) — the UI container calls backend
    if (remoteAddress.startsWith('172.16.') || remoteAddress.startsWith('172.17.') ||
        remoteAddress.startsWith('172.18.') || remoteAddress.startsWith('172.19.') ||
        remoteAddress.startsWith('172.2') || remoteAddress.startsWith('172.30.') ||
        remoteAddress.startsWith('172.31.')) {
      return true;
    }

    // When behind nginx, check X-Forwarded-For (nginx sets this to the real client)
    // If XFF is present and is localhost, allow (nginx on same host)
    if (forwardedFor) {
      const firstIp = forwardedFor.split(',')[0]?.trim() ?? '';
      if (allowedRemote.includes(firstIp)) return true;
    }

    this.logger.warn(
      `Blocked non-localhost access to guarded endpoint: ${request.method} ${request.url} from ${remoteAddress}`,
    );
    throw new ForbiddenException('This endpoint is only accessible from localhost');
  }
}
