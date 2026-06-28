import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { initSentry } from './infrastructure/monitoring/sentry';

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
  new Logger('Process').error(`${label}: ${e?.message ?? String(err)}`, e?.stack);
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  void Promise.resolve(app?.close())
    .catch(() => undefined)
    .finally(() => process.exit(1));
}

// Playwright/Camoufox throws benign uncaught errors on page errors (e.g. malformed
// pageError.location) — those are non-fatal and suppressed. Everything else triggers
// a graceful shutdown rather than silently continuing in an undefined state.
process.on('uncaughtException', (err) => {
  if (err.message?.includes('pageError') || err.message?.includes('location.url')) {
    new Logger('Process').warn(`Suppressed Playwright pageError bug: ${err.message}`);
    return;
  }
  fatalShutdown('Uncaught exception', err);
});

// Surface unhandled promise rejections (logged + captured by Sentry). Not force-exiting
// to avoid destabilizing on benign fire-and-forget rejections — but these are bugs.
process.on('unhandledRejection', (reason) => {
  const e = reason as Error;
  new Logger('Process').error(`Unhandled promise rejection: ${e?.message ?? String(reason)}`, e?.stack);
});

async function bootstrap(): Promise<void> {
  // Initialize Sentry before app bootstrap (no-op if SENTRY_DSN not set)
  initSentry();

  app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // B10: Enable shutdown hooks for graceful shutdown
  // OnModuleDestroy will be called on SIGTERM/SIGINT — closes BullMQ, Redis, browser
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('SPA_API_PORT', 3100);
  const apiPrefix = configService.get<string>('SPA_API_PREFIX', 'api/v1');
  const swaggerPath = configService.get<string>('SPA_SWAGGER_PATH', 'docs');

  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // CORS for the Vue UI (port 3101)
  app.enableCors({
    origin: [`http://localhost:${configService.get<number>('SPA_UI_PORT', 3101)}`],
    credentials: true,
  });

  // Swagger/OpenAPI docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Social Poster Agent API')
    .setDescription('Internal API for social media posting agent — My Zodiac AI')
    .setVersion('0.5.1')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(swaggerPath, app, document);

  // VPN-only — no auth. UI not exposed publicly.
  Logger.log(`Swagger docs: http://localhost:${port}/${swaggerPath}`, 'Bootstrap');
  Logger.log(`SPA API running on :${port}/${apiPrefix}`, 'Bootstrap');

  await app.listen(port);
}

void bootstrap();
