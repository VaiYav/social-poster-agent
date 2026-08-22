// Content source port — abstract interface for reading content topics.
// Implementations:
//   - ContentReader: reads content-agent-platform runs + blog (filesystem)
//   - DbContentReader: reads LLM-generated topics from the Topic table (DB-backed)
// The adapter is auto-selected in ContentModule based on CAP path availability.
// Unit tests can inject a mock with fixture data.

import type { ContentTopic } from "@spa/shared";

export const IContentPort = Symbol("IContentPort");

export interface IContentPort {
  /**
   * Get topics from all sources, prioritized: briefs > articles.
   */
  getTopics(limit?: number): Promise<ContentTopic[]>;

  /**
   * Read briefs from content-agent-platform runs (brief dirs).
   */
  readBriefs(limit?: number): Promise<ContentTopic[]>;

  /**
   * Read articles from content/blog/en/*.md (fallback source).
   */
  readArticles(limit?: number): Promise<ContentTopic[]>;

  /**
   * 2.8.1: Mark a topic as used so it is not reused in the next generation cycle.
   */
  markUsed(topic: ContentTopic): Promise<void>;

  /**
   * List all configured content sources and their health status.
   */
  getSources?(): Promise<{ sourceType: string; ok: boolean; error?: string }[]>;

  /**
   * Health check across all content sources.
   */
  healthCheck?(): Promise<{ ok: boolean; errors: string[] }>;

  /**
   * Invalidate any cached topic list.
   */
  invalidateCache?(): void;
}
