import { ConfigService } from "@nestjs/config";

/**
 * Per-provider rate-limit backoff state.
 *
 * Tracks consecutive 429s and a sliding window of 429 strikes so we can tell
 * the difference between a single burst (short retry) and a provider that is
 * actually exhausted for minutes/hours (long cooldown).
 */
interface RateLimitState {
  consecutive429s: number;
  strikeHistory: number[];
  nextAvailableAt: number;
}

/**
 * Read-only view of a provider's rate-limit status.
 */
export interface RateLimitStatus {
  rateLimitUntil: number;
  rateLimitStrikes: number;
  consecutive429s: number;
}

/**
 * Per-provider rate-limit "penalty box".
 *
 * Parses `Retry-After` / `x-ratelimit-reset-*` headers and falls back to
 * exponential + sliding-window backoff when providers don't tell us when they
 * will recover. This keeps a rate-limited model from being re-entered on every
 * call.
 */
export class LlmProviderRateLimit {
  private readonly states = new Map<string, RateLimitState>();
  private readonly maxCooldownMs: number;
  private readonly baseBackoffMs: number;
  private readonly strikeWindowMs: number;
  private readonly strikeThreshold: number;
  private readonly strikePenaltyMs: number;
  /** Max delay we are willing to wait for a same-provider retry before failing over. */
  readonly retryAfterMaxMs: number;

  constructor(private readonly config: ConfigService) {
    this.maxCooldownMs = this.readConfigNumber(
      "LLM_RATE_LIMIT_MAX_COOLDOWN_MS",
      2 * 60 * 60 * 1000,
    );
    this.baseBackoffMs = this.readConfigNumber("LLM_RATE_LIMIT_BASE_BACKOFF_MS", 10_000);
    this.strikeWindowMs = this.readConfigNumber("LLM_RATE_LIMIT_STRIKE_WINDOW_MS", 10 * 60 * 1000);
    this.strikeThreshold = this.readConfigNumber("LLM_RATE_LIMIT_STRIKE_THRESHOLD", 3, {
      allowZero: true,
    });
    this.strikePenaltyMs = this.readConfigNumber(
      "LLM_RATE_LIMIT_STRIKE_PENALTY_MS",
      30 * 60 * 1000,
    );
    this.retryAfterMaxMs = this.readConfigNumber("LLM_RATE_LIMIT_RETRY_AFTER_MAX_MS", 10_000);
  }

  /**
   * Returns true if the provider has no active rate-limit cooldown.
   */
  isAvailable(name: string, now = Date.now()): boolean {
    const state = this.states.get(name);
    if (!state) return true;
    return now >= state.nextAvailableAt;
  }

  /**
   * Record a 429 for a provider and compute its next available time.
   * If `retryAfterMs` is known from headers, use it; otherwise exponential.
   */
  recordRateLimit(
    name: string,
    retryAfterMs: number | undefined,
    now = Date.now(),
  ): RateLimitStatus {
    const state = this.getOrCreateState(name);

    state.consecutive429s += 1;
    state.strikeHistory.push(now);
    state.strikeHistory = state.strikeHistory.filter((t) => t > now - this.strikeWindowMs);

    let backoffMs = retryAfterMs;
    if (backoffMs === undefined || !Number.isFinite(backoffMs) || backoffMs <= 0) {
      backoffMs = Math.min(
        this.maxCooldownMs,
        this.baseBackoffMs * 2 ** (state.consecutive429s - 1),
      );
    }

    if (state.strikeHistory.length >= this.strikeThreshold) {
      backoffMs = Math.max(backoffMs, this.strikePenaltyMs);
    }

    backoffMs = Math.min(backoffMs, this.maxCooldownMs);

    const base = Math.max(now, state.nextAvailableAt);
    state.nextAvailableAt = base + backoffMs;

    return this.statusFromState(state, now);
  }

