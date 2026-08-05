// Zod schemas — shared validation contract between backend and UI
// Backend: NestJS pipes validate input against these
// UI: axios responses typed via z.infer

import { z } from 'zod';

// ============================================================
// Post schemas
// ============================================================

export const CreatePostDtoSchema = z.object({
  accountId: z.string().uuid(),
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  content: z.string().min(1).max(5000),
  threadId: z.string().uuid().optional(),
  threadPosition: z.number().int().min(0).default(0),
  sourceRef: z
    .object({
      type: z.enum(['brief', 'article', 'topic', 'create_run', 'recycle', 'review']),
      path: z.string(),
      topic: z.string().optional(),
      factIndex: z.number().int().optional(),
      keywords: z.array(z.string()).optional(),
      originalTopic: z.string().optional(),
      originalPostId: z.string().optional(),
      recycledAt: z.string().optional(),
    })
    .optional(),
});
export type CreatePostDto = z.infer<typeof CreatePostDtoSchema>;

export const ApprovePostDtoSchema = z.object({
  editedContent: z.string().min(1).max(5000).optional(),
});
export type ApprovePostDto = z.infer<typeof ApprovePostDtoSchema>;

export const UpdatePostStatusDtoSchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED', 'JUDGED', 'VERIFIED']),
  postUrl: z.string().url().optional(),
  errorMessage: z.string().optional(),
});
export type UpdatePostStatusDto = z.infer<typeof UpdatePostStatusDtoSchema>;

export const PostQueryDtoSchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED', 'JUDGED', 'VERIFIED']).optional(),
  network: z.enum(['X', 'THREADS', 'FACEBOOK', 'DEVTO', 'HASHNODE', 'LINKEDIN', 'BLUESKY', 'MASTODON', 'TELEGRAM', 'MEDIUM', 'SUBSTACK', 'REDDIT', 'QUORA', 'PINTEREST']).optional(),
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PostQueryDto = z.infer<typeof PostQueryDtoSchema>;

// ============================================================
// Generation schemas
// ============================================================

export const GeneratePostsDtoSchema = z.object({
  count: z.number().int().min(1).max(10).default(3),
  networks: z.array(z.enum(['X', 'THREADS', 'FACEBOOK'])).optional(),
  sourceType: z.enum(['brief', 'article', 'topic', 'create_run']).optional(),
  multiStage: z.boolean().optional().default(false), // F2: hook + continuation thread
});
export type GeneratePostsDto = z.infer<typeof GeneratePostsDtoSchema>;

// ============================================================
// Session schemas
// ============================================================

export const HealthCheckResultSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'ERROR', 'WARMUP', 'BANNED']),
  message: z.string().optional(),
});
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

// ============================================================
// Posting schemas
// ============================================================

export const PostNowDtoSchema = z.object({
  postId: z.string().uuid(),
});
export type PostNowDto = z.infer<typeof PostNowDtoSchema>;

export const BatchPostDtoSchema = z.object({
  postIds: z.array(z.string().uuid()).min(1).max(20),
});
export type BatchPostDto = z.infer<typeof BatchPostDtoSchema>;

// ============================================================
// Common schemas
// ============================================================

export const PaginationMetaSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  message: z.string(),
  error: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ============================================================
// Auth schemas — JWT cookie auth for UI (single admin account)
// ============================================================

export const LoginDtoSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const LoginResponseSchema = z.object({
  user: AuthUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ============================================================
// Sprint N: SSE Event schemas — typed SSE events for UI safety
// ============================================================

export const SseEventSchema = z.object({
  type: z.enum([
    'connected',
    'post_status',
    'health_alert',
    'generation_started',
    'generation_progress',
    'generation_completed',
    'generation_failed',
    'generation_paused',
    'generation_resumed',
    'queue_update',
    'session_status',
    'reply_escalation',
    'reconciliation_requeue',
  ]),
  postId: z.string().optional(),
  status: z.string().optional(),
  network: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  runId: z.string().optional(),
  node: z.string().optional(),
  topic: z.string().optional(),
  postCount: z.number().int().optional(),
  count: z.number().int().optional(),
  clientId: z.string().optional(),
  timestamp: z.string().optional(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;

// ============================================================
// A/B Testing schemas
// ============================================================

export const ABTestQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  network: z.enum(['X', 'THREADS', 'FACEBOOK']).optional(),
  minSampleSize: z.coerce.number().int().min(0).default(0),
});
export type ABTestQuery = z.infer<typeof ABTestQuerySchema>;

export const ABTestVariantSchema = z.object({
  label: z.string(),
  sampleSize: z.number().int(),
  avgLikes: z.number(),
  avgComments: z.number(),
  avgShares: z.number(),
  avgImpressions: z.number().nullable(),
  avgEngagement: z.number(),
  avgAntiAiTone: z.number().nullable(),
  avgHookStrength: z.number().nullable(),
});
export type ABTestVariant = z.infer<typeof ABTestVariantSchema>;

export const ABTestSchema = z.object({
  testId: z.string(),
  topic: z.string(),
  network: z.string(),
  totalPosts: z.number().int(),
  variants: z.array(ABTestVariantSchema),
  winner: z.string().nullable(),
  firstPostedAt: z.string().nullable(),
  lastPostedAt: z.string().nullable(),
});
export type ABTest = z.infer<typeof ABTestSchema>;
