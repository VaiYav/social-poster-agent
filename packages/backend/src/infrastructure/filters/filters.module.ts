import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ZodValidationFilter } from './zod-validation.filter';

/**
 * Filters module — registers global exception filters.
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
      useClass: ZodValidationFilter,
    },
  ],
})
export class FiltersModule {}
