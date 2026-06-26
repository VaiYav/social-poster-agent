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
      type: z.enum(['brief', 'article', 'topic', 'create_run']),
      path: z.string(),
      topic: z.string().optional(),
      factIndex: z.number().int().optional(),
    })
    .optional(),
});
export type CreatePostDto = z.infer<typeof CreatePostDtoSchema>;

export const ApprovePostDtoSchema = z.object({
  editedContent: z.string().min(1).max(5000).optional(),
});
export type ApprovePostDto = z.infer<typeof ApprovePostDtoSchema>;

export const UpdatePostStatusDtoSchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED']),
  postUrl: z.string().url().optional(),
  errorMessage: z.string().optional(),
});
export type UpdatePostStatusDto = z.infer<typeof UpdatePostStatusDtoSchema>;

export const PostQueryDtoSchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED']).optional(),
  network: z.enum(['X', 'THREADS', 'FACEBOOK']).optional(),
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
