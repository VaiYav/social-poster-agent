import { z } from 'zod';

export const SseConnectedEventSchema = z.object({
  type: z.literal('connected'),
  clientId: z.string(),
  timestamp: z.string().optional(),
});

export const SsePostStatusEventSchema = z.object({
  type: z.literal('post_status'),
  postId: z.string(),
  status: z.string(),
  network: z.string(),
  url: z.string().optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  timestamp: z.string().optional(),
});

export const SseHealthAlertEventSchema = z.object({
  type: z.literal('health_alert'),
  severity: z.enum(['critical', 'warning', 'info']),
  error: z.string(),
  timestamp: z.string().optional(),
});

export const SseGenerationStartedEventSchema = z.object({
  type: z.literal('generation_started'),
  runId: z.string(),
  count: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseGenerationProgressEventSchema = z.object({
  type: z.literal('generation_progress'),
  node: z.string(),
  topic: z.string(),
  postsCount: z.number().int(),
  error: z.string().optional(),
  timestamp: z.string().optional(),
});

export const SseGenerationCompletedEventSchema = z.object({
  type: z.literal('generation_completed'),
  runId: z.string(),
  postCount: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseGenerationFailedEventSchema = z.object({
  type: z.literal('generation_failed'),
  runId: z.string(),
  error: z.string(),
  timestamp: z.string().optional(),
});

export const SseGenerationPausedEventSchema = z.object({
  type: z.literal('generation_paused'),
  runId: z.string(),
  timestamp: z.string().optional(),
});

export const SseGenerationResumedEventSchema = z.object({
  type: z.literal('generation_resumed'),
  runId: z.string(),
  timestamp: z.string().optional(),
});

export const SseInteractionEventSchema = z.object({
  type: z.enum(['interaction_started', 'interaction_completed', 'interaction_failed']),
  interactionId: z.string(),
  interactionType: z.string(),
  network: z.string(),
  targetUrl: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string().optional(),
});

export const SseBrowsingSessionStartedEventSchema = z.object({
  type: z.literal('browsing_session_started'),
  sessionId: z.string(),
  network: z.string(),
  durationSec: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseBrowsingSessionCompletedEventSchema = z.object({
  type: z.literal('browsing_session_completed'),
  sessionId: z.string(),
  network: z.string(),
  postsViewed: z.number().int(),
  interactionsCount: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseBrowsingSessionFailedEventSchema = z.object({
  type: z.literal('browsing_session_failed'),
  sessionId: z.string(),
  network: z.string(),
  error: z.string(),
  timestamp: z.string().optional(),
});

export const SseRepliesMonitorEventSchema = z.object({
  type: z.literal('replies_monitor'),
  postsChecked: z.number().int(),
  commentsScraped: z.number().int(),
  repliesPosted: z.number().int(),
  repliesScheduled: z.number().int(),
  humanReview: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseReplyPostedEventSchema = z.object({
  type: z.literal('reply_posted'),
  postId: z.string(),
  commentId: z.string(),
  network: z.string(),
  timestamp: z.string().optional(),
});

export const SseReconciliationRequeueEventSchema = z.object({
  type: z.literal('reconciliation_requeue'),
  postId: z.string(),
  network: z.string(),
  timestamp: z.string().optional(),
});

export const SseAutoApproveEventSchema = z.object({
  type: z.literal('auto_approve'),
  postId: z.string(),
  decision: z.string(),
  qualityScore: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
  timestamp: z.string().optional(),
});

export const SseAutonomousCycleEventSchema = z.object({
  type: z.literal('autonomous_cycle'),
  action: z.enum(['started', 'completed', 'failed']),
  generated: z.number().int().optional(),
  autoApproved: z.number().int().optional(),
  rejected: z.number().int().optional(),
  humanReview: z.number().int().optional(),
  error: z.string().optional(),
  timestamp: z.string().optional(),
});

export const SseOrchestratorCycleEndEventSchema = z.object({
  type: z.literal('orchestrator_cycle_end'),
  cycle: z.number().int(),
  action: z.string().optional(),
  success: z.boolean().optional(),
  duration: z.number().optional(),
  sleepMs: z.number().int(),
  timestamp: z.string().optional(),
});

export const SseFlowControlEventSchema = z.object({
  type: z.literal('flow_control'),
  action: z.enum(['paused', 'resumed', 'pause_all', 'resume_all']),
  flow: z.enum(['generation', 'posting', 'engagement', 'replies', 'llm_triage', 'auto_approve']).optional(),
  reason: z.string().nullable().optional(),
  timestamp: z.string().optional(),
});

export const SseMetricsSnapshotEventSchema = z.object({
  type: z.literal('metrics_snapshot'),
  timestamp: z.number(),
  agents: z.record(z.unknown()),
});

export const SSEventSchema = z.discriminatedUnion('type', [
  SseConnectedEventSchema,
  SsePostStatusEventSchema,
  SseHealthAlertEventSchema,
  SseGenerationStartedEventSchema,
  SseGenerationProgressEventSchema,
  SseGenerationCompletedEventSchema,
  SseGenerationFailedEventSchema,
  SseGenerationPausedEventSchema,
  SseGenerationResumedEventSchema,
  SseInteractionEventSchema,
  SseBrowsingSessionStartedEventSchema,
  SseBrowsingSessionCompletedEventSchema,
  SseBrowsingSessionFailedEventSchema,
  SseRepliesMonitorEventSchema,
  SseReplyPostedEventSchema,
  SseReconciliationRequeueEventSchema,
  SseAutoApproveEventSchema,
  SseAutonomousCycleEventSchema,
  SseOrchestratorCycleEndEventSchema,
  SseFlowControlEventSchema,
  SseMetricsSnapshotEventSchema,
]);

export type SSEvent = z.infer<typeof SSEventSchema>;

// Re-export event-specific types for convenience
export type SseConnectedEvent = z.infer<typeof SseConnectedEventSchema>;
export type SsePostStatusEvent = z.infer<typeof SsePostStatusEventSchema>;
export type SseHealthAlertEvent = z.infer<typeof SseHealthAlertEventSchema>;
export type SseGenerationStartedEvent = z.infer<typeof SseGenerationStartedEventSchema>;
export type SseGenerationProgressEvent = z.infer<typeof SseGenerationProgressEventSchema>;
export type SseGenerationCompletedEvent = z.infer<typeof SseGenerationCompletedEventSchema>;
export type SseGenerationFailedEvent = z.infer<typeof SseGenerationFailedEventSchema>;
export type SseGenerationPausedEvent = z.infer<typeof SseGenerationPausedEventSchema>;
export type SseGenerationResumedEvent = z.infer<typeof SseGenerationResumedEventSchema>;
export type SseInteractionEvent = z.infer<typeof SseInteractionEventSchema>;
export type SseBrowsingSessionStartedEvent = z.infer<typeof SseBrowsingSessionStartedEventSchema>;
export type SseBrowsingSessionCompletedEvent = z.infer<typeof SseBrowsingSessionCompletedEventSchema>;
export type SseBrowsingSessionFailedEvent = z.infer<typeof SseBrowsingSessionFailedEventSchema>;
export type SseRepliesMonitorEvent = z.infer<typeof SseRepliesMonitorEventSchema>;
export type SseReplyPostedEvent = z.infer<typeof SseReplyPostedEventSchema>;
export type SseReconciliationRequeueEvent = z.infer<typeof SseReconciliationRequeueEventSchema>;
export type SseAutoApproveEvent = z.infer<typeof SseAutoApproveEventSchema>;
export type SseAutonomousCycleEvent = z.infer<typeof SseAutonomousCycleEventSchema>;
export type SseOrchestratorCycleEndEvent = z.infer<typeof SseOrchestratorCycleEndEventSchema>;
export type SseFlowControlEvent = z.infer<typeof SseFlowControlEventSchema>;
export type SseMetricsSnapshotEvent = z.infer<typeof SseMetricsSnapshotEventSchema>;
