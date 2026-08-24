import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { ZodError } from "zod";

/**
 * Global exception filter — converts ZodError to HTTP 400 Bad Request.
 *
 * Without this filter, ZodError thrown by `.parse()` in controllers
 * propagates as an unhandled exception → HTTP 500 Internal Server Error.
 *
 * This filter catches:
 * - ZodError → 400 with structured validation error details
 * - HttpException → passed through to NestJS default handler
 * - Everything else → 500 with redacted message
 */
@Catch()
export class ZodValidationFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof ZodError) {
      const errors = exception.issues.map((err) => ({
        path: err.path.join("."),
        message: err.message,
        code: err.code,
      }));

      this.logger.warn(
        `Validation failed: ${request.method} ${request.url} — ${errors.length} error(s)`,
      );

      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        message: "Validation failed",
        details: errors,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      response
        .status(status)
        .json(typeof res === "string" ? { statusCode: status, message: res } : res);
      return;
    }

    // Unknown error — don't leak internals
    this.logger.error(
      `Unhandled exception: ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  }
}
