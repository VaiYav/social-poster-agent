// Content source port — abstract interface for reading content topics.
// Implementation: ContentReader (reads content-agent-platform runs + blog).
// Unit tests can inject a mock with fixture data.

import type { ContentTopic } from '@spa/shared';

export const IContentPort = Symbol('IContentPort');

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
}
