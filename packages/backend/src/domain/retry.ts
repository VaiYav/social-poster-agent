// Retry utilities — exponential backoff with jitter for resilient automation.
//
// Inspired by:
//   - twscrape: network errors retry infinitely, unknown errors lock 15min
//   - facebook-scraper: 6 retries with exponential backoff (retry * 2s)
//   - forage: 3 retries with exponential backoff + ±25% jitter
//
// Usage:
//   const result = await withRetry(
//     () => someFailingOperation(),
//     { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
//   );

/** Options for withRetry. */
export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial try). Default: 3. */
  maxRetries?: number;
  /** Base delay in ms — doubled each retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Jitter factor (0–1) — adds ±(factor × delay) randomness. Default: 0.25. */
  jitter?: number;
  /**
   * Predicate to decide if an error is retryable.
   * If not provided, all errors are retried.
   * Return false to stop retrying immediately (e.g., for non-retryable SpaErrors).
   */
  retryable?: (err: unknown) => boolean;
  /** Called before each retry with the attempt number and delay. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Execute an async operation with exponential backoff and jitter.
 *
 * Delay formula: min(baseDelay × 2^attempt, maxDelay) ± jitter × delay
 *
 * @returns The result of `operation` if it succeeds within the retry budget.
 * @throws The last error if all retries are exhausted or `retryable` returns false.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const jitter = opts.jitter ?? 0.25;
  const retryable = opts.retryable ?? (() => true);

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;

      // Check if error is retryable
      if (!retryable(err)) {
        throw err;
      }

      // Last attempt — no more retries
      if (attempt >= maxRetries) {
        throw err;
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitterAmount = exponentialDelay * jitter * (Math.random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(exponentialDelay + jitterAmount));

      opts.onRetry?.(attempt + 1, delayMs, err);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastErr;
}

/**
 * Navigate to a URL with retry on timeout/network error.
 * Inspired by forage's `navigate_with_retry` — retries with exponential backoff.
 *
 * @param page Playwright page
 * @param url URL to navigate to
 * @param opts Navigation + retry options
 */
export async function navigateWithRetry(
  page: import('playwright-core').Page,
  url: string,
  opts: {
    waitUntil?: 'networkidle' | 'domcontentloaded' | 'load';
    timeoutMs?: number;
    maxRetries?: number;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  } = {},
): Promise<void> {
  const { waitUntil = 'domcontentloaded', timeoutMs = 30000, maxRetries = 3, onRetry } = opts;

  await withRetry(
    async () => {
      // Skip the goto entirely if the page already crashed/closed — avoids
      // a guaranteed "Target page, context or browser has been closed" error
      // and the wasted retry backoff on a dead page.
      if (page.isClosed?.()) {
        throw new Error('Page is closed — cannot navigate');
      }
      await page.goto(url, { waitUntil, timeout: timeoutMs });
    },
    {
      maxRetries,
      baseDelayMs: 2000,
      maxDelayMs: 30000,
      jitter: 0.25,
      retryable: (err) => {
        const msg = (err as Error).message ?? String(err);
        // Don't retry on a closed page — the context is dead, caller must acquire a new page
        if (msg.includes('Page is closed') || msg.includes('Target page, context or browser has been closed')) {
          return false;
        }
        // Retry on timeout and network errors
        return (
          msg.includes('Timeout') ||
          msg.includes('net::ERR') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('ERR_INTERNET_DISCONNECTED') ||
          msg.includes('Navigation failed')
        );
      },
      onRetry,
    },
  );
}

/**
 * Sleep for a random duration within a range.
 * Useful for adding human-like delays between retries.
 */
export function randomSleep(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
