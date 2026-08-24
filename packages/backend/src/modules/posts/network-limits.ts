import { SocialNetwork } from "../../generated/prisma/client.js";
import { NETWORK_PROFILES } from "../../domain/network-profiles/network-profiles.js";

/**
 * PO2: per-network hard character limits (mirrors generation / ab-variant NETWORK_LIMITS).
 * Used to validate content length server-side on approve, so an over-limit edited (or generated)
 * post can't be approved and then fail at posting time. Counting is by Unicode code points so
 * multi-byte emoji are not over-counted relative to UTF-16 units.
 */
export const NETWORK_LIMITS: Partial<Record<SocialNetwork, number>> = Object.fromEntries(
  Object.entries(NETWORK_PROFILES).map(([network, profile]) => [network, profile.charLimit]),
) as Partial<Record<SocialNetwork, number>>;

export interface LengthCheck {
  ok: boolean;
  limit: number;
  length: number;
}

export function checkContentLength(network: SocialNetwork, content: string): LengthCheck {
  const limit = NETWORK_LIMITS[network] ?? 280;
  const length = [...(content ?? "")].length;
  return { ok: length <= limit, limit, length };
}
