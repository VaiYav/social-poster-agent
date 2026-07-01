/**
 * Feature flag utilities for the orchestrator migration.
 *
 * The orchestrator replaces all cron-based scheduling. When ORCHESTRATOR_ENABLED=true,
 * cron services skip cron registration entirely in their onModuleInit() — the cron
 * timer is never created, saving memory and CPU. Use `isOrchestratorEnabled()` to
 * check the flag at module-init time.
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
