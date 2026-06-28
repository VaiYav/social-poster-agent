/**
 * A2: parseBool — single source of truth for boolean env-flag parsing.
 *
 * The codebase historically compared `=== 'true'` in ~25 places, so
 * `FLAG=TRUE` / `FLAG=1` / `FLAG=yes` silently meant "disabled" — a footgun for
 * security-relevant gates (AUTO_APPROVE_ENABLED, feature flags). This locks the
 * accepted truthy/falsy forms and the fallback contract.
 *
 * Source: packages/backend/src/infrastructure/config/parse-bool.ts
 */
import { describe, it, expect } from 'vitest';

import { parseBool } from '../../../src/infrastructure/config/parse-bool';

describe('parseBool (A2 — unified boolean flag parsing)', () => {
  it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON', 'y', 'Y'])(
    'treats %j as true (the historical `=== \'true\'` footgun)',
    (v) => {
      expect(parseBool(v)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF', 'n', 'N', ''])(
    'treats %j as false',
    (v) => {
      expect(parseBool(v)).toBe(false);
    },
  );

  it('trims surrounding whitespace before matching', () => {
    expect(parseBool('  true  ')).toBe(true);
    expect(parseBool('\tTRUE\n')).toBe(true);
    expect(parseBool('  0 ')).toBe(false);
  });

  it('passes through real booleans unchanged', () => {
    expect(parseBool(true)).toBe(true);
    expect(parseBool(false)).toBe(false);
  });

  it('returns the fallback for undefined / null (default false)', () => {
    expect(parseBool(undefined)).toBe(false);
    expect(parseBool(null)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool(null, true)).toBe(true);
  });

  it('returns the fallback for unrecognized values rather than guessing', () => {
    expect(parseBool('maybe')).toBe(false);
    expect(parseBool('enabled')).toBe(false);
    expect(parseBool('maybe', true)).toBe(true);
  });
});
