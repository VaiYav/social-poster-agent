// Circuit breaker — stops repeated failures from hammering a failing service.
//
// Inspired by twscrape's account locking: when an account fails repeatedly,
// it's locked for 15 minutes to avoid IP bans and wasted resources.
//
// States:
//   CLOSED    — normal operation, requests pass through
//   OPEN      — circuit tripped, all requests fail immediately
//   HALF_OPEN — testing if the service recovered (one trial request allowed)
//
// Usage:
//   const breaker = new CircuitBreaker('x-login', { failureThreshold: 3, resetTimeoutMs: 900000 });
//   const result = await breaker.execute(() => someOperation());

import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 3. */
  failureThreshold?: number;
  /** Time in ms before transitioning from OPEN → HALF_OPEN. Default: 900000 (15 min). */
  resetTimeoutMs?: number;
  /** Time window in ms for counting failures. Default: 600000 (10 min). */
  failureWindowMs?: number;
}

interface FailureRecord {
  timestamp: number;
  error: string;
}

/**
 * Circuit breaker for protecting against repeated failures.
 *
 * When `failureThreshold` consecutive failures occur within `failureWindowMs`,
 * the circuit opens and blocks all requests for `resetTimeoutMs`.
 * After that, a single trial request is allowed (HALF_OPEN).
 * If it succeeds, the circuit closes. If it fails, the circuit re-opens.
 */
export class CircuitBreaker {
  private readonly logger: Logger;
  private state: CircuitState = 'CLOSED';
  private failures: FailureRecord[] = [];
  private lastFailureTime = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitBreakerOptions = {},
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  /** Current state of the circuit. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Execute an operation through the circuit breaker. */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'OPEN') {
      const remainingMs = (this.opts.resetTimeoutMs ?? 900000) - (Date.now() - this.openedAt);
      const msg = `Circuit "${this.name}" is OPEN — ${Math.ceil(remainingMs / 1000)}s until reset`;
      this.logger.warn(msg);
      throw new CircuitOpenError(this.name, remainingMs);
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  /** Check if the circuit would block a request without executing. */
  canExecute(): boolean {
    this.maybeTransitionToHalfOpen();
    return this.state !== 'OPEN';
  }

  /** Time until the circuit resets (in ms). 0 if not open. */
  get resetInMs(): number {
    if (this.state !== 'OPEN') return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, (this.opts.resetTimeoutMs ?? 900000) - elapsed);
  }

  /** Manually reset the circuit (e.g., after fixing the underlying issue). */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = [];
    this.openedAt = 0;
    this.logger.log(`Circuit "${this.name}" manually reset → CLOSED`);
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.log(`Circuit "${this.name}" HALF_OPEN → CLOSED (trial succeeded)`);
    }
    this.state = 'CLOSED';
    this.failures = [];
  }

  private onFailure(err: unknown): void {
    const errorMsg = (err as Error)?.message ?? String(err);
    const now = Date.now();
    this.lastFailureTime = now;
    this.failures.push({ timestamp: now, error: errorMsg });

    // Prune failures outside the window
    const windowMs = this.opts.failureWindowMs ?? 600000;
    this.failures = this.failures.filter((f) => now - f.timestamp < windowMs);

    const threshold = this.opts.failureThreshold ?? 3;

    if (this.state === 'HALF_OPEN') {
      // Trial failed — re-open the circuit
      this.openCircuit();
      this.logger.warn(
        `Circuit "${this.name}" HALF_OPEN → OPEN (trial failed: ${errorMsg})`,
      );
    } else if (this.failures.length >= threshold) {
      this.openCircuit();
      this.logger.error(
        `Circuit "${this.name}" CLOSED → OPEN (${this.failures.length} failures in ${windowMs / 1000}s)`,
      );
    }
  }

  private openCircuit(): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== 'OPEN') return;
    const resetMs = this.opts.resetTimeoutMs ?? 900000;
    if (Date.now() - this.openedAt >= resetMs) {
      this.state = 'HALF_OPEN';
      this.logger.log(`Circuit "${this.name}" OPEN → HALF_OPEN (reset timeout elapsed)`);
    }
  }
}

/** Error thrown when the circuit is open. */
export class CircuitOpenError extends Error {
  readonly circuitName: string;
  readonly resetInMs: number;

  constructor(name: string, resetInMs: number) {
    super(`Circuit "${name}" is open — retry in ${Math.ceil(resetInMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.resetInMs = resetInMs;
  }
}

/**
 * Registry of circuit breakers per network.
 * Ensures we reuse the same breaker instance across calls.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly logger = new Logger(CircuitBreakerRegistry.name);

  /** Get or create a circuit breaker for a given key (e.g., "login:X"). */
  get(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, opts);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /** Get the state of all registered breakers. */
  getStates(): Array<{ name: string; state: CircuitState; failures: number; resetInMs: number }> {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => ({
      name,
      state: breaker.currentState,
      failures: breaker['failures'].length,
      resetInMs: breaker.resetInMs,
    }));
  }

  /** Reset all breakers (e.g., on manual intervention). */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
    this.logger.log('All circuit breakers reset');
  }
}