  /**
   * Reset rate-limit counters when a provider succeeds.
   * Keep strikeHistory so sustained flakiness still escalates quickly.
   */
  recordSuccess(name: string): void {
    const state = this.states.get(name);
    if (!state) return;
    state.consecutive429s = 0;
    state.nextAvailableAt = 0;
  }

  /**
   * Reset rate-limit state for the given providers, or all providers.
   */
  reset(providerNames?: string[]): void {
    if (providerNames && providerNames.length > 0) {
      for (const name of providerNames) {
        this.states.delete(name);
      }
    } else {
      this.states.clear();
    }
  }

  /**
   * Get the current rate-limit status for a provider.
   */
  getStatus(name: string, now = Date.now()): RateLimitStatus {
    const state = this.states.get(name);
    if (!state) {
      return { rateLimitUntil: 0, rateLimitStrikes: 0, consecutive429s: 0 };
    }
    return this.statusFromState(state, now);
  }

  /**
   * Extract retry-after / rate-limit reset delta (ms) from a thrown error.
   */
  static parseRetryAfterMs(err: unknown, now = Date.now()): number | undefined {
    const rawHeaders = this.isErrorWithHeaders(err) ? err.headers : undefined;
    const headers = this.normalizeHeaders(rawHeaders);
    if (!headers) {
      return this.parseRetryAfterMessage(err, now);
    }

    const fromRetryAfter = this.parseRetryAfterHeader(headers, now);
    if (fromRetryAfter !== undefined) return fromRetryAfter;

    const fromReset = this.parseRateLimitResetHeaders(headers, now);
    if (fromReset !== undefined) return fromReset;

    return this.parseRetryAfterMessage(err, now);
  }

  /**
   * Safely extract a human-readable error message from various error shapes.
   */
  static extractErrorMessage(err: unknown): string {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message;
    if (typeof err === "object") {
      const message = Reflect.get(err, "message");
      if (typeof message === "string" && message) return message;
      const status = this.extractStatusCode(err);
      if (status) return `HTTP ${status}`;
    }
    return "unknown error";
  }

  /**
   * Safely extract an HTTP status code from various error shapes.
   */
  static extractStatusCode(err: unknown): number | undefined {
    if (err && typeof err === "object") {
      const status = Reflect.get(err, "status") ?? Reflect.get(err, "statusCode");
      if (typeof status === "number") return status;
    }
    return undefined;
  }

  private getOrCreateState(name: string): RateLimitState {
    let state = this.states.get(name);
    if (!state) {
      state = {
        consecutive429s: 0,
        strikeHistory: [],
        nextAvailableAt: 0,
      };
      this.states.set(name, state);
    }
    return state;
  }

  private statusFromState(state: RateLimitState, now: number): RateLimitStatus {
    const strikeCutoff = now - this.strikeWindowMs;
    return {
      rateLimitUntil: state.nextAvailableAt,
      rateLimitStrikes: state.strikeHistory.filter((t) => t > strikeCutoff).length,
      consecutive429s: state.consecutive429s,
    };
  }

  private readConfigNumber(
    key: string,
    defaultValue: number,
    opts: { allowZero?: boolean } = {},
  ): number {
    const raw = this.config.get<string | number>(key, defaultValue);
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    if (opts.allowZero ? n >= 0 : n > 0) return n;
    return defaultValue;
  }

