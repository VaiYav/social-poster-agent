// langfuse-instrumentation.ts — Langfuse OpenTelemetry SDK initialization.
//
// Imported at the top of main.ts (after instrument.ts for Sentry) so the
// LangfuseSpanProcessor is registered before any tracing calls happen.
//
// Sentry registers its own TracerProvider as the global OTel provider during
// `Sentry.init()` (in instrument.ts, imported first). Creating a second
// `NodeSDK` here would NOT replace Sentry's provider — `trace.setGlobalTracerProvider`
// silently no-ops if a provider is already registered. The result: Langfuse
// spans never reach the Langfuse exporter, and traces stay empty in the UI.
//
// Fix: instead of creating a competing NodeSDK, we attach the
// LangfuseSpanProcessor directly to Sentry's already-registered global
// provider via its internal MultiSpanProcessor. Both Sentry and Langfuse then
// receive every span — Sentry for error tracking, Langfuse for LLM observability.
//
// Auto-enable: the processor is only added when LANGFUSE_PUBLIC_KEY is set.
// When the env var is absent or empty, this file is a no-op — zero overhead,
// no network calls, no background batching. This matches the existing
// feature-flag pattern (ENGAGEMENT_ENABLED, ORCHESTRATOR_ENABLED, etc.).
//
// Credentials are read from env vars (per Langfuse docs):
//   LANGFUSE_PUBLIC_KEY  (pk-lf-...)
//   LANGFUSE_SECRET_KEY  (sk-lf-...)
//   LANGFUSE_BASE_URL    (https://us.cloud.langfuse.com — US cloud default)
//
// Refs:
//   - https://langfuse.com/docs/observability/sdk/overview
//   - Sentry OTel init: @sentry/node build/esm/sdk/initOtel.js
import { trace } from '@opentelemetry/api';
import { LangfuseSpanProcessor } from '@langfuse/otel';

// Use console directly — @nestjs/common Logger is not yet initialised when
// this file runs (it's imported before NestFactory.create()).
const log = (level: 'log' | 'warn' | 'debug', msg: string): void => {
  const prefix = '\x1b[32m[LangfuseInstrumentation]\x1b[39m';
  if (level === 'warn') console.warn(`\x1b[33m[LangfuseInstrumentation]\x1b[39m ${msg}`);
  else if (level === 'debug') console.debug(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
};

/** Whether Langfuse tracing is enabled (LANGFUSE_PUBLIC_KEY is set). */
const langfuseEnabled = !!process.env.LANGFUSE_PUBLIC_KEY;

/** The LangfuseSpanProcessor instance — exported for graceful shutdown. */
let langfuseProcessor: LangfuseSpanProcessor | undefined;

if (langfuseEnabled) {
  try {
    langfuseProcessor = new LangfuseSpanProcessor();

    // Attach to the global TracerProvider (registered by Sentry in instrument.ts).
    // The provider's _activeSpanProcessor is a MultiSpanProcessor that wraps an
    // array of processors in _spanProcessors. We push our processor into that
    // array so every span is forwarded to both Sentry and Langfuse.
    const provider = trace.getTracerProvider() as unknown as {
      _activeSpanProcessor?: { _spanProcessors?: unknown[] };
    };
    const multiProcessor = provider?._activeSpanProcessor;
    if (multiProcessor?._spanProcessors && Array.isArray(multiProcessor._spanProcessors)) {
      multiProcessor._spanProcessors.push(langfuseProcessor);
      const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
      log('log', `Langfuse tracing enabled — exporting to ${baseUrl}`);
    } else {
      // Fallback: no global provider registered (Sentry disabled or not yet init).
      // This should not happen in production (instrument.ts runs first), but we
      // handle it gracefully — the processor is created but won't receive spans
      // until a provider is available. Langfuse SDK degrades to a no-op.
      log('warn',
        'Langfuse: no global TracerProvider found — spans will not be exported. ' +
          'Ensure instrument.ts (Sentry) is imported before langfuse-instrumentation.ts.',
      );
    }
  } catch (err) {
    // SDK errors are non-fatal — the app must still boot. Langfuse SDK is
    // designed to never break the host application (errors are caught + logged).
    log('warn',
      `Langfuse OTel SDK failed to start — tracing disabled: ${(err as Error).message}`,
    );
    langfuseProcessor = undefined;
  }
} else {
  log('debug', 'Langfuse tracing disabled — LANGFUSE_PUBLIC_KEY not set');
}

/**
 * Graceful shutdown — flushes all queued traces to Langfuse before exit.
 * Called from main.ts on SIGTERM/SIGINT (via NestJS shutdown hooks) and
 * from short-lived CLI scripts before process exit.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (langfuseProcessor) {
    try {
      await langfuseProcessor.shutdown();
      log('debug', 'Langfuse span processor shut down — traces flushed');
    } catch (err) {
      log('warn', `Langfuse shutdown error: ${(err as Error).message}`);
    }
  }
}
