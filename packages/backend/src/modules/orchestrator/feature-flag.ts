/**
 * Feature flag utilities for the orchestrator migration.
 *
 * The orchestrator replaces all cron-based scheduling. When ORCHESTRATOR_ENABLED=true,
 * the old cron methods should early-return. Instead of repeating
 * `if (parseBool(process.env.ORCHESTRATOR_ENABLED)) return;` in 11+ files,
 * use the `skipIfOrchestrator()` guard at the top of each cron method.
 */

import { parseBool } from '../../infrastructure/config/parse-bool.js';

/**
 * Returns true if the orchestrator is enabled and old crons should be skipped.
 * Reads process.env directly (same pattern as getEnabledNetworks) for use in
 * static contexts and service methods without DI.
 */
export function isOrchestratorEnabled(): boolean {
  return parseBool(process.env.ORCHESTRATOR_ENABLED ?? 'false');
}

/**
 * Guard clause for cron methods. Call at the top of the method:
 *   if (skipIfOrchestrator()) return;
 * This is clearer than a decorator because cron methods have varying
 * return types (void, Promise<void>, Promise<result>).
 */
export function skipIfOrchestrator(): boolean {
  return isOrchestratorEnabled();
}
