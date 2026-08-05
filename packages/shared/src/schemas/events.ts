import { z } from 'zod';

// ============================================================
// Post lifecycle domain events
// ============================================================

export const PostDraftGeneratedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
});

export const PostApprovedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
});

export const PostRejectedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
});

export const PostingStartedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
});

export const PostPostedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
  postUrl: z.string().optional(),
});

export const PostVerifiedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
  postUrl: z.string().optional(),
});

export const PostFailedEventSchema = z.object({
  postId: z.string(),
  network: z.string(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});

// ============================================================
// Generation run events
// ============================================================

export const GenerationRunStartedEventSchema = z.object({
  runId: z.string(),
  count: z.number().int().optional(),
});

export const GenerationRunCompletedEventSchema = z.object({
  runId: z.string(),
  postCount: z.number().int().optional(),
});

export const GenerationRunFailedEventSchema = z.object({
  runId: z.string(),
  error: z.string(),
});

export const GenerationRunPausedEventSchema = z.object({
  runId: z.string(),
});

export const GenerationRunResumedEventSchema = z.object({
  runId: z.string(),
});

// ============================================================
// Session events
// ============================================================

export const SessionLoginSuccessEventSchema = z.object({
  accountId: z.string(),
  network: z.string(),
});

export const SessionLoginFailedEventSchema = z.object({
  accountId: z.string(),
  network: z.string(),
  error: z.string(),
});

export const SessionExpiredEventSchema = z.object({
  accountId: z.string(),
  network: z.string(),
});

export const SessionBannedEventSchema = z.object({
  accountId: z.string(),
  network: z.string(),
  reason: z.string().optional(),
});

export const SessionBanRecoveredEventSchema = z.object({
  accountId: z.string(),
  network: z.string(),
});

// ============================================================
// Orchestrator events
// ============================================================

export const OrchestratorCycleEndEventSchema = z.object({
  cycle: z.number().int(),
  action: z.string().optional(),
  success: z.boolean().optional(),
  duration: z.number().optional(),
  sleepMs: z.number().int(),
});

// ============================================================
// Inferred types
// ============================================================

export type PostDraftGeneratedEvent = z.infer<typeof PostDraftGeneratedEventSchema>;
export type PostApprovedEvent = z.infer<typeof PostApprovedEventSchema>;
export type PostRejectedEvent = z.infer<typeof PostRejectedEventSchema>;
export type PostingStartedEvent = z.infer<typeof PostingStartedEventSchema>;
export type PostPostedEvent = z.infer<typeof PostPostedEventSchema>;
export type PostVerifiedEvent = z.infer<typeof PostVerifiedEventSchema>;
export type PostFailedEvent = z.infer<typeof PostFailedEventSchema>;

export type GenerationRunStartedEvent = z.infer<typeof GenerationRunStartedEventSchema>;
export type GenerationRunCompletedEvent = z.infer<typeof GenerationRunCompletedEventSchema>;
export type GenerationRunFailedEvent = z.infer<typeof GenerationRunFailedEventSchema>;
export type GenerationRunPausedEvent = z.infer<typeof GenerationRunPausedEventSchema>;
export type GenerationRunResumedEvent = z.infer<typeof GenerationRunResumedEventSchema>;

export type SessionLoginSuccessEvent = z.infer<typeof SessionLoginSuccessEventSchema>;
export type SessionLoginFailedEvent = z.infer<typeof SessionLoginFailedEventSchema>;
export type SessionExpiredEvent = z.infer<typeof SessionExpiredEventSchema>;
export type SessionBannedEvent = z.infer<typeof SessionBannedEventSchema>;
export type SessionBanRecoveredEvent = z.infer<typeof SessionBanRecoveredEventSchema>;

export type OrchestratorCycleEndEvent = z.infer<typeof OrchestratorCycleEndEventSchema>;
