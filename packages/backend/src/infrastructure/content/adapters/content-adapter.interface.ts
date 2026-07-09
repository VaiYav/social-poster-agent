import type { ContentTopic } from '@spa/shared';

export const CONTENT_ADAPTERS = Symbol('CONTENT_ADAPTERS');

/**
 * IContentAdapter — pluggable source for content topics.
 *
 * Implementations fetch topics from a single source (CAP filesystem, RSS feed,
 * REST API, DB, etc.) and expose basic health/lifecycle hooks.
 */
export interface IContentAdapter {
  /** Adapter identifier (e.g. 'cap_file', 'rss', 'api', 'db'). */
  readonly sourceType: string;

  /** Return true if this adapter can claim the given topic source type. */
  canHandle(sourceType: string): boolean;

  /** Fetch topics from this source. */
  fetchTopics(limit: number, since?: Date): Promise<ContentTopic[]>;

  /** Optional: fetch a single article by path. */
  fetchArticle?(path: string): Promise<ContentTopic | null>;

  /** Optional: source-specific brief reader. */
  readBriefs?(limit: number): Promise<ContentTopic[]>;

  /** Optional: source-specific article reader. */
  readArticles?(limit: number): Promise<ContentTopic[]>;

  /** Health check for this source. */
  healthCheck(): Promise<{ ok: boolean; error?: string }>;

  /** Last error message, if any. */
  lastError: string | null;

  /** Mark a topic as used so it is not reused in the next generation cycle. */
  markUsed(topic: ContentTopic): Promise<void>;
}
