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

// SEC9: value-based redaction — catch secrets that appear in VALUES regardless
// of the key (key-based redaction above misses e.g. a connection string in an
// error message, or a token embedded in free text). High-precision patterns
// ONLY, so legitimate content (post text, UUIDs, SimHash hex) is never mangled.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*:[^/@\s]+@/gi;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI / Stripe-style keys (incl. sk-proj-)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT header.payload.sig
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // Authorization: Bearer <token>
];

function redactSecretValues(str: string): string {
  let out = str.replace(URL_CREDENTIALS, '$1[REDACTED]@'); // keep scheme+host, mask user:pass
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function redactString(str: string): string {
  return redactSecretValues(str.replace(REDACT_PATTERN, '$1"[REDACTED]"'));
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
        next: (_data) => {
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
