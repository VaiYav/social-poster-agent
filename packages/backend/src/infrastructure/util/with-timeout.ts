/**
 * Race a promise against a timeout. Rejects with a timeout error if `p` does not
 * settle within `ms`. The timer is `unref()`-ed so it never keeps the process
 * alive on its own.
 *
 * BUG-8: liveness/readiness checks (Redis ping, DB query) must be bounded — a
 * half-open socket to a down dependency can otherwise hang the request
 * indefinitely, tripping the k8s liveness probe into a pod-restart loop.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Do not let the timeout timer hold the event loop open.
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
