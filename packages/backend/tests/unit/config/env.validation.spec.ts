import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../../../src/infrastructure/config/env.validation.js';

describe('validateEnv', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('does not throw when env vars are valid', () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it('throws on invalid numeric BROWSER_* env vars', () => {
    process.env.BROWSER_POOL_SIZE = 'abc';
    expect(() => validateEnv()).toThrow(/BROWSER_POOL_SIZE/);
  });

  it('throws on invalid numeric RATE_LIMIT_* env vars', () => {
    process.env.RATE_LIMIT_X_MAX_PER_DAY = 'not-a-number';
    expect(() => validateEnv()).toThrow(/RATE_LIMIT_X_MAX_PER_DAY/);
  });

  it('throws on invalid numeric PRISMA_* env vars', () => {
    process.env.PRISMA_CONNECTION_LIMIT = 'zero';
    expect(() => validateEnv()).toThrow(/PRISMA_CONNECTION_LIMIT/);
  });

  it('throws on invalid numeric F1_BROWSING_SESSION_MINUTES', () => {
    process.env.F1_BROWSING_SESSION_MINUTES = '15abc';
    expect(() => validateEnv()).toThrow(/F1_BROWSING_SESSION_MINUTES/);
  });
});
