// Domain types — used by both backend and UI
// These are plain TS types (not Zod) for domain entities

import type {
  SocialNetwork,
  PostStatus,
  SessionStatus,
  GenerationRunStatus,
  GenerationTrigger,
  ContentSourceType,
  ContentType,
} from "./enums.js";

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
  /** Optional generated-media metadata exposed through the authenticated API. */
  media?: {
    readonly url?: string;
    readonly path?: string;
    readonly altText?: string;
    readonly model?: string;
    readonly costUsd?: number;
    readonly generated?: boolean;
  } | null;
  // ── Syndication fields (Phase 0-1) ──
  contentType: ContentType;
  canonicalUrl: string | null;
  syndicatedUrls: Record<string, string> | null;
  judgeScores: JudgeScores | null;
  judgeRetried: boolean;
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
  /** F2: multi-stage thread marker (root post) */
  multiStage?: boolean;
  /** F2: total number of stages in a multi-stage thread */
  threadDepth?: number;
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

// ============================================================
// Syndication types (Phase 0+)
// ============================================================

/** Article judge scores — extends social post judge with article-specific criteria. */
export interface ArticleJudgeScores {
  [key: string]: number | string;
  anti_ai_tone: number;
  anti_ai_tone_reason: string;
  hook_strength: number;
  hook_strength_reason: string;
  factual_accuracy: number;
  factual_accuracy_reason: string;
  structure_quality: number;
  structure_quality_reason: string;
  seo_optimization: number;
  seo_optimization_reason: string;
}

/** Content for article generation — long-form markdown content. */
export interface ArticleContent {
  title: string;
  slug: string;
  bodyMarkdown: string;
  excerpt: string;
  tags: string[];
  coverImageUrl?: string;
}

/** Content for social post generation — short-form text. */
export interface SocialPostContent {
  text: string;
  network: SocialNetwork;
  canonicalUrl?: string;
  hashtags?: string[];
}

/** Result of a publish operation to a platform. */
export interface PublishResult {
  success: boolean;
  postUrl: string | null;
  canonicalUrl: string | null;
  errorMessage?: string;
  /** Platform-specific metadata (e.g. Dev.to article ID, Reddit comment ID). */
  platformId?: string;
}

/** Map of syndicated URLs per network: { DEVTO: 'https://...', HASHNODE: 'https://...' }. */
export type SyndicatedUrls = Record<string, string>;

// ============================================================
// Article Graph State (LangGraph)
// ============================================================

/**
 * Article generation LangGraph state.
 * Used by `packages/backend/src/modules/generation/article-graph.ts`.
 *
 * Flow: research_extract → outline → draft_article → judge_article →
 *   [refine loop] → set_canonical → save_to_db
 */
export interface ArticleGraphState {
  /** Run ID for tracing + checkpoint key. */
  runId: string;
  /** Topic from content source (CAP repo or DB Topic model). */
  topic: string;
  /** Keywords associated with the topic (for SEO optimization). */
  keywords: string[];
  /** Facts extracted from the topic + RAG (research_extract node output). */
  facts: string[];
  /** Article outline — H2/H3 structure (outline node output). */
  outline: ArticleOutlineSection[];
  /** Full article in markdown (draft_article node output). */
  draft: ArticleContent | null;
  /** Judge evaluation scores (judge_article node output). */
  judgeScores: ArticleJudgeScores | null;
  /** Judge feedback for refine loop (reasons why article needs improvement). */
  judgeFeedback: string | null;
  /** Number of refine iterations (0 = first draft, max 3). */
  refineCount: number;
  /** Whether the judge triggered a refine retry. */
  judgeRetried: boolean;
  /** Canonical URL for the article (set_canonical node output). */
  canonicalUrl: string | null;
  /** Final article after refine loop (save_to_db node output). */
  finalArticle: ArticleContent | null;
  /** Error message if any node failed (per-network error isolation pattern). */
  error: string | null;
  /** Language code (ISO 639-1: en, ru, uk, es, it). */
  language: string;
  /** Target platforms for syndication (subset of SocialNetwork). */
  targetNetworks: SocialNetwork[];
}

/** A section in the article outline (H2 with optional H3 subsections). */
export interface ArticleOutlineSection {
  heading: string;
  level: 2 | 3;
  keyPoints: string[];
  estimatedWordCount: number;
}

/** Options for article generation. */
export interface GenerateArticleOptions {
  /** Topic to generate article about. */
  topic: string;
  /** Keywords for SEO optimization. */
  keywords?: string[];
  /** Language code (default: 'en'). */
  language?: string;
  /** Target platforms for syndication (default: DEVTO, HASHNODE, LINKEDIN). */
  targetNetworks?: SocialNetwork[];
  /** Langfuse trace tags. */
  tags?: string[];
}
