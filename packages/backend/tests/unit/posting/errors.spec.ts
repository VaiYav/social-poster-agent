/**
 * Error Classification unit tests.
 *
 * Tests the typed error classes and classifyPlaywrightError function.
 *
 * Source: packages/backend/src/domain/errors.ts
 */
import { describe, it, expect } from 'vitest';
import {
  SpaError,
  SelectorNotFoundError,
  ValidationError,
  LoginFailedError,
  ComposeDialogError,
  RateLimitError,
  NetworkError,
  CaptchaError,
  AccountRestrictedError,
  classifyPlaywrightError,
} from '../../../src/domain/errors';

describe('Error Classification', () => {
  describe('Typed Error Classes', () => {
    it('SelectorNotFoundError has correct properties', () => {
      const err = new SelectorNotFoundError('THREADS', 'compose button');
      expect(err.name).toBe('SelectorNotFoundError');
      expect(err.network).toBe('THREADS');
      expect(err.message).toContain('compose button');
      expect(err.code).toBe('SELECTOR_NOT_FOUND');
      expect(err.retryable).toBe(false);
      expect(err.selectorContext).toBe('compose button');
    });

    it('ValidationError has correct properties', () => {
      const err = new ValidationError('FACEBOOK', 'Post not found', {
        actualUrl: 'https://fb.com',
        expectedPattern: '/posts/\\d+',
      });
      expect(err.name).toBe('ValidationError');
      expect(err.network).toBe('FACEBOOK');
      expect(err.actualUrl).toBe('https://fb.com');
      expect(err.expectedPattern).toBe('/posts/\\d+');
      expect(err.code).toBe('POST_VALIDATION_FAILED');
      expect(err.retryable).toBe(false);
    });

    it('LoginFailedError has correct properties', () => {
      const err = new LoginFailedError('X', 'wrong_credentials');
      expect(err.name).toBe('LoginFailedError');
      expect(err.network).toBe('X');
      expect(err.reason).toBe('wrong_credentials');
      expect(err.retryable).toBe(false);
    });

    it('LoginFailedError session_expired is retryable', () => {
      const err = new LoginFailedError('X', 'session_expired');
      expect(err.retryable).toBe(true);
    });

    it('ComposeDialogError has correct properties', () => {
      const err = new ComposeDialogError('THREADS', 'Dialog did not open');
      expect(err.name).toBe('ComposeDialogError');
      expect(err.code).toBe('COMPOSE_DIALOG_FAILED');
      expect(err.retryable).toBe(false);
    });

    it('RateLimitError has correct properties', () => {
      const err = new RateLimitError('X', 'Too many posts', 60000);
      expect(err.name).toBe('RateLimitError');
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(60000);
    });

    it('NetworkError has correct properties', () => {
      const err = new NetworkError('X', 'Connection failed');
      expect(err.name).toBe('NetworkError');
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.retryable).toBe(true);
    });

    it('CaptchaError has correct properties', () => {
      const err = new CaptchaError('X', 'captcha', 'https://x.com/challenge');
      expect(err.name).toBe('CaptchaError');
      expect(err.code).toBe('CAPTCHA_CHALLENGE');
      expect(err.retryable).toBe(false);
      expect(err.challengeType).toBe('captcha');
    });

    it('AccountRestrictedError has correct properties', () => {
      const err = new AccountRestrictedError('X', 'Account suspended');
      expect(err.name).toBe('AccountRestrictedError');
      expect(err.code).toBe('ACCOUNT_RESTRICTED');
      expect(err.retryable).toBe(false);
    });

    it('All errors extend SpaError (abstract base)', () => {
      expect(new SelectorNotFoundError('X', 'test') instanceof SpaError).toBe(true);
      expect(new ValidationError('X', 'test') instanceof SpaError).toBe(true);
      expect(new LoginFailedError('X', 'unknown') instanceof SpaError).toBe(true);
      expect(new ComposeDialogError('X', 'test') instanceof SpaError).toBe(true);
      expect(new RateLimitError('X') instanceof SpaError).toBe(true);
      expect(new NetworkError('X', 'test') instanceof SpaError).toBe(true);
      expect(new CaptchaError('X', 'captcha', 'url') instanceof SpaError).toBe(true);
      expect(new AccountRestrictedError('X') instanceof SpaError).toBe(true);
    });
  });

  describe('classifyPlaywrightError', () => {
    it('classifies timeout+locator errors as SelectorNotFoundError', () => {
      const err = new Error('Timeout 30000ms exceeded waiting for locator');
      const classified = classifyPlaywrightError(err, 'X', 'compose button');
      expect(classified).toBeInstanceOf(SelectorNotFoundError);
    });

    it('classifies timeout+waiting errors as SelectorNotFoundError', () => {
      const err = new Error('Timeout 10000ms exceeded waiting for selector');
      const classified = classifyPlaywrightError(err, 'X', 'compose button');
      expect(classified).toBeInstanceOf(SelectorNotFoundError);
    });

    it('classifies network errors as NetworkError', () => {
      const err = new Error('net::ERR_CONNECTION_REFUSED');
      const classified = classifyPlaywrightError(err, 'X', 'navigation');
      expect(classified).toBeInstanceOf(NetworkError);
    });

    it('classifies rate limit errors as RateLimitError', () => {
      const err = new Error('Rate limit exceeded. Try again later.');
      const classified = classifyPlaywrightError(err, 'X', 'posting');
      expect(classified).toBeInstanceOf(RateLimitError);
    });

    it('classifies account suspended as AccountRestrictedError', () => {
      const err = new Error('Account temporarily limited');
      const classified = classifyPlaywrightError(err, 'X', 'posting');
      expect(classified).toBeInstanceOf(AccountRestrictedError);
    });

    it('classifies captcha URLs as CaptchaError', () => {
      const err = new Error('Some error');
      const classified = classifyPlaywrightError(err, 'X', 'login', {
        pageUrl: 'https://x.com/challenge/captcha',
      });
      expect(classified).toBeInstanceOf(CaptchaError);
    });

    it('classifies generic errors as NetworkError (fallback)', () => {
      const err = new Error('Something went wrong');
      const classified = classifyPlaywrightError(err, 'THREADS', 'unknown');
      expect(classified).toBeInstanceOf(NetworkError);
    });

    it('preserves screenshotPath in classified error', () => {
      const err = new Error('Timeout 10000ms exceeded waiting for locator');
      const classified = classifyPlaywrightError(err, 'X', 'test', {
        screenshotPath: '/tmp/screenshot.png',
      });
      expect(classified.screenshotPath).toBe('/tmp/screenshot.png');
    });
  });
});
