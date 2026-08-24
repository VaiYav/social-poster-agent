/**
 * CircuitBreaker unit tests — state transitions (CLOSED/OPEN/HALF_OPEN),
 * failure counting, timeout-based reset, and registry behavior.
 *
 * Uses the real CircuitBreaker class (domain logic, no external deps)
 * with vi.useFakeTimers() for time-based transitions.
 *
 * Source: packages/backend/src/domain/circuit-breaker.ts
 * Test IDs: UTC-440 through UTC-455
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  type CircuitBreakerOptions,
} from "../../../src/domain/circuit-breaker.js";

// ── Tests ──

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── CLOSED → OPEN ──

  it("UTC-440: CLOSED → 3 failures → OPEN (3 execute() fail)", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 3, resetTimeoutMs: 900000 });
    const failingOp = vi.fn().mockRejectedValue(new Error("boom"));

    // Act — 3 failures
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingOp)).rejects.toThrow("boom");
    }

    // Assert
    expect(breaker.currentState).toBe("OPEN");
  });

  // ── OPEN blocks ──

  it("UTC-441: OPEN blocks with CircuitOpenError (execute after open)", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 2, resetTimeoutMs: 900000 });
    const failingOp = vi.fn().mockRejectedValue(new Error("fail"));

    // Open the circuit
    await expect(breaker.execute(failingOp)).rejects.toThrow("fail");
    await expect(breaker.execute(failingOp)).rejects.toThrow("fail");
    expect(breaker.currentState).toBe("OPEN");

    // Act / Assert — next execute throws CircuitOpenError (not the op's error)
    const successOp = vi.fn().mockResolvedValue("ok");
    await expect(breaker.execute(successOp)).rejects.toThrow(CircuitOpenError);
    expect(successOp).not.toHaveBeenCalled();
  });

  // ── OPEN → timeout → HALF_OPEN ──

  it("UTC-442: OPEN → timeout → HALF_OPEN (fake timers +60min)", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 3_600_000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    expect(breaker.currentState).toBe("OPEN");

    // Act — advance time past reset timeout (60 min)
    vi.advanceTimersByTime(3_600_001);

    // Assert — canExecute triggers transition to HALF_OPEN
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.currentState).toBe("HALF_OPEN");
  });

  // ── HALF_OPEN trial success → CLOSED ──

  it("UTC-443: HALF_OPEN trial success → CLOSED", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    vi.advanceTimersByTime(1001);
    expect(breaker.canExecute()).toBe(true); // → HALF_OPEN

    // Act — trial succeeds
    const result = await breaker.execute(vi.fn().mockResolvedValue("recovered"));

    // Assert
    expect(result).toBe("recovered");
    expect(breaker.currentState).toBe("CLOSED");
  });

  // ── HALF_OPEN trial failure → re-OPEN ──

  it("UTC-444: HALF_OPEN trial failure → re-OPEN", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    vi.advanceTimersByTime(1001);
    // Trigger transition to HALF_OPEN via canExecute (currentState doesn't auto-transition)
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.currentState).toBe("HALF_OPEN");

    // Act — trial fails
    await expect(
      breaker.execute(vi.fn().mockRejectedValue(new Error("still failing"))),
    ).rejects.toThrow("still failing");

    // Assert
    expect(breaker.currentState).toBe("OPEN");
  });

  // ── manual reset ──

  it("UTC-445: manual reset → CLOSED", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 900000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    expect(breaker.currentState).toBe("OPEN");

    // Act
    breaker.reset();

    // Assert
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.canExecute()).toBe(true);
  });

  // ── canExecute ──

  it("UTC-446: canExecute: CLOSED → true, OPEN → false", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 900000 });
    expect(breaker.canExecute()).toBe(true); // CLOSED

    // Act — open the circuit
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );

    // Assert
    expect(breaker.canExecute()).toBe(false); // OPEN
  });

  // ── resetInMs ──

  it("UTC-447: resetInMs: OPEN → countdown (fake timers)", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 10000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );
    expect(breaker.currentState).toBe("OPEN");

    // Act — advance 3 seconds
    vi.advanceTimersByTime(3000);

    // Assert — 7 seconds remaining
    expect(breaker.resetInMs).toBe(7000);
  });

  it("UTC-448: resetInMs: CLOSED → 0", () => {
    const breaker = new CircuitBreaker("test", { failureThreshold: 3 });
    expect(breaker.resetInMs).toBe(0);
  });

  // ── failure window pruning ──

  it("UTC-449: failure window pruning (failures older than 10min pruned)", async () => {
    // Arrange — threshold 3, window 10 min
    const breaker = new CircuitBreaker("test", { failureThreshold: 3, failureWindowMs: 600_000 });

    // Act — 2 failures, then advance past window, then 1 more failure
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e1")))).rejects.toThrow("e1");
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e2")))).rejects.toThrow("e2");
    vi.advanceTimersByTime(601_000); // past 10-min window
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e3")))).rejects.toThrow("e3");

    // Assert — old failures pruned, only 1 recent failure → still CLOSED
    expect(breaker.currentState).toBe("CLOSED");
  });

  // ── Registry ──

  describe("CircuitBreakerRegistry", () => {
    it("UTC-450: Registry.get: same name → same instance", () => {
      // Arrange
      const registry = new CircuitBreakerRegistry();

      // Act
      const b1 = registry.get("login:X");
      const b2 = registry.get("login:X");

      // Assert
      expect(b1).toBe(b2);
    });

    it("UTC-451: Registry.get: different names → different instances", () => {
      const registry = new CircuitBreakerRegistry();
      const b1 = registry.get("login:X");
      const b2 = registry.get("login:THREADS");
      expect(b1).not.toBe(b2);
    });

    it("UTC-452: Registry.getStates: all breakers states", async () => {
      // Arrange
      const registry = new CircuitBreakerRegistry();
      const bx = registry.get("login:X", { failureThreshold: 1, resetTimeoutMs: 900000 });
      registry.get("login:THREADS", { failureThreshold: 1, resetTimeoutMs: 900000 });
      // Open X breaker
      await expect(bx.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
        "fail",
      );

      // Act
      const states = registry.getStates();

      // Assert
      expect(states).toHaveLength(2);
      const xState = states.find((s) => s.name === "login:X");
      const threadsState = states.find((s) => s.name === "login:THREADS");
      expect(xState?.state).toBe("OPEN");
      expect(threadsState?.state).toBe("CLOSED");
    });

    it("UTC-453: Registry.resetAll: all → CLOSED", async () => {
      // Arrange
      const registry = new CircuitBreakerRegistry();
      const bx = registry.get("login:X", { failureThreshold: 1, resetTimeoutMs: 900000 });
      const bt = registry.get("login:THREADS", { failureThreshold: 1, resetTimeoutMs: 900000 });
      await expect(bx.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
        "fail",
      );
      await expect(bt.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
        "fail",
      );
      expect(bx.currentState).toBe("OPEN");
      expect(bt.currentState).toBe("OPEN");

      // Act
      registry.resetAll();

      // Assert
      expect(bx.currentState).toBe("CLOSED");
      expect(bt.currentState).toBe("CLOSED");
    });
  });

  // ── CircuitOpenError properties ──

  it("UTC-454: CircuitOpenError exposes circuitName and resetInMs", async () => {
    // Arrange
    const breaker = new CircuitBreaker("my-circuit", { failureThreshold: 1, resetTimeoutMs: 5000 });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("fail")))).rejects.toThrow(
      "fail",
    );

    // Act
    let caught: CircuitOpenError | undefined;
    try {
      await breaker.execute(vi.fn().mockResolvedValue("ok"));
    } catch (err) {
      caught = err as CircuitOpenError;
    }

    // Assert
    expect(caught).toBeInstanceOf(CircuitOpenError);
    expect(caught!.circuitName).toBe("my-circuit");
    expect(caught!.resetInMs).toBeGreaterThan(0);
    expect(caught!.resetInMs).toBeLessThanOrEqual(5000);
  });

  // ── success resets failure count ──

  it("UTC-455: success between failures resets failure count (no false open)", async () => {
    // Arrange
    const breaker = new CircuitBreaker("test", { failureThreshold: 3, resetTimeoutMs: 900000 });

    // Act — 2 failures, then success, then 2 more failures
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e1")))).rejects.toThrow("e1");
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e2")))).rejects.toThrow("e2");
    await breaker.execute(vi.fn().mockResolvedValue("ok")); // resets count
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e3")))).rejects.toThrow("e3");
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error("e4")))).rejects.toThrow("e4");

    // Assert — only 2 consecutive failures after reset → still CLOSED
    expect(breaker.currentState).toBe("CLOSED");
  });
});
