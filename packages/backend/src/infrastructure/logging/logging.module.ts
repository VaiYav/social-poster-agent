import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { RedactInterceptor } from "./redact.interceptor.js";

/**
 * Logging module — registers RedactInterceptor globally.
 *
 * RedactInterceptor:
 * - Logs each HTTP request with method, URL, elapsed time
 * - Redacts sensitive fields (password, token, storageState, etc.) from any logged data
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RedactInterceptor,
    },
  ],
})
export class LoggingModule {}
