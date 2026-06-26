import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import type { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Observable, tap, catchError } from 'rxjs';
import { throwError } from 'rxjs';

/**
 * Sentry initialization — called once at bootstrap.
 *
 * Only initializes if SENTRY_DSN is set. Otherwise no-ops.
 * This makes Sentry optional — the app works without it.
 *
 * Captures:
 * - Unhandled exceptions (via Sentry SDK)
 * - Performance traces (if SENTRY_TRACES_SAMPLE_RATE > 0)
 * - Profiling data (if enabled)
 *
 * Correlation: Sentry events are tagged with the CLS correlationId
 * so errors can be correlated with request logs.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Sentry disabled — no DSN configured
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SPA_RELEASE ?? 'spa@0.4.2',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1'),
    integrations: [nodeProfilingIntegration()],
    // Filter out health check requests
    ignoreTransactions: ['GET /api/v1/health', 'GET /health'],
    beforeSend(event) {
      // Attach correlationId from CLS if available
      const cls = ClsServiceManager.getClsService();
      const correlationId = cls?.getId();
      if (correlationId) {
        event.tags = { ...event.tags, correlationId };
      }
      return event;
    },
  });
}

/**
 * Sentry interceptor — captures exceptions thrown in controllers.
 *
 * This interceptor wraps the response pipeline and sends any errors
 * to Sentry before they propagate to the exception filter.
 */
@Injectable()
export class SentryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        // Don't capture HttpExceptions — they're expected client errors
        const status = (error as { getStatus?: () => number })?.getStatus?.();
        if (status && status >= 400 && status < 500) {
          return throwError(() => error);
        }

        // Capture unexpected errors (500s)
        const cls = ClsServiceManager.getClsService();
        const correlationId = cls?.getId();
        Sentry.captureException(error, {
          tags: { correlationId },
          extra: {
            method: context.switchToHttp().getRequest().method,
            url: context.switchToHttp().getRequest().url,
          },
        });

        return throwError(() => error);
      }),
    );
  }
}
