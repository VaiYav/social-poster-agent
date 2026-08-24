/**
 * Abort-signal utilities.
 *
 * Kept separate from `llm.service.ts` because these helpers are generic and are
 * used by the orchestrator and generation modules, not just the LLM service.
 */

/**
 * Combine multiple abort signals into one.
 * - Returns `undefined` if no signals are provided.
 * - Returns the single signal unchanged if only one is provided.
 * - Returns an already-aborted signal if any input is already aborted.
 * - Otherwise returns a new signal that aborts when any input aborts.
 *
 * Listeners on the input signals are removed when the combined signal aborts,
 * so callers should ensure the combined signal is aborted (e.g. by aborting
 * one of the input controllers) to release the input signal listeners.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = [...new Set(signals.filter((s): s is AbortSignal => s != null))];
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  if (defined.some((s) => s.aborted)) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const s of defined) {
    s.addEventListener("abort", abort, { once: true });
  }

  // Clean up input listeners as soon as the combined signal aborts.
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const s of defined) {
        s.removeEventListener("abort", abort);
      }
    },
    { once: true },
  );

  return controller.signal;
}

/**
 * Return a promise that rejects with an `Abort` error when the signal aborts.
 * Rejects immediately if the signal is already aborted.
 */
export function signalToPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(new Error("Abort"));
  }
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Abort")), { once: true });
  });
}