  private static normalizeHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof headers !== "object") return undefined;

    if (this.isHeaderMap(headers)) {
      const record: Record<string, string> = {};
      headers.forEach((value, key) => {
        record[key.toLowerCase()] = value;
      });
      return record;
    }

    if (this.isHeaderGetter(headers)) {
      const record: Record<string, string> = {};
      for (const key of [
        "retry-after",
        "x-ratelimit-reset-requests",
        "x-ratelimit-reset-tokens",
        "x-ratelimit-reset",
      ]) {
        const value = headers.get(key);
        if (value) record[key] = value;
      }
      return record;
    }

    return this.isPlainHeaderRecord(headers) ? headers : undefined;
  }

  private static isErrorWithHeaders(err: unknown): err is { headers: unknown } {
    return typeof err === "object" && err !== null && "headers" in err;
  }

  private static isHeaderMap(
    value: unknown,
  ): value is { forEach(callback: (value: string, key: string) => void): void } {
    if (!value || typeof value !== "object") return false;
    const forEach = Reflect.get(value, "forEach");
    return typeof forEach === "function";
  }

  private static isHeaderGetter(value: unknown): value is { get(name: string): string | null } {
    if (!value || typeof value !== "object") return false;
    const get = Reflect.get(value, "get");
    return typeof get === "function";
  }

  private static isPlainHeaderRecord(value: unknown): value is Record<string, string> {
    if (typeof value !== "object" || value === null) return false;
    for (const v of Object.values(value)) {
      if (typeof v !== "string") return false;
    }
    return true;
  }

  private static parseRetryAfterHeader(
    headers: Record<string, string>,
    now: number,
  ): number | undefined {
    const value = headers["retry-after"];
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }

    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      const delta = date - now;
      if (delta > 0) return delta;
    }

    return undefined;
  }

  private static parseRateLimitResetHeaders(
    headers: Record<string, string>,
    now: number,
  ): number | undefined {
    const resetKeys = [
      "x-ratelimit-reset-requests",
      "x-ratelimit-reset-tokens",
      "x-ratelimit-reset",
    ];
    let maxResetMs = 0;
    for (const key of resetKeys) {
      const value = headers[key];
      if (value) {
        const ts = this.parseResetValue(value, now);
        if (ts) {
          const delta = ts - now;
          if (delta > maxResetMs) maxResetMs = delta;
        }
      }
    }
    return maxResetMs > 0 ? maxResetMs : undefined;
  }

  private static parseRetryAfterMessage(err: unknown, now: number): number | undefined {
    const message = this.extractErrorMessage(err);
    const match = message.match(
      /(?:try again|retry after|try back)\s+in\s+([\d.]+)\s*(ms|sec|secs|seconds?|s|min|mins|minutes?|m|hour|hours?|h)/i,
    );
    if (!match) return undefined;
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0 || !unit) return undefined;
    return this.convertDurationToMs(amount, unit);
  }

  private static convertDurationToMs(amount: number, unit: string): number | undefined {
    if (unit.startsWith("ms")) return amount;
    if (unit.startsWith("s")) return amount * 1000;
    if (unit.startsWith("m")) return amount * 60 * 1000;
    if (unit.startsWith("h")) return amount * 60 * 60 * 1000;
    return undefined;
  }

  private static parseResetValue(value: string, now: number): number | undefined {
    value = value.trim();
    if (!value) return undefined;

    const duration = this.parseDurationValue(value);
    if (duration !== undefined) return now + duration;

    return this.parseTimestampValue(value, now);
  }

  private static parseDurationValue(value: string): number | undefined {
    const durationMatch = value.match(/^([\d.]+)\s*(ms|s|m|h)$/i);
    if (!durationMatch) return undefined;
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (!unit || !Number.isFinite(amount) || amount <= 0) return undefined;
    if (unit === "ms") return amount;
    if (unit === "s") return amount * 1000;
    if (unit === "m") return amount * 60 * 1000;
    if (unit === "h") return amount * 60 * 60 * 1000;
    return undefined;
  }

  private static parseTimestampValue(value: string, now: number): number | undefined {
    // Pure numeric values are seconds relative to now (small) or Unix timestamps
    // (large). We must check this before Date.parse, which interprets short
    // numeric strings like "120" as legacy date strings and returns a wrong date.
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      if (num < 1_000_000_000) {
        // seconds remaining (relative)
        return now + num * 1000;
      }
      if (num < 10_000_000_000) {
        // Unix seconds (absolute)
        return num * 1000;
      }
      // Unix milliseconds (absolute)
      return num;
    }

    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;

    return undefined;
  }
}
