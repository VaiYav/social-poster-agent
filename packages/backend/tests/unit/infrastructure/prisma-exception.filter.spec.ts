/**
 * PrismaClientExceptionFilter unit tests.
 *
 * Source: packages/backend/src/infrastructure/filters/prisma-exception.filter.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaClientExceptionFilter } from '../../../src/infrastructure/filters/prisma-exception.filter';

function createMockHost(): ArgumentsHost {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return {
    switchToHttp: () => ({
      getResponse: () => ({ status, json }),
      getRequest: () => ({ method: 'POST', url: '/api/v1/posts' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('PrismaClientExceptionFilter', () => {
  it('maps P2002 unique constraint to 409 Conflict', () => {
    const filter = new PrismaClientExceptionFilter();
    const host = createMockHost();
    const res = host.switchToHttp().getResponse();
    const exception = new PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '0.0.0', meta: { target: ['email'] } },
    );

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: expect.stringContaining('already exists'),
    });
  });

  it('maps P2025 record not found to 404 Not Found', () => {
    const filter = new PrismaClientExceptionFilter();
    const host = createMockHost();
    const res = host.switchToHttp().getResponse();
    const exception = new PrismaClientKnownRequestError(
      'Record not found',
      { code: 'P2025', clientVersion: '0.0.0' },
    );

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      error: 'Not Found',
      message: expect.stringContaining('not found'),
    });
  });

  it('maps P2024 transaction timeout to 504 Gateway Timeout', () => {
    const filter = new PrismaClientExceptionFilter();
    const host = createMockHost();
    const res = host.switchToHttp().getResponse();
    const exception = new PrismaClientKnownRequestError(
      'Transaction timeout',
      { code: 'P2024', clientVersion: '0.0.0' },
    );

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      statusCode: HttpStatus.GATEWAY_TIMEOUT,
      error: 'Gateway Timeout',
      message: expect.stringContaining('timed out'),
    });
  });

  it('maps unknown Prisma codes to 500 Internal Server Error', () => {
    const filter = new PrismaClientExceptionFilter();
    const host = createMockHost();
    const res = host.switchToHttp().getResponse();
    const exception = new PrismaClientKnownRequestError(
      'Unknown error',
      { code: 'P9999', clientVersion: '0.0.0' },
    );

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: expect.stringContaining('database error'),
    });
  });
});
