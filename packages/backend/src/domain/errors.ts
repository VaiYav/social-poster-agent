// Typed errors for social media automation.
// Each error type has a `retryable` flag — determines if BullMQ should retry.

import type { SocialNetwork } from '@spa/shared';

/** Base error class for all SPA automation errors. */
export abstract class SpaError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  readonly network: SocialNetwork;
  readonly screenshotPath?: string;

  constructor(
    message: string,
    network: SocialNetwork,
    opts?: { screenshotPath?: string; cause?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.network = network;
    if (opts?.screenshotPath) this.screenshotPath = opts.screenshotPath;
    if (opts?.cause) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/**
 * Selector not found — the UI changed and our selectors don't match.
 * NOT retryable — needs a code fix to update selectors.
 */
export class SelectorNotFoundError extends SpaError {
  readonly code = 'SELECTOR_NOT_FOUND';
  readonly retryable = false;
  readonly selectorContext: string;

  constructor(
    network: SocialNetwork,
    selectorContext: string,
    opts?: { screenshotPath?: string },
  ) {
    super(
      `Selector not found on ${network}: ${selectorContext} — UI may have changed`,
      network,
      opts,
    );
    this.selectorContext = selectorContext;
  }
}

/**
 * Login failed — credentials wrong, 2FA required, or session expired.
 * NOT retryable for wrong credentials / 2FA. Retryable for transient session issues.
 */
export class LoginFailedError extends SpaError {
  readonly code = 'LOGIN_FAILED';
  readonly retryable: boolean;
  readonly reason: 'wrong_credentials' | 'captcha' | 'two_factor' | 'session_expired' | 'unknown';

  constructor(
    network: SocialNetwork,
    reason: LoginFailedError['reason'],
    message?: string,
    opts?: { screenshotPath?: string; retryable?: boolean },
  ) {
    const msg = message ?? `Login failed for ${network}: ${reason}`;
    super(msg, network, opts);
    this.reason = reason;
    // Captcha and 2FA are not retryable (need manual intervention).
    // Wrong credentials are not retryable. Session expired is retryable (will re-login).
    this.retryable = opts?.retryable ?? reason === 'session_expired';
  }
}

/**
 * Rate limited by the social network.
 * Retryable — BullMQ will retry after backoff (rate window will have passed).
 */
export class RateLimitError extends SpaError {
  readonly code = 'RATE_LIMITED';
  readonly retryable = true;
  readonly retryAfterMs?: number;

  constructor(network: SocialNetwork, message?: string, retryAfterMs?: number) {
    super(message ?? `Rate limited on ${network}`, network);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Captcha or 2FA challenge detected during login or posting.
 * NOT retryable — requires manual intervention.
 */
export class CaptchaError extends SpaError {
  readonly code = 'CAPTCHA_CHALLENGE';
  readonly retryable = false;
  readonly challengeType: 'captcha' | 'two_factor' | 'checkpoint';

  constructor(
    network: SocialNetwork,
    challengeType: CaptchaError['challengeType'],
    pageUrl: string,
    opts?: { screenshotPath?: string },
  ) {
    super(
      `${challengeType} challenge on ${network} at ${pageUrl} — manual intervention needed`,
      network,
      opts,
    );
    this.challengeType = challengeType;
  }
}

/**
 * Network error — connection timeout, DNS failure, etc.
 * Retryable — transient issue.
 */
export class NetworkError extends SpaError {
  readonly code = 'NETWORK_ERROR';
  readonly retryable = true;

  constructor(network: SocialNetwork, message: string, opts?: { cause?: unknown }) {
    super(message, network, opts);
  }
}

/**
 * Validation error — post was submitted but didn't appear on profile.
 * NOT retryable — something went wrong (compose dialog didn't open, text not entered,
 * or post was silently rejected). Need to investigate via screenshots.
 */
export class ValidationError extends SpaError {
  readonly code = 'POST_VALIDATION_FAILED';
  readonly retryable = false;
  readonly expectedPattern?: string;
  readonly actualUrl?: string;

  constructor(
    network: SocialNetwork,
    message: string,
    opts?: {
      screenshotPath?: string;
      expectedPattern?: string;
      actualUrl?: string;
    },
  ) {
    super(message, network, opts);
    if (opts?.expectedPattern) this.expectedPattern = opts.expectedPattern;
    if (opts?.actualUrl) this.actualUrl = opts.actualUrl;
  }
}

/**
 * Compose dialog error — the compose/create post dialog didn't open.
 * NOT retryable — UI may have changed or account may be restricted.
 */
export class ComposeDialogError extends SpaError {
  readonly code = 'COMPOSE_DIALOG_FAILED';
  readonly retryable = false;

  constructor(network: SocialNetwork, message?: string, opts?: { screenshotPath?: string }) {
    super(message ?? `Compose dialog did not open on ${network}`, network, opts);
  }
}

/**
 * Account suspended or restricted by the social network.
 * NOT retryable — need to resolve the account issue.
 */
export class AccountRestrictedError extends SpaError {
  readonly code = 'ACCOUNT_RESTRICTED';
  readonly retryable = false;

  constructor(network: SocialNetwork, message?: string) {
    super(message ?? `Account restricted/suspended on ${network}`, network);
  }
}

/**
 * Classify a generic Playwright error into a typed SpaError.
 * Used by posters when catching errors from locator operations.
 */
export function classifyPlaywrightError(
  err: unknown,
  network: SocialNetwork,
  context: string,
  opts?: { screenshotPath?: string; pageUrl?: string },
): SpaError {
  const message = (err as Error).message ?? String(err);

  // Selector/locator timeout — UI changed
  if (
    message.includes('Timeout') &&
    (message.includes('locator') || message.includes('waiting for'))
  ) {
    return new SelectorNotFoundError(network, context, opts);
  }

  // Captcha/challenge URLs
  if (opts?.pageUrl) {
    const url = opts.pageUrl;
    if (url.includes('challenge') || url.includes('captcha')) {
      return new CaptchaError(network, 'captcha', url, opts);
    }
    if (url.includes('checkpoint') || url.includes('two_factor') || url.includes('2fa')) {
      return new CaptchaError(network, 'two_factor', url, opts);
    }
  }

  // Network errors
  if (
    message.includes('net::ERR') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ERR_INTERNET_DISCONNECTED')
  ) {
    return new NetworkError(network, message, { cause: err });
  }

  // Rate limit messages (common patterns)
  if (
    message.toLowerCase().includes('rate limit') ||
    message.toLowerCase().includes('too many requests') ||
    message.toLowerCase().includes('try again later')
  ) {
    return new RateLimitError(network, message);
  }

  // Account restricted/suspended
  if (
    message.toLowerCase().includes('suspended') ||
    message.toLowerCase().includes('restricted') ||
    message.toLowerCase().includes('locked') ||
    message.toLowerCase().includes('temporarily limited')
  ) {
    return new AccountRestrictedError(network, message);
  }

  // Default — unknown error, retryable as safety
  return new NetworkError(network, `Unknown error during ${context}: ${message}`, { cause: err });
}
