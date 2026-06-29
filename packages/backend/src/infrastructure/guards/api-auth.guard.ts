/**
 * ApiAuthGuard — global deny-by-default API authentication for the whole backend.
 *
 * The app has no per-user auth (VPN-only by design), but on a public release every
 * route is reachable: anyone could publish to the connected social accounts, burn the
 * LLM budget, or pause/resume the pipeline. This guard gates ALL routes behind a shared
 * API key, leaving only liveness (`/health`) public.
 *
 * Registered globally via APP_GUARD. Behaviour:
 *   - API_AUTH_ENABLED=false (default) → pass-through (dev / VPN-only / tests).
 *   - API_AUTH_ENABLED=true  → every non-public route requires a valid key; if API_KEY is
 *     empty the guard fails CLOSED (denies everything) rather than silently allowing.
 *
 * Key transport (any of): `x-api-key: <key>`, `Authorization: Bearer <key>`, or
 * `?api_key=<key>` (query param — needed for EventSource/SSE which can't set headers;
 * note query keys may surface in access logs).
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { parseBool } from '../config/parse-bool';

/** Public route suffixes (matched after the global /api/v1 prefix) — liveness only. */
const PUBLIC_SUFFIXES = ['/health'];

@Injectable()
export class ApiAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiAuthGuard.name);
  private readonly enabled: boolean;
  private readonly apiKey: string;

  // NOTE: `config?.` — under vitest/esbuild design:paramtypes is stripped, so a globally
  // registered guard may be constructed without its injected ConfigService. Defaulting to
  // disabled in that case keeps full-app tests pass-through (they don't exercise auth).
  constructor(private readonly config?: ConfigService) {
    this.enabled = parseBool(this.config?.get<string>('API_AUTH_ENABLED', 'false') ?? 'false');
    this.apiKey = this.config?.get<string>('API_KEY', '') ?? '';
    if (this.enabled && !this.apiKey) {
      this.logger.error(
        'API_AUTH_ENABLED=true but API_KEY is empty — all non-public requests will be DENIED (fail-closed). Set API_KEY.',
      );
    } else if (this.enabled) {
      this.logger.log('API auth enabled — all routes require a valid API key except liveness (/health).');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) return true; // default / VPN-only: no gating

    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.path || req.url || '').split('?')[0] as string;

    if (this.isPublic(path)) return true;

    // Enabled but no key configured → fail closed.
    if (!this.apiKey) {
      throw new UnauthorizedException('API authentication is misconfigured');
    }

    const provided = this.extractKey(req);
    if (provided && this.safeEqual(provided, this.apiKey)) {
      return true;
    }

    this.logger.warn(`Unauthorized API access blocked: ${req.method} ${path}`);
    throw new UnauthorizedException('Missing or invalid API key');
  }

  private isPublic(path: string): boolean {
    return PUBLIC_SUFFIXES.some((suffix) => path === suffix || path.endsWith(suffix));
  }

  private extractKey(req: Request): string | null {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.length > 0) return header;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim();
      if (token.length > 0) return token;
    }

    const q = (req.query as Record<string, unknown> | undefined)?.['api_key'];
    if (typeof q === 'string' && q.length > 0) return q;

    return null;
  }

  /** Constant-time comparison (avoids timing side-channels on the key). */
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
