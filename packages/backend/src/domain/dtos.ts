// DTOs — re-exported from @spa/shared for backward compatibility
// New code should import directly from @spa/shared

export {
  CreatePostDtoSchema,
  type CreatePostDto,
  ApprovePostDtoSchema,
  type ApprovePostDto,
  UpdatePostStatusDtoSchema,
  type UpdatePostStatusDto,
  PostQueryDtoSchema,
  type PostQueryDto,
  GeneratePostsDtoSchema,
  type GeneratePostsDto,
  HealthCheckResultSchema,
  type HealthCheckResult,
  PostNowDtoSchema,
  type PostNowDto,
  BatchPostDtoSchema,
  type BatchPostDto,
  PaginationMetaSchema,
  type PaginationMeta,
  ApiErrorSchema,
  type ApiError,
} from '@spa/shared';

// Domain enums — re-export from @spa/shared
export type {
  SocialNetwork,
  PostStatus,
  SessionStatus,
  GenerationRunStatus,
  GenerationTrigger,
  ContentSourceType,
} from '@spa/shared';
