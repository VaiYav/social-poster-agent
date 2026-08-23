import type { Prisma, SocialNetwork } from "../../generated/prisma/client.js";
import type { GeneratedPost } from "./generation.graph.js";

export interface GenerationAccount {
  readonly id: string;
  readonly active?: boolean;
}

export interface PersistedGenerationPost {
  readonly id: string;
  readonly network: SocialNetwork;
  readonly accountId: string;
  readonly llmMetadata: Prisma.JsonValue;
}

export interface GenerationSourceRef {
  readonly type: string;
  readonly path: string;
  readonly topic: string;
  readonly keywords: string[];
  readonly originalPostId?: string;
  readonly originalTopic?: string;
}

export interface GenerationPersistenceOptions {
  readonly language?: string;
  readonly recentHashes?: string[];
  readonly promptLabels?: Record<string, { label: string; isFallback?: boolean }>;
  readonly canonicalUrl?: string;
  readonly editorialAssignmentIds?: Partial<Record<SocialNetwork, string>>;
}

export interface PostFactoryInput {
  readonly genPost: GeneratedPost;
  readonly accountId: string;
  readonly candidateHash: string;
  readonly runId: string;
  readonly sourceRef: GenerationSourceRef;
  readonly options: GenerationPersistenceOptions;
}
