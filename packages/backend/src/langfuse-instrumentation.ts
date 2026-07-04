// langfuse-instrumentation.ts — Langfuse OpenTelemetry SDK initialization.
//
// Imported at the top of main.ts (alongside instrument.ts for Sentry) so the
// LangfuseSpanProcessor is registered before any other module loads. This is
// required by the Langfuse JS/TS SDK: the OTel SDK must be started before any
// tracing calls happen, and import order determines instrumentation coverage.
//
// Auto-enable: the OTel SDK is only started when LANGFUSE_PUBLIC_KEY is set.
// When the env var is absent or empty, this file is a no-op — zero overhead,
// no network calls, no background batching. This matches the existing
// feature-flag pattern (ENGAGEMENT_ENABLED, ORCHESTRATOR_ENABLED, etc.).
//
// Credentials are read from env vars (per Langfuse docs):
//   LANGFUSE_PUBLIC_KEY  (pk-lf-...)
//   LANGFUSE_SECRET_KEY  (sk-lf-...)
//   LANGFUSE_BASE_URL    (https://us.cloud.langfuse.com — US cloud default)
//
// Refs: https://langfuse.com/docs/observability/sdk/overview
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { Logger } from '@nestjs/common';

const logger = new Logger('LangfuseInstrumentation');

/** Whether Langfuse tracing is enabled (LANGFUSE_PUBLIC_KEY is set). */
const langfuseEnabled = !!process.env.LANGFUSE_PUBLIC_KEY;

/** The OTel SDK instance — exported for graceful shutdown in main.ts. */
let langfuseSdk: NodeSDK | undefined;

if (langfuseEnabled) {
  try {
    langfuseSdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor()],
    });
    langfuseSdk.start();
    const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
    logger.log(`Langfuse tracing enabled — exporting to ${baseUrl}`);
  } catch (err) {
    // SDK errors are non-fatal — the app must still boot. Langfuse SDK is
    // designed to never break the host application (errors are caught + logged).
    logger.warn(
      `Langfuse OTel SDK failed to start — tracing disabled: ${(err as Error).message}`,
    );
    langfuseSdk = undefined;
  }
} else {
  logger.debug('Langfuse tracing disabled — LANGFUSE_PUBLIC_KEY not set');
}

/**
 * Graceful shutdown — flushes all queued traces to Langfuse before exit.
 * Called from main.ts on SIGTERM/SIGINT (via NestJS shutdown hooks) and
 * from short-lived CLI scripts before process exit.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (langfuseSdk) {
    try {
      await langfuseSdk.shutdown();
      logger.debug('Langfuse OTel SDK shut down — traces flushed');
    } catch (err) {
      logger.warn(`Langfuse shutdown error: ${(err as Error).message}`);
    }
  }
}
