// Shared enums — mirror Prisma enums for use in business logic and UI
// Single source of truth: Prisma schema generates these, we re-export

export const SocialNetworkSchema = {
  X: 'X',
  THREADS: 'THREADS',
  FACEBOOK: 'FACEBOOK',
} as const;
export type SocialNetwork = (typeof SocialNetworkSchema)[keyof typeof SocialNetworkSchema];

export const PostStatusSchema = {
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  POSTING: 'POSTING',
  POSTED: 'POSTED',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
} as const;
export type PostStatus = (typeof PostStatusSchema)[keyof typeof PostStatusSchema];

export const SessionStatusSchema = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  ERROR: 'ERROR',
} as const;
export type SessionStatus = (typeof SessionStatusSchema)[keyof typeof SessionStatusSchema];

export const GenerationRunStatusSchema = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type GenerationRunStatus =
  (typeof GenerationRunStatusSchema)[keyof typeof GenerationRunStatusSchema];

export const GenerationTriggerSchema = {
  CRON: 'CRON',
  MANUAL: 'MANUAL',
} as const;
export type GenerationTrigger =
  (typeof GenerationTriggerSchema)[keyof typeof GenerationTriggerSchema];

export const ContentSourceTypeSchema = {
  BRIEF: 'brief',
  ARTICLE: 'article',
  TOPIC: 'topic',
  CREATE_RUN: 'create_run',
} as const;
export type ContentSourceType =
  (typeof ContentSourceTypeSchema)[keyof typeof ContentSourceTypeSchema];
