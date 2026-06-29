import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { ZodValidationFilter } from './zod-validation.filter';

/**
 * Filters module — registers global exception filters.
 *
 * Order matters: SentryGlobalFilter is registered first (outermost) so it
 * captures every unhandled exception and reports it to Sentry, then re-throws
 * to ZodValidationFilter which formats the HTTP response.
 *
 * ZodValidationFilter:
 * - Catches ZodError → HTTP 400 with structured validation details
 * - Catches HttpException → passes through to NestJS response
 * - Catches unknown errors → HTTP 500 with redacted message
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    {
      provide: APP_FILTER,
      useClass: ZodValidationFilter,
    },
  ],
})
export class FiltersModule {}
