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

import type { SocialNetwork } from "../../generated/prisma/client";
import type { EngagementResult } from "../posting/posters/base.poster.js";

// ── Engagement Action Port ─────────────────────────────────────────────────

export interface IEngagementPort {
  like(
    network: SocialNetwork,
    postUrl: string,
  ): Promise<EngagementResult & { interactionId: string }>;
  comment(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }>;
  follow(
    network: SocialNetwork,
    handleOrUrl: string,
  ): Promise<EngagementResult & { interactionId: string }>;
  repost(
    network: SocialNetwork,
    postUrl: string,
  ): Promise<EngagementResult & { interactionId: string }>;
  quote(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }>;
}

export const IEngagementPort = Symbol("IEngagementPort");

// ── Browsing Session Port ──────────────────────────────────────────────────

export interface IBrowsingSessionPort {
  runBrowsingSession(
    network: SocialNetwork,
    durationSec?: number,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; postsViewed: number; interactionsCount: number }>;
}

export const IBrowsingSessionPort = Symbol("IBrowsingSessionPort");

// ── Replies Monitor Port ───────────────────────────────────────────────────

export interface IRepliesMonitorPort {
  runMonitoringCycle(): Promise<{
    postsChecked: number;
    commentsScraped: number;
    repliesPosted: number;
    repliesScheduled: number;
    humanReview: number;
  }>;
  postScheduledReply(data: {
    commentDbId: string;
    commentId: string;
    postId: string;
    network: string;
    postUrl: string | null;
    targetCommentUrl?: string | null;
    replyText: string;
  }): Promise<void>;
}

export const IRepliesMonitorPort = Symbol("IRepliesMonitorPort");
