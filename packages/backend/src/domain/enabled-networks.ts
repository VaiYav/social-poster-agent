import { SocialNetwork } from '@prisma/client';

/**
 * Returns the list of enabled social networks based on the ENABLED_NETWORKS env var.
 * Defaults to X,THREADS (Facebook disabled by default — session instability).
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
  const csv = process.env.ENABLED_NETWORKS ?? 'X,THREADS';
  const valid = new Set<string>(Object.values(SocialNetwork));
  const networks: SocialNetwork[] = [];
  for (const raw of csv.split(',')) {
    const token = raw.trim().toUpperCase();
    if (!token) continue;
    if (valid.has(token)) {
      networks.push(token as SocialNetwork);
    }
  }
  // Fallback if all tokens were invalid
  if (networks.length === 0) {
    return [SocialNetwork.X, SocialNetwork.THREADS];
  }
  return networks;
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
