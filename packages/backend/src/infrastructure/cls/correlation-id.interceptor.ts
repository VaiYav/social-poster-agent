import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { ClsServiceManager } from "nestjs-cls";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { Response } from "express";

/**
 * Correlation ID interceptor — sets the X-Correlation-Id response header.
 *
 * Reads the correlationId from CLS (set by AppClsModule middleware) and
 * sets it on the response header so clients can correlate requests with
 * server logs (GAP-003).
 *
 * Uses ClsServiceManager static accessor to avoid DI resolution issues
 * with APP_INTERCEPTOR registration.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    const cls = ClsServiceManager.getClsService();
    const correlationId = cls?.getId();
    if (correlationId) {
      response.setHeader("X-Correlation-Id", correlationId);
    }
    return next.handle().pipe(map((data) => data));
  }
}
