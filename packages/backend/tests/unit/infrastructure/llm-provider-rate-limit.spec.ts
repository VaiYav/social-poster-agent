/**
 * Sprint Q: LlmProviderRateLimit unit tests.
 *
 * Tests retry-after header parsing and per-provider exponential cooldown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { LlmProviderRateLimit } from '../../../src/infrastructure/llm/llm-provider-rate-limit';

function makeConfig(overrides: Record<string, number> = {}): ConfigService {
  const defaults: Record<string, number> = {
    LLM_RATE_LIMIT_MAX_COOLDOWN_MS: 2 * 60 * 60 * 1000,
    LLM_RATE_LIMIT_BASE_BACKOFF_MS: 10_000,
    LLM_RATE_LIMIT_STRIKE_WINDOW_MS: 10 * 60 * 1000,
    LLM_RATE_LIMIT_STRIKE_THRESHOLD: 3,
    LLM_RATE_LIMIT_STRIKE_PENALTY_MS: 30 * 60 * 1000,
    LLM_RATE_LIMIT_RETRY_AFTER_MAX_MS: 10_000,
  };
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : key in defaults ? defaults[key] : defaultValue,
  } as unknown as ConfigService;
}

describe('LlmProviderRateLimit', () => {
  let backoff: LlmProviderRateLimit;
  let now: number;

  beforeEach(() => {
    now = 1_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    backoff = new LlmProviderRateLimit(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseRetryAfterMs', () => {
    it('parses Retry-After seconds', () => {
      const err = { headers: { 'retry-after': '5' } };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(5_000);
    });

    it('parses Retry-After as an HTTP date', () => {
      const reset = new Date(now + 60_000).toUTCString();
      const err = { headers: { 'retry-after': reset } };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(60_000);
    });

    it('parses x-ratelimit-reset-requests as ISO timestamp', () => {
      const reset = new Date(now + 60_000).toISOString();
      const err = { headers: { 'x-ratelimit-reset-requests': reset } };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(60_000);
    });

    it('parses x-ratelimit-reset-requests as numeric seconds', () => {
      const err = { headers: { 'x-ratelimit-reset-requests': '120' } };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(120_000);
    });

    it('parses x-ratelimit-reset-tokens as duration string', () => {
      const err = { headers: { 'x-ratelimit-reset-tokens': '1.5s' } };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(1_500);
    });

    it('uses the larger of request and token reset times', () => {
      const err = {
        headers: {
          'x-ratelimit-reset-requests': '5s',
          'x-ratelimit-reset-tokens': '30s',
        },
      };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(30_000);
    });

    it('parses "try again in Xs" from the error message', () => {
      const err = new Error('Rate limit reached. Please try again in 12.5s');
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(12_500);
    });

    it('returns undefined when no retry information is present', () => {
      const err = new Error('429 status code (no body)');
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBeUndefined();
    });

    it('handles Headers instance with lowercase keys', () => {
      const headers = new Headers([['retry-after', '2']]);
      const err = { headers };
      expect(LlmProviderRateLimit.parseRetryAfterMs(err, now)).toBe(2_000);
    });
  });

  describe('recordRateLimit', () => {
    it('sets exponential backoff when no retry-after is known', () => {
      backoff.recordRateLimit('groq', undefined, now);
      const status = backoff.getStatus('groq', now);
      expect(status.consecutive429s).toBe(1);
      expect(status.rateLimitUntil).toBe(now + 10_000);
    });

    it('uses provided retry-after when known', () => {
      backoff.recordRateLimit('groq', 5_000, now);
      const status = backoff.getStatus('groq', now);
      expect(status.rateLimitUntil).toBe(now + 5_000);
    });

    it('doubles backoff on consecutive 429s', () => {
      backoff.recordRateLimit('groq', undefined, now);
      backoff.recordRateLimit('groq', undefined, now + 10_000);
      const status = backoff.getStatus('groq', now + 10_000);
      expect(status.consecutive429s).toBe(2);
      expect(status.rateLimitUntil).toBe(now + 10_000 + 20_000);
    });

    it('caps backoff at max cooldown', () => {
      backoff.recordRateLimit('groq', 10_000_000_000, now);
      const status = backoff.getStatus('groq', now);
      expect(status.rateLimitUntil).toBe(now + 2 * 60 * 60 * 1000);
    });

    it('applies sustained cooldown after strike threshold', () => {
      // 3 429s within the window should trigger the 30-minute penalty.
      // Previous cooldowns are extended, so the final until is previous nextAvailableAt + penalty.
      backoff.recordRateLimit('groq', undefined, now);
      backoff.recordRateLimit('groq', undefined, now + 100);
      backoff.recordRateLimit('groq', undefined, now + 200);
      const status = backoff.getStatus('groq', now + 200);
      expect(status.rateLimitStrikes).toBe(3);
      expect(status.rateLimitUntil).toBeGreaterThanOrEqual(now + 30 * 60 * 1000);
      expect(status.consecutive429s).toBe(3);
    });
  });

  describe('isAvailable', () => {
    it('returns false while in cooldown', () => {
      backoff.recordRateLimit('groq', 10_000, now);
      expect(backoff.isAvailable('groq', now)).toBe(false);
      expect(backoff.isAvailable('groq', now + 10_000)).toBe(true);
    });

    it('returns true for providers with no state', () => {
      expect(backoff.isAvailable('openai', now)).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('resets consecutive 429s and cooldown', () => {
      backoff.recordRateLimit('groq', 10_000, now);
      backoff.recordSuccess('groq');
      const status = backoff.getStatus('groq', now);
      expect(status.consecutive429s).toBe(0);
      expect(status.rateLimitUntil).toBe(0);
    });
  });
});
