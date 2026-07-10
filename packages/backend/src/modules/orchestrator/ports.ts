/**
 * Orchestrator ports — DI tokens for feature-flagged services.
 *
 * These ports allow the orchestrator to depend on optional services
 * (Engagement, Replies) without importing their concrete classes,
 * which would cause module load errors when feature flags are off.
 *
 * Each port is a Symbol DI token. The corresponding module binds it
 * only when the feature flag is enabled.
 */

import type { SocialNetwork } from '@prisma/client';

// ── Browsing Session Port ──────────────────────────────────────────────────

export interface IBrowsingSessionPort {
  runBrowsingSession(
    network: SocialNetwork,
    durationSec?: number,
  ): Promise<{ sessionId: string; postsViewed: number; interactionsCount: number }>;
}

export const IBrowsingSessionPort = Symbol('IBrowsingSessionPort');

// ── Replies Monitor Port ───────────────────────────────────────────────────

export interface IRepliesMonitorPort {
  runMonitoringCycle(): Promise<{
    postsChecked: number;
    commentsScraped: number;
    repliesPosted: number;
    repliesScheduled: number;
    humanReview: number;
  }>;
}

export const IRepliesMonitorPort = Symbol('IRepliesMonitorPort');
