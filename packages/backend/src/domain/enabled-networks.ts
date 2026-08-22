import { SocialNetwork } from "../generated/prisma/client";

/**
 * Returns the list of enabled social networks.
 * Per-network SOCIAL_{NETWORK}_ACTIVE flags take precedence over ENABLED_NETWORKS.
 * Defaults to X,THREADS when neither is set (Facebook disabled by default — session instability).
 *
 * Reads process.env directly (not ConfigService) so it can be used in static
 * contexts, module loaders, and service constructors without DI.
 *
 * Usage:
 *   import { getEnabledNetworks } from '../../domain/enabled-networks.js';
 *   const networks = getEnabledNetworks(); // [SocialNetwork.X, SocialNetwork.THREADS]
 *   if (getEnabledNetworks().includes(SocialNetwork.FACEBOOK)) { ... }
 */
export function getEnabledNetworks(): SocialNetwork[] {
  // 7.6: per-network SOCIAL_*_ACTIVE flags override ENABLED_NETWORKS.
  const activeByFlag: SocialNetwork[] = [];
  for (const network of Object.values(SocialNetwork)) {
    const flag = process.env[`SOCIAL_${network}_ACTIVE`];
    if (flag !== undefined) {
      if (flag.trim().toLowerCase() === "true") {
        activeByFlag.push(network);
      }
      continue;
    }
    // No per-network flag — fall back to ENABLED_NETWORKS CSV.
    const csv = process.env.ENABLED_NETWORKS ?? "X,THREADS";
    for (const raw of csv.split(",")) {
      const token = raw.trim().toUpperCase();
      if (token === network) {
        activeByFlag.push(network);
        break;
      }
    }
  }

  if (activeByFlag.length > 0) {
    return activeByFlag;
  }

  // Fallback if all tokens were invalid
  return [SocialNetwork.X, SocialNetwork.THREADS];
}

/**
 * Check if a specific network is enabled.
 * Returns true for unknown/invalid networks (let the caller handle that error).
 */
export function isNetworkEnabled(network: SocialNetwork | string): boolean {
  const valid = new Set<string>(Object.values(SocialNetwork));
  // If it's not a valid SocialNetwork enum value, let the caller handle it
  // (e.g. "Unknown network" error in the poster switch)
  if (!valid.has(network as string)) return true;
  const enabled = getEnabledNetworks();
  return enabled.includes(network as SocialNetwork);
}
