import { Global, Module } from "@nestjs/common";
import { ClsModule } from "nestjs-cls";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { CorrelationIdInterceptor } from "./correlation-id.interceptor";

/**
 * CLS (Continuation-Local Storage) module — provides request-scoped context.
 *
 * Stores correlationId per request, accessible from any layer without
 * passing it through function arguments.
 *
 * CorrelationIdInterceptor sets the X-Correlation-Id response header
 * so clients can correlate requests with server logs (GAP-003).
 *
 * Usage in services:
 *   const correlationId = clsService.getId();
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => `spa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
    }),
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: CorrelationIdInterceptor,
    },
  ],
})
export class AppClsModule {}
