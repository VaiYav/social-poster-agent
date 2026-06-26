import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SentryInterceptor } from './sentry';

/**
 * Monitoring module — registers Sentry interceptor globally.
 *
 * Sentry is initialized in main.ts via initSentry().
 * This module registers the SentryInterceptor which captures
 * unhandled exceptions and sends them to Sentry.
 *
 * If SENTRY_DSN is not set, Sentry is a no-op.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: SentryInterceptor,
    },
  ],
})
export class MonitoringModule {}
