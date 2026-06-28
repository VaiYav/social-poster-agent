import { SocialNetwork } from '@prisma/client';

const VALID_NETWORKS = new Set<string>(Object.values(SocialNetwork));

/**
 * AU4: parse a CSV of network names (e.g. "X,THREADS,FACEBOOK") into validated SocialNetwork
 * values. Unknown tokens (typos like "THREDS") are dropped and reported, instead of being cast
 * blindly to SocialNetwork[] and producing a never-drained queue like "spa-posting-threds".
 */
export function parseTargetNetworks(csv: string): { networks: SocialNetwork[]; invalid: string[] } {
  const networks: SocialNetwork[] = [];
  const invalid: string[] = [];
  for (const raw of (csv ?? '').split(',')) {
    const token = raw.trim().toUpperCase();
    if (!token) continue;
    if (VALID_NETWORKS.has(token)) {
      networks.push(token as SocialNetwork);
    } else {
      invalid.push(token);
    }
  }
  return { networks, invalid };
}
