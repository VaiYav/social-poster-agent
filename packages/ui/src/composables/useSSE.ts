/**
 * P0-H4: SSE composable with exponential backoff reconnection.
 *
 * Previously, useSSE used a fixed 5s delay with infinite retries.
 * On network outage this spammed reconnect attempts.
 *
 * Best practice (from event-source-plus, LaunchDarkly EventSource):
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap)
 *   - Jitter: add random 0-1s to prevent thundering herd
 *   - Max retries: 10 (then show "connection lost" error)
 *   - Reset retry count on successful connection
 *   - Clear timeout on disconnect to prevent zombie reconnects
 */

import { ref, onUnmounted, type Ref } from "vue";
import { SSEvent, SSEventSchema } from "@spa/shared";

export interface SSEOptions {
  /** Maximum reconnection attempts before giving up (default: 10) */
  maxRetries?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Whether to add jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
}

export function useSSE(url: string, options: SSEOptions = {}) {
  const { maxRetries = 10, baseDelayMs = 1000, maxDelayMs = 30000, jitter = true } = options;

  const data: Ref<SSEvent | null> = ref(null);
  const error: Ref<string | null> = ref(null);
  const isConnected = ref(false);
  const retryCount = ref(0);

  let eventSource: EventSource | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    // Clear any pending reconnect
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    // Auth: withCredentials=true sends the httpOnly JWT cookie with the SSE
    // request (same-origin via Vite proxy / nginx). Without this, the auth
    // guard would reject the EventSource connection with 401.
    eventSource = new EventSource(url, { withCredentials: true });

    eventSource.onopen = () => {
      isConnected.value = true;
      error.value = null;
      // P0-H4: Reset retry count on successful connection
      retryCount.value = 0;
    };

    eventSource.onerror = () => {
      isConnected.value = false;
      eventSource?.close();
      eventSource = null;

      // P0-H4: Exponential backoff with max retries
      if (retryCount.value >= maxRetries) {
        error.value = `SSE connection lost after ${maxRetries} retries. Please refresh the page.`;
        return;
      }

      // Calculate delay: base * 2^retry, capped at maxDelayMs
      const exponentialDelay = baseDelayMs * Math.pow(2, retryCount.value);
      const jitterMs = jitter ? Math.random() * 1000 : 0;
      const delay = Math.min(exponentialDelay + jitterMs, maxDelayMs);

      retryCount.value++;
      error.value = `Reconnecting (${retryCount.value}/${maxRetries})...`;
      reconnectTimeout = setTimeout(() => connect(), delay);
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = SSEventSchema.safeParse(parsed);
        if (result.success) {
          data.value = result.data;
        } else {
          data.value = null;
          error.value = `Invalid SSE payload: ${result.error.message}`;
        }
      } catch (err) {
        data.value = null;
        error.value = `SSE payload parse error: ${(err as Error).message}`;
      }
    };
  }

  function disconnect(): void {
    // P0-H4: Clear pending reconnect timeout to prevent zombie reconnects
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    eventSource?.close();
    eventSource = null;
    isConnected.value = false;
    retryCount.value = 0;
    error.value = null;
  }

  function reconnect(): void {
    // Manual reconnect — reset retry count
    retryCount.value = 0;
    error.value = null;
    connect();
  }

  connect();

  onUnmounted(() => {
    disconnect();
  });

  return { data, error, isConnected, retryCount, disconnect, reconnect };
}
