import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, map } from 'rxjs/operators';
import type { Request } from 'express';

/**
 * Redact interceptor — masks sensitive fields in logs and responses.
 *
 * Redacts:
 * - Authorization headers
 * - Password fields
 * - Token fields
 * - storageState (session cookies/localStorage)
 * - credentialsRef
 *
 * Also logs each request with correlationId from CLS.
 */
const REDACT_KEYS = [
  'password',
  'token',
  'authorization',
  'storageState',
  'credentialsRef',
  'cookie',
  'secret',
  'apiKey',
];

// P1-7 fix: exact key match set (lowercase) — avoids false positives like 'tokenizer' matching 'token'
const REDACT_KEYS_SET = new Set(REDACT_KEYS.map((k) => k.toLowerCase()));

const REDACT_PATTERN = new RegExp(
  `("(?:${REDACT_KEYS.join('|')})"\\s*:\\s*)"[^"]*"`,
  'gi',
);

function redactString(str: string): string {
  return str.replace(REDACT_PATTERN, '$1"[REDACTED]"');
}

function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) return obj.map(redactObject);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // P1-7 fix: exact key match (case-insensitive) instead of includes()
    if (REDACT_KEYS_SET.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactObject(value);
    }
  }
  return result;
}

@Injectable()
export class RedactInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          const elapsed = Date.now() - now;
          this.logger.log(`${method} ${url} ${elapsed}ms`);
        },
        error: (err) => {
          const elapsed = Date.now() - now;
          this.logger.error(
            `${method} ${url} ${elapsed}ms ERROR: ${redactString(err?.message ?? String(err))}`,
          );
        },
      }),
      map((data) => redactObject(data)),
    );
  }
}
