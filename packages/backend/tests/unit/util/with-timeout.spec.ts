/**
 * BUG-8: withTimeout — bounds a dependency probe so a hung connection cannot
 * hang the caller (e.g. the /health endpoint).
 *
 * Source: packages/backend/src/infrastructure/util/with-timeout.ts
 */
import { describe, it, expect } from 'vitest';

import { withTimeout } from '../../../src/infrastructure/util/with-timeout';

describe('withTimeout (BUG-8)', () => {
  it('passes through a resolved value', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('propagates the underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a timeout when the promise never settles', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 10, 'redis health')).rejects.toThrow(
      /redis health timed out after 10ms/,
    );
  });
});
