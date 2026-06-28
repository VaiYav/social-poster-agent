import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { initSentry } from './infrastructure/monitoring/sentry';

// Playwright/Camoufox can throw unhandled exceptions on page errors (e.g. malformed
// pageError.location). Catch them at process level to prevent the backend from crashing.
process.on('uncaughtException', (err) => {
  // Only log — don't crash. Browser automation errors are non-fatal.
  if (err.message?.includes('pageError') || err.message?.includes('location.url')) {
    new Logger('Process').warn(`Suppressed Playwright pageError bug: ${err.message}`);
    return;
  }
  new Logger('Process').error(`Uncaught exception: ${err.message}`, err.stack);
});

async function bootstrap(): Promise<void> {
  // Initialize Sentry before app bootstrap (no-op if SENTRY_DSN not set)
  initSentry();

  const app = await NestFactory.create(AppModule, {
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
