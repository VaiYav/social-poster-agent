/**
 * Sprint M / Item 27: SSE reconnection UI tests.
 *
 * Tests the P0-H4 exponential backoff reconnection logic in useSSE composable:
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap)
 *   - Jitter: add random 0-1s to prevent thundering herd
 *   - Max retries: 10 (then show "connection lost" error)
 *   - Reset retry count on successful connection
 *   - Clear timeout on disconnect to prevent zombie reconnects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { useSSE, type SSEOptions } from '@/composables/useSSE';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }

  simulateMessage(data: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
  }
}

// Helper to mount a component that uses useSSE and exposes its return value
function createTestComponent(url: string, options?: SSEOptions) {
  let sseResult: ReturnType<typeof useSSE> | null = null;
  const TestComponent = defineComponent({
    setup() {
      sseResult = useSSE(url, options);
      return () => h('div');
    },
  });
  const wrapper = mount(TestComponent);
  return { wrapper, sseResult: () => sseResult! };
}

describe('useSSE — P0-H4 Exponential Backoff Reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    global.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (global as { EventSource?: typeof EventSource }).EventSource;
  });

  // ── UTC-SSE-001: Initial connection ──
  it('UTC-SSE-001: connects to the given URL on mount', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse');
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/v1/events/sse');
    expect(sseResult().isConnected.value).toBe(false);
  });

  // ── UTC-SSE-002: onopen sets isConnected and resets retryCount ──
  it('UTC-SSE-002: onopen sets isConnected=true and resets retryCount to 0', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse', { jitter: false, baseDelayMs: 1000 });
    const es = MockEventSource.instances[0];

    // Simulate error first to increment retryCount
    es.simulateError();
    vi.advanceTimersByTime(1000);
    expect(sseResult().retryCount.value).toBe(1);

    // New EventSource created after reconnect
    const es2 = MockEventSource.instances[1];
    es2.simulateOpen();

    expect(sseResult().isConnected.value).toBe(true);
    expect(sseResult().retryCount.value).toBe(0);
    expect(sseResult().error.value).toBe(null);
  });

  // ── UTC-SSE-003: Exponential backoff delay calculation ──
  it('UTC-SSE-003: uses exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap)', () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      jitter: false,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });

    // Intercept setTimeout to capture delays
    vi.spyOn(global, 'setTimeout').mockImplementation((cb: () => void, delay?: number) => {
      if (delay && delay > 0) delays.push(delay);
      cb();
      return {} as ReturnType<typeof setTimeout>;
    });

    // Trigger 6 errors to see backoff progression
    for (let i = 0; i < 6; i++) {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateError();
    }

    // Expected: 1s, 2s, 4s, 8s, 16s, 30s (capped)
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
    expect(delays[4]).toBe(16000);
    expect(delays[5]).toBe(30000); // capped at maxDelayMs
  });

  // ── UTC-SSE-004: Max retries stops reconnection ──
  it('UTC-SSE-004: stops reconnecting after maxRetries and shows error', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      maxRetries: 3,
      jitter: false,
      baseDelayMs: 100,
    });

    // Trigger 3 errors (using all 3 retries)
    for (let i = 0; i < 3; i++) {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateError();
      vi.advanceTimersByTime(10000);
    }

    // After 3 retries, the next error should stop
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    es.simulateError();

    expect(sseResult().error.value).toContain('connection lost');
    expect(sseResult().error.value).toContain('3');
    expect(sseResult().isConnected.value).toBe(false);
  });

  // ── UTC-SSE-005: Jitter adds random delay ──
  it('UTC-SSE-005: jitter adds 0-1000ms random delay to base backoff', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const delays: number[] = [];

    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      jitter: true,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb: () => void, delay?: number) => {
      if (delay && delay > 0) delays.push(delay);
      cb();
      return {} as ReturnType<typeof setTimeout>;
    });

    const es = MockEventSource.instances[0];
    es.simulateError();

    // Expected: 1000 (base) + 500 (jitter from random=0.5) = 1500
    expect(delays[0]).toBe(1500);

    randomSpy.mockRestore();
  });

  // ── UTC-SSE-006: disconnect clears pending reconnect timeout ──
  it('UTC-SSE-006: disconnect clears pending reconnect and prevents zombie reconnects', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      jitter: false,
      baseDelayMs: 5000,
    });

    // Trigger error to schedule a reconnect
    const es = MockEventSource.instances[0];
    es.simulateError();

    // Disconnect before the reconnect timer fires
    sseResult().disconnect();

    // Advance time past the reconnect delay — should NOT create a new EventSource
    const instancesBefore = MockEventSource.instances.length;
    vi.advanceTimersByTime(10000);
    expect(MockEventSource.instances.length).toBe(instancesBefore);

    expect(sseResult().isConnected.value).toBe(false);
    expect(sseResult().retryCount.value).toBe(0);
    expect(sseResult().error.value).toBe(null);
  });

  // ── UTC-SSE-007: manual reconnect resets retry count ──
  it('UTC-SSE-007: manual reconnect() resets retryCount and creates new connection', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      jitter: false,
      baseDelayMs: 100,
    });

    // Trigger some errors to increment retryCount
    for (let i = 0; i < 3; i++) {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateError();
      vi.advanceTimersByTime(10000);
    }
    expect(sseResult().retryCount.value).toBe(3);

    // Manual reconnect
    sseResult().reconnect();

    expect(sseResult().retryCount.value).toBe(0);
    expect(sseResult().error.value).toBe(null);
    // A new EventSource should have been created
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(5);
  });

  // ── UTC-SSE-008: onmessage parses JSON and updates data ──
  it('UTC-SSE-008: onmessage parses JSON data and updates data ref', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse');
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    es.simulateMessage({ type: 'post_status', postId: 'p1', status: 'POSTED' });

    expect(sseResult().data.value).toEqual({ type: 'post_status', postId: 'p1', status: 'POSTED' });
  });

  // ── UTC-SSE-009: onmessage handles non-JSON data gracefully ──
  it('UTC-SSE-009: onmessage handles non-JSON data by storing raw string', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse');
    const es = MockEventSource.instances[0];

    es.simulateOpen();

    // Simulate non-JSON message
    const event = new MessageEvent('message', { data: 'plain text' });
    es.onmessage?.(event);

    expect(sseResult().data.value).toBe('plain text');
  });

  // ── UTC-SSE-010: retryCount increments on each error ──
  it('UTC-SSE-010: retryCount increments on each consecutive error', () => {
    const { sseResult } = createTestComponent('/api/v1/events/sse', {
      jitter: false,
      baseDelayMs: 100,
    });

    const es = MockEventSource.instances[0];
    es.simulateError();
    expect(sseResult().retryCount.value).toBe(1);
    expect(sseResult().error.value).toContain('Reconnecting (1/');

    vi.advanceTimersByTime(1000);
    const es2 = MockEventSource.instances[1];
    es2.simulateError();
    expect(sseResult().retryCount.value).toBe(2);
    expect(sseResult().error.value).toContain('Reconnecting (2/');
  });

  // ── UTC-SSE-011: onUnmounted disconnects and cleans up ──
  it('UTC-SSE-011: onUnmounted calls disconnect and closes EventSource', () => {
    const { wrapper, sseResult } = createTestComponent('/api/v1/events/sse');
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    expect(sseResult().isConnected.value).toBe(true);

    wrapper.unmount();

    expect(sseResult().isConnected.value).toBe(false);
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });
});
