// instrument.ts — Sentry SDK initialization, imported at the top of main.ts.
//
// This file runs before NestFactory.create() so Sentry hooks (uncaughtException,
// unhandledRejection, HTTP instrumentation, etc.) are in place before the app boots.
//
// The DSN defaults to the project's Sentry instance but can be overridden or
// disabled via SENTRY_DSN (set to empty string to disable).
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { ClsServiceManager } from 'nestjs-cls';

const DEFAULT_DSN =
  'https://99422db193e11c4c1d8b6e6c2e41cb41@o4510136386387968.ingest.de.sentry.io/4511648401915984';

// SENTRY_DSN='' → disabled; SENTRY_DSN set → override; unset → default DSN
const dsn = process.env.SENTRY_DSN !== undefined ? process.env.SENTRY_DSN : DEFAULT_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SPA_RELEASE ?? 'spa@0.5.2',
    enableLogs: true,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
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
