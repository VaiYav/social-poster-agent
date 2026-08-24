// Shared enums — mirror Prisma enums for use in business logic and UI
// Single source of truth: Prisma schema generates these, we re-export

export const SocialNetworkSchema = {
  X: "X",
  THREADS: "THREADS",
  FACEBOOK: "FACEBOOK",
  // ── Syndication platforms (Phase 1-4) ──
  DEVTO: "DEVTO",
  HASHNODE: "HASHNODE",
  LINKEDIN: "LINKEDIN",
  BLUESKY: "BLUESKY",
  MASTODON: "MASTODON",
  TELEGRAM: "TELEGRAM",
  MEDIUM: "MEDIUM",
  SUBSTACK: "SUBSTACK",
  REDDIT: "REDDIT",
  QUORA: "QUORA",
  PINTEREST: "PINTEREST",
} as const;
export type SocialNetwork = (typeof SocialNetworkSchema)[keyof typeof SocialNetworkSchema];

export const PostStatusSchema = {
  DRAFT: "DRAFT",
  APPROVED: "APPROVED",
  POSTING: "POSTING",
  POSTED: "POSTED",
  FAILED: "FAILED",
  REJECTED: "REJECTED",
  // ── Syndication statuses ──
  JUDGED: "JUDGED", // LLM-as-a-Judge evaluated, awaiting auto-approve decision
  VERIFIED: "VERIFIED", // Published AND verified on platform (POST_VERIFIED event emitted)
} as const;
export type PostStatus = (typeof PostStatusSchema)[keyof typeof PostStatusSchema];

// ContentType — distinguishes social posts from articles from participation answers
export const ContentTypeSchema = {
  SOCIAL_POST: "SOCIAL_POST",
  ARTICLE: "ARTICLE",
  ANSWER: "ANSWER",
  PIN: "PIN",
} as const;
export type ContentType = (typeof ContentTypeSchema)[keyof typeof ContentTypeSchema];

export const SessionStatusSchema = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  ERROR: "ERROR",
  WARMUP: "WARMUP", // F20: new account in warm-up phase
  BANNED: "BANNED", // F21: account flagged as banned by health monitor
} as const;
export type SessionStatus = (typeof SessionStatusSchema)[keyof typeof SessionStatusSchema];

export const GenerationRunStatusSchema = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type GenerationRunStatus =
  (typeof GenerationRunStatusSchema)[keyof typeof GenerationRunStatusSchema];

export const GenerationTriggerSchema = {
  CRON: "CRON",
  MANUAL: "MANUAL",
} as const;
export type GenerationTrigger =
  (typeof GenerationTriggerSchema)[keyof typeof GenerationTriggerSchema];

export const ContentSourceTypeSchema = {
  BRIEF: "brief",
  ARTICLE: "article",
  TOPIC: "topic",
  CREATE_RUN: "create_run",
  RECYCLE: "recycle",
  REVIEW: "review",
} as const;
export type ContentSourceType =
  (typeof ContentSourceTypeSchema)[keyof typeof ContentSourceTypeSchema];
