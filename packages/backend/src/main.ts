// IMPORTANT: import instrument.ts before everything else so Sentry hooks are
// installed before any other module loads. CJS syntax per @sentry/nestjs docs.
import "./instrument.js";
// Langfuse OTel SDK — must be initialized before any tracing calls happen.
// Auto-enables when LANGFUSE_PUBLIC_KEY is set; no-op otherwise.
import "./langfuse-instrumentation.js";

import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

// Held so the process-level handlers can shut the app down gracefully.
let app: INestApplication | undefined;
let shuttingDown = false;

/**
 * B5/SEC4: graceful shutdown on a fatal uncaught error.
 * After an uncaughtException the process is in an undefined state — log, close the
 * app (BullMQ/Redis/browser via OnModuleDestroy), then exit so the orchestrator
 * restarts cleanly. Continuing to serve from a corrupted state is worse.
 */
function fatalShutdown(label: string, err: unknown): void {
  const e = err as Error;
  new Logger("Process").error(`${label}: ${e?.message ?? String(err)}`, e?.stack);
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  void Promise.resolve(app?.close())
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

// Playwright/Camoufox throws benign uncaught errors on page errors (e.g. malformed
// pageError.location, or `Cannot read properties of undefined (reading 'url')` from
// _Page.addPageError when a Firefox page-error event arrives without a location object).
// These are non-fatal upstream bugs — suppress them. Everything else triggers a graceful
// shutdown rather than silently continuing in an undefined state.
function isBenignPlaywrightError(err: Error): boolean {
  const msg = err.message ?? "";
  const stack = err.stack ?? "";
  // Match by message (older form) or by the addPageError/FFPage stack frame (newer form
  // where the message is just "Cannot read properties of undefined (reading 'url')").
  return (
    msg.includes("pageError") ||
    msg.includes("location.url") ||
    (msg.includes("reading 'url'") && /addPageError|FFPage\._onUncaughtError/.test(stack))
  );
}

process.on("uncaughtException", (err) => {
  if (isBenignPlaywrightError(err)) {
    new Logger("Process").warn(`Suppressed Playwright pageError bug: ${err.message}`);
    return;
  }
  fatalShutdown("Uncaught exception", err);
});

// Surface unhandled promise rejections (logged + captured by Sentry). Not force-exiting
// to avoid destabilizing on benign fire-and-forget rejections — but these are bugs.
// The same Playwright pageError bug can surface here as an unhandled rejection from
// the FFBrowserContext event emitter — suppress it at warn level instead of error.
process.on("unhandledRejection", (reason) => {
  const e = reason as Error;
  if (e && isBenignPlaywrightError(e)) {
    new Logger("Process").warn(`Suppressed Playwright pageError rejection: ${e.message}`);
    return;
  }
  new Logger("Process").error(
    `Unhandled promise rejection: ${e?.message ?? String(reason)}`,
    e?.stack,
  );
});

async function bootstrap(): Promise<void> {
  // Sentry is initialized via instrument.ts (imported at the top of this file).

  app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // B10: Enable shutdown hooks for graceful shutdown
  // OnModuleDestroy will be called on SIGTERM/SIGINT — closes BullMQ, Redis, browser
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  // Railway sets PORT automatically; fall back to SPA_API_PORT for local dev
  const port = configService.get<number>("PORT") ?? configService.get<number>("SPA_API_PORT", 3100);
  const apiPrefix = configService.get<string>("SPA_API_PREFIX", "api/v1");
  const swaggerPath = configService.get<string>("SPA_SWAGGER_PATH", "docs");

  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS — allow the Vue UI (dev: localhost:3101, prod: Vercel domain via CORS_ORIGIN env var)
  const corsOrigins = [`http://localhost:${configService.get<number>("SPA_UI_PORT", 3101)}`];
  const extraOrigin = configService.get<string>("CORS_ORIGIN", "");
  if (extraOrigin) {
    // Comma-separated list of additional allowed origins (e.g. Vercel deployment URL)
    corsOrigins.push(
      ...extraOrigin
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    );
  }
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // Swagger/OpenAPI docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Social Poster Agent API")
    .setDescription("API for the Social Poster Agent social media automation system")
    .setVersion("0.5.1")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(swaggerPath, app, document);

  // Auth: AUTH_ENABLED=true gates all routes behind a JWT cookie (see JwtAuthGuard).
  // When false (default) the API is pass-through (VPN-only / dev / tests).
  Logger.log(`Swagger docs: http://localhost:${port}/${swaggerPath}`, "Bootstrap");
  Logger.log(`SPA API running on :${port}/${apiPrefix}`, "Bootstrap");

  await app.listen(port, "0.0.0.0");
}

void bootstrap();
