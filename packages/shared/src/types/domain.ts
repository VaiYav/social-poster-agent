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
  warmupEnabled: boolean;
  warmupStartedAt: string | null;
  warmupDaysTotal: number;
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

/** Session with included account relation (as returned by GET /sessions) */
export interface SessionWithAccount extends Session {
  account: SocialAccount;
}

export interface GenerationRun {
  id: string;
  triggeredBy: GenerationTrigger;
  sourceTopics: unknown;
  status: GenerationRunStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  /** Prisma _count relation — included when `include: { _count: { select: { posts: true } } }` */
  _count?: { posts: number };
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
  keywords?: string[];
  originalTopic?: string;
  originalPostId?: string;
  recycledAt?: string;
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

/** Stage 2: LLM-as-a-Judge evaluation scores (0.0-1.0 per criterion). */
export interface JudgeScores {
  [key: string]: number | string;
  anti_ai_tone: number;
  anti_ai_tone_reason: string;
  hook_strength: number;
  hook_strength_reason: string;
  factual_accuracy: number;
  factual_accuracy_reason: string;
  character_limit: number;
  character_limit_reason: string;
}
