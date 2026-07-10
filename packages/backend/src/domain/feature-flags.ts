/**
 * Feature flag utilities — pure functions that read process.env directly.
 *
 * Lives in domain/ so both modules/ and infrastructure/ can import without
 * violating the hexagonal dependency direction (infrastructure must not
 * import from modules).
 *
 * These run at module-load time, before NestJS DI bootstrap, so ConfigService
 * is not available. This is intentional — do not "fix" by switching to ConfigService.
 */

/**
 * Parse a boolean env var with common truthy/falsy forms.
 * Inlined here (instead of importing from infrastructure/config/parse-bool)
 * to keep domain/ free of infrastructure dependencies.
 */
function parseBoolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'n', ''].includes(v)) return false;
  return fallback;
}

/**
 * Returns true if the orchestrator is enabled and old crons should be skipped.
 * Reads process.env directly (same pattern as getEnabledNetworks) for use in
 * static contexts and service methods without DI.
 */
export function isOrchestratorEnabled(): boolean {
  return parseBoolEnv(process.env.ORCHESTRATOR_ENABLED, false);
}
