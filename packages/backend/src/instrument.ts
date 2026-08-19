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

const DEFAULT_DSN = '';

// SENTRY_DSN='' → disabled; SENTRY_DSN set → override; unset → default DSN
const dsn = process.env.SENTRY_DSN !== undefined ? process.env.SENTRY_DSN : DEFAULT_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SPA_RELEASE ?? 'spa@0.5.2',
    enableLogs: true,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'), // Reduced from 1.0 to save quota
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.05'), // Reduced from 0.1
    integrations: [nodeProfilingIntegration()],
    // Filter out health check requests
    ignoreTransactions: ['GET /api/v1/health', 'GET /health'],
    // Filter out common transient errors that flood Sentry
    beforeSend(event, hint) {
      // Attach correlationId from CLS if available
      const cls = ClsServiceManager.getClsService();
      const correlationId = cls?.getId();
      if (correlationId) {
        event.tags = { ...event.tags, correlationId };
      }

      // Filter out LLM provider rate limit errors (429) - these are transient and expected
      if (event.exception) {
        const message = event.exception.values?.[0]?.value ?? '';
        if (message.includes('429') || message.includes('rate limit') || message.includes('Rate limit')) {
          // Only send 429 errors that are not from LLM providers (those are handled by fallback)
          if (!message.includes('LLM provider') && !message.includes('groq') && !message.includes('openrouter')) {
            return event; // Keep non-LLM 429 errors
          }
          return null; // Drop LLM 429 errors
        }

        // Filter out timeout errors from LLM providers (handled by fallback)
        if (message.includes('Request timed out') || message.includes('timeout')) {
          if (message.includes('LLM provider') || message.includes('openai')) {
            return null; // Drop LLM timeout errors
          }
        }

        // Filter out browser automation errors that are expected in production
        if (message.includes('Target page, context or browser has been closed') ||
            message.includes('Page was closed') ||
            message.includes('Page crashed')) {
          return null; // Drop browser automation errors
        }

        // Filter out empty content errors from LLM providers (handled by fallback)
        if (message.includes('returned empty content') && message.includes('provider')) {
          return null;
        }
      }

      return event;
    },
    // Group similar errors to reduce noise
    beforeBreadcrumb(breadcrumb, hint) {
      // Filter out verbose HTTP breadcrumbs for LLM API calls
      if (breadcrumb.category === 'http' && breadcrumb.data?.url) {
        const url = breadcrumb.data.url as string;
        if (url.includes('api.openai.com') || url.includes('api.groq.com') || 
            url.includes('openrouter.ai') || url.includes('api.deepseek.com')) {
          return null; // Don't track LLM API calls as breadcrumbs
        }
      }
      return breadcrumb;
    },
  });
}
