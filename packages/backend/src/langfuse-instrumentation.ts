// langfuse-instrumentation.ts — Langfuse OpenTelemetry SDK initialization.
//
// Imported at the top of main.ts (after instrument.ts for Sentry) so the
// Langfuse tracer is registered before any tracing calls happen.
//
// ## Why an isolated TracerProvider (not the global one)
//
// Sentry.init() registers its own TracerProvider as the global OTel provider
// via `trace.setGlobalTracerProvider()`. The Langfuse `@langfuse/tracing`
// package's `getLangfuseTracerProvider()` falls back to the global provider
// when no isolated provider is set. That means Langfuse spans would be created
// via Sentry's provider — and while they'd carry the `LANGFUSE_TRACER_NAME`
// instrumentation scope, they'd be processed by Sentry's SpanProcessor only.
//
// The `LangfuseSpanProcessor` we push into Sentry's MultiSpanProcessor does
// receive the spans, but there's a subtlety: `LangfuseSpanProcessor.shouldExportSpan`
// filters by `isLangfuseSpan` / `isGenAISpan` / `isKnownLLMInstrumentor`. Spans
// created by `@langfuse/langchain` CallbackHandler via `startActiveObservation`
// DO have `instrumentationScope.name === LANGFUSE_TRACER_NAME`, so they pass
// the filter. However, the spans are created on Sentry's tracer which wraps
// them with Sentry semantics (SentrySpan), and the Langfuse processor's
// `processEndedSpan` may not correctly extract Langfuse attributes.
//
// The clean, supported approach (per Langfuse JS SDK v5 docs) is to create a
// **separate** TracerProvider with `LangfuseSpanProcessor` and register it as
// the isolated Langfuse provider via `setLangfuseTracerProvider()`. This keeps
// Sentry and Langfuse tracing completely independent:
//   - Sentry uses the global provider (its own)
//   - Langfuse uses the isolated provider (ours)
// Both receive spans independently — no interference, no filtering issues.
//
// Auto-enable: the isolated provider is only created when LANGFUSE_PUBLIC_KEY
// is set. When the env var is absent or empty, this file is a no-op — zero
// overhead, no network calls, no background batching.
//
// Credentials are read from env vars (per Langfuse docs):
//   LANGFUSE_PUBLIC_KEY  (pk-lf-...)
//   LANGFUSE_SECRET_KEY  (sk-lf-...)
//   LANGFUSE_BASE_URL    (https://us.cloud.langfuse.com — US cloud default)
//
// Refs:
//   - https://langfuse.com/docs/observability/sdk/overview
//   - @langfuse/tracing src/tracerProvider.ts (setLangfuseTracerProvider)
//   - Sentry OTel init: @sentry/node build/esm/sdk/initOtel.js
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

// Use console directly — @nestjs/common Logger is not yet initialised when
// this file runs (it's imported before NestFactory.create()).
const log = (level: "log" | "warn" | "debug", msg: string): void => {
  const prefix = "\x1b[32m[LangfuseInstrumentation]\x1b[39m";
  if (level === "warn") console.warn(`\x1b[33m[LangfuseInstrumentation]\x1b[39m ${msg}`);
  else if (level === "debug") console.debug(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
};

/** Whether Langfuse tracing is enabled (LANGFUSE_PUBLIC_KEY is set). */
const langfuseEnabled = !!process.env.LANGFUSE_PUBLIC_KEY;

/** The LangfuseSpanProcessor instance — kept for graceful shutdown. */
let langfuseProcessor: LangfuseSpanProcessor | undefined;

/** The isolated TracerProvider — kept for graceful shutdown. */
let langfuseProvider: BasicTracerProvider | undefined;

if (langfuseEnabled) {
  try {
    // Default to US cloud (matches .env.example) and ensure the env var is set
    // so the Langfuse SDK/SpanProcessor use the same endpoint.
    const baseUrl = process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com";
    process.env.LANGFUSE_BASE_URL = baseUrl;

    langfuseProcessor = new LangfuseSpanProcessor();

    // Create an isolated TracerProvider with only the LangfuseSpanProcessor.
    // This is separate from Sentry's global provider — Langfuse spans go
    // directly to Langfuse, Sentry spans go to Sentry. No interference.
    langfuseProvider = new BasicTracerProvider({
      spanProcessors: [langfuseProcessor],
    });

    // Register as the isolated Langfuse tracer provider.
    // @langfuse/tracing getLangfuseTracerProvider() will now return this
    // provider instead of falling back to the global (Sentry) one.
    setLangfuseTracerProvider(langfuseProvider);

    log("log", `Langfuse tracing enabled — exporting to ${baseUrl}`);
  } catch (err) {
    // SDK errors are non-fatal — the app must still boot. Langfuse SDK is
    // designed to never break the host application (errors are caught + logged).
    log("warn", `Langfuse OTel SDK failed to start — tracing disabled: ${(err as Error).message}`);
    langfuseProcessor = undefined;
    langfuseProvider = undefined;
  }
} else {
  log("debug", "Langfuse tracing disabled — LANGFUSE_PUBLIC_KEY not set");
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
      log("debug", "Langfuse span processor shut down — traces flushed");
    } catch (err) {
      log("warn", `Langfuse shutdown error: ${(err as Error).message}`);
    }
  }
}
