import type { SocialNetwork } from '@spa/shared';
import { X_SELECTORS } from './selectors/x.selectors.js';
import { THREADS_SELECTORS } from './selectors/threads.selectors.js';
import { FACEBOOK_SELECTORS } from './selectors/facebook.selectors.js';

/**
 * P1: native post-permalink shape per network — the single source of truth is the
 * poster selectors' `postUrlPattern` (so this never drifts from the capture logic).
 */
const POST_URL_PATTERN: Record<SocialNetwork, RegExp> = {
  X: X_SELECTORS.compose.postUrlPattern,
  THREADS: THREADS_SELECTORS.compose.postUrlPattern,
  FACEBOOK: FACEBOOK_SELECTORS.compose.postUrlPattern,
};

/**
 * P1: is `url` a genuine native post permalink for this network — i.e. a link to
 * the published post itself, not a compose / home / profile / login URL?
 *
 * Success-detection must never record a non-permalink URL as a POSTED post: it
 * pollutes analytics, breaks thread-reply targeting (which needs the root post
 * URL), and hides real failures behind a "successful"-looking row.
 */
export function isPermalink(url: string | null | undefined, network: SocialNetwork): boolean {
  if (!url) return false;
  return POST_URL_PATTERN[network].test(url);
}

/**
 * Return `url` only when it is a genuine permalink for the network, else `null`.
 * Callers treat `null` as "submitted, but no permalink captured" and route to
 * profile verification / self-recovery rather than trusting a bogus URL.
 */
export function normalizePermalink(
  url: string | null | undefined,
  network: SocialNetwork,
): string | null {
  return isPermalink(url, network) ? (url as string) : null;
}
