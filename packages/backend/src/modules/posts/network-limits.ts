import { SocialNetwork } from "../../generated/prisma/client";

/**
 * PO2: per-network hard character limits (mirrors generation / ab-variant NETWORK_LIMITS).
 * Used to validate content length server-side on approve, so an over-limit edited (or generated)
 * post can't be approved and then fail at posting time. Counting is by Unicode code points so
 * multi-byte emoji are not over-counted relative to UTF-16 units.
 */
export const NETWORK_LIMITS: Partial<Record<SocialNetwork, number>> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500,
  [SocialNetwork.BLUESKY]: 300,
  [SocialNetwork.MASTODON]: 500,
  [SocialNetwork.TELEGRAM]: 4096,
  [SocialNetwork.LINKEDIN]: 3000,
};

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
