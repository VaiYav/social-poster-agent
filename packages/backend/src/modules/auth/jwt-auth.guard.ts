/**
 * JwtAuthGuard — global deny-by-default JWT authentication for the whole backend.
 *
 * Replaces the former ApiAuthGuard (shared API key). The UI now authenticates via
 * a JWT in an httpOnly cookie (`spa_token`), issued by POST /auth/login.
 *
 * Registered globally via APP_GUARD. Behaviour:
 *   - AUTH_ENABLED=false (default) → pass-through (dev / VPN-only / tests).
 *   - AUTH_ENABLED=true  → every non-public route requires a valid JWT (from
 *     cookie or Authorization: Bearer). If JWT_SECRET is empty the guard fails
 *     CLOSED (denies everything) rather than silently allowing.
 *
 * Token transport (any of):
 *   - Cookie `spa_token` (primary — used by the UI / browser / EventSource)
 *   - `Authorization: Bearer <token>` (for API clients / curl)
 *
 * Public routes (no auth required):
 *   - /auth/login — must be reachable to obtain a token
 *   - /health — liveness probe
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { parseBool } from '../../infrastructure/config/parse-bool';
import type { JwtPayload } from './auth.service';

/** Public route suffixes (matched after the global /api/v1 prefix). */
const PUBLIC_SUFFIXES = ['/auth/login', '/health'];

/** Cookie name — must match AuthController. */
const COOKIE_NAME = 'spa_token';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly enabled: boolean;
  private readonly jwtSecret: string;

  // NOTE: `jwtService?` / `config?` — under vitest/esbuild design:paramtypes is
  // stripped, so a globally registered guard may be constructed without its
  // injected deps. Defaulting to disabled in that case keeps full-app tests
  // pass-through (they don't exercise auth).
  constructor(
    private readonly jwtService?: JwtService,
    private readonly config?: ConfigService,
  ) {
    this.enabled = parseBool(this.config?.get<string>('AUTH_ENABLED', 'false') ?? 'false');
    this.jwtSecret = this.config?.get<string>('JWT_SECRET', '') ?? '';
    if (this.enabled && !this.jwtSecret) {
      this.logger.error(
        'AUTH_ENABLED=true but JWT_SECRET is empty — all non-public requests will be DENIED (fail-closed). Set JWT_SECRET.',
      );
    } else if (this.enabled) {
      this.logger.log('JWT auth enabled — all routes require a valid token except /auth/login and /health.');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true; // default / VPN-only / tests: no gating

    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.path || req.url || '').split('?')[0] as string;

    if (this.isPublic(path)) return true;

    // Enabled but no secret configured → fail closed.
    if (!this.jwtSecret) {
      throw new UnauthorizedException('Authentication is misconfigured');
    }

    const token = this.extractToken(req);
    if (!token) {
      this.logger.warn(`Unauthorized access blocked (no token): ${req.method} ${path}`);
      throw new UnauthorizedException('Authentication required');
    }

    // Verify JWT — use verifyAsync with the secret (guard doesn't depend on
    // JwtModule.registerAsync config, so we pass the secret explicitly).
    let payload: JwtPayload | null = null;
    try {
      payload = await this.jwtService!.verifyAsync<JwtPayload>(token, { secret: this.jwtSecret });
    } catch {
      payload = null;
    }

    if (!payload) {
      this.logger.warn(`Unauthorized access blocked (invalid token): ${req.method} ${path}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Attach user to request for downstream handlers / @Req()
    (req as Request & { user?: JwtPayload }).user = payload;
    return true;
  }

  private isPublic(path: string): boolean {
    return PUBLIC_SUFFIXES.some((suffix) => path === suffix || path.endsWith(suffix));
  }

  private extractToken(req: Request): string | null {
    // 1. Cookie (primary — UI / EventSource)
    const cookieHeader = req.headers.cookie;
    if (typeof cookieHeader === 'string') {
      const match = cookieHeader
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${COOKIE_NAME}=`));
      if (match) {
        const token = match.slice(COOKIE_NAME.length + 1);
        if (token.length > 0) return token;
      }
    }

    // 2. Authorization: Bearer <token> (API clients / curl)
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim();
      if (token.length > 0) return token;
    }

    return null;
  }
}
