/**
 * A2: single source of truth for parsing boolean env flags.
 *
 * The codebase historically compared `=== 'true'` in many places, so
 * `FLAG=TRUE` / `FLAG=1` / `FLAG=yes` silently meant "disabled" — a footgun
 * for security-relevant flags (AUTO_APPROVE_ENABLED, feature gates, etc.).
 *
 * Accepts common truthy/falsy forms; unrecognized values fall back to `fallback`.
 */
export function parseBool(
  value: string | boolean | undefined | null,
  fallback = false,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'n', ''].includes(v)) return false;
  return fallback;
}
