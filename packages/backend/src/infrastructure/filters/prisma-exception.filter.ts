import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

/**
 * Global exception filter that maps known Prisma Client errors to HTTP exceptions.
 *
 * Without this filter, Prisma errors bubble up as 500 Internal Server Error and
 * may leak raw database details to clients.
 *
 * Mapped codes:
 *   - P2002 → 409 Conflict (unique constraint violation)
 *   - P2025 → 404 Not Found (record not found)
 *   - P2024 → 504 Gateway Timeout (transaction timeout)
 */
@Catch(PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaClientExceptionFilter.name);

  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = this.mapStatus(exception.code);
    const message = this.mapMessage(exception);

    this.logger.warn(
      `Prisma ${exception.code}: ${request.method} ${request.url} → ${status} — ${message}`,
    );

    response.status(status).json({
      statusCode: status,
      error: this.getReasonPhrase(status),
      message,
    });
  }

  private mapStatus(code: string): number {
    switch (code) {
      case 'P2002':
        return HttpStatus.CONFLICT;
      case 'P2025':
        return HttpStatus.NOT_FOUND;
      case 'P2024':
        return HttpStatus.GATEWAY_TIMEOUT;
      default:
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }

  private mapMessage(exception: PrismaClientKnownRequestError): string {
    // Do not expose raw Prisma internals beyond the model/field targeted.
    switch (exception.code) {
      case 'P2002': {
        const meta = exception.meta as { target?: string[] } | undefined;
        const target = meta?.target?.join(', ') ?? 'unique constraint';
        return `Conflict: a record with this ${target} already exists`;
      }
      case 'P2025':
        return 'The requested record was not found';
      case 'P2024':
        return 'Database operation timed out, please try again';
      default:
        return 'A database error occurred';
    }
  }

  private getReasonPhrase(status: number): string {
    const map: Record<number, string> = {
      [HttpStatus.CONFLICT]: 'Conflict',
      [HttpStatus.NOT_FOUND]: 'Not Found',
      [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
      [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
    };
    return map[status] ?? 'Error';
  }
}
