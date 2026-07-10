/**
 * Shared utilities for BullMQ job state checks.
 *
 * Extracted from queue.factory.ts and health-monitor.service.ts to eliminate
 * duplicated state-checking logic (DRY-2).
 */

/**
 * States that indicate a job is actively being processed or scheduled for processing.
 * Jobs in these states should NOT be removed, re-enqueued, or reaped.
 *
 * - 'active': worker is currently processing the job
 * - 'waiting': job is in the waiting queue, will be picked up next
 * - 'prioritized': job has priority and is waiting for a worker
 * - 'waiting-children': job is waiting for child jobs (flow producer)
 * - 'delayed': job is scheduled for future execution
 */
const IN_FLIGHT_STATES = new Set([
  'active',
  'waiting',
  'prioritized',
  'waiting-children',
  'delayed',
]);

/**
 * Check if a BullMQ job state string indicates the job is in-flight
 * (being processed or scheduled for processing).
 */
export function isJobInFlight(state: string): boolean {
  return IN_FLIGHT_STATES.has(state);
}

/**
 * Check if a BullMQ job state string indicates the job is in a terminal state
 * (completed, failed, or unknown/limbo).
 */
export function isJobTerminal(state: string): boolean {
  return !IN_FLIGHT_STATES.has(state);
}
