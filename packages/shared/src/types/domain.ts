// Domain types — used by both backend and UI
// These are plain TS types (not Zod) for domain entities

import type {
  SocialNetwork,
  PostStatus,
  SessionStatus,
  GenerationRunStatus,
  GenerationTrigger,
  ContentSourceType,
} from './enums.js';

export interface SocialAccount {
  id: string;
  network: SocialNetwork;
  handle: string;
  credentialsRef: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  accountId: string;
  status: SessionStatus;
  lastHealthCheck: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationRun {
  id: string;
  triggeredBy: GenerationTrigger;
  sourceTopics: unknown;
  status: GenerationRunStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface Post {
  id: string;
  generationRunId: string | null;
  accountId: string;
  threadId: string | null;
  threadPosition: number;
  network: SocialNetwork;
  content: string;
  sourceRef: SourceRef | null;
  status: PostStatus;
  postUrl: string | null;
  errorMessage: string | null;
  retryCount: number;
  llmMetadata: LlmMetadata | null;
  createdAt: string;
  approvedAt: string | null;
  postedAt: string | null;
}

export interface SourceRef {
  type: ContentSourceType;
  path: string;
  topic?: string;
  factIndex?: number;
}

export interface LlmMetadata {
  model: string;
  tokens?: number;
  cost?: number;
  promptVersion?: string;
  angleType?: string;
}

export interface PostThread {
  id: string;
  accountId: string;
  status: PostStatus;
  createdAt: string;
  postedAt: string | null;
}

export interface RateLimitConfig {
  network: SocialNetwork;
  maxPostsPerDay: number;
  maxPostsPerWeek: number;
  minDelayBetweenPostsMs: number;
}
