/**
 * A6 (step 1): prioritizeTopics — pure topic prioritization extracted from
 * GenerationService. Freshest-first sort + round-robin category rotation.
 *
 * Source: packages/backend/src/modules/generation/topic-prioritization.ts
 */
import { describe, it, expect } from 'vitest';
import type { ContentTopic } from '@spa/shared';

import { prioritizeTopics } from '../../../src/modules/generation/topic-prioritization';

function topic(id: string, category: string | undefined, publishedAt?: Date): ContentTopic {
  return {
    sourceType: 'topic',
    path: `topics/${id}`,
    topic: id,
    keywords: [],
    facts: [],
    category,
    publishedAt,
  } as ContentTopic;
}

const d = (ms: number) => new Date(ms);

describe('prioritizeTopics (A6 — pure)', () => {
  it('returns [] for no topics', () => {
    expect(prioritizeTopics([], 3)).toEqual([]);
  });

  it('sorts freshest-first when all share one category', () => {
    const out = prioritizeTopics(
      [topic('old', 'edu', d(100)), topic('new', 'edu', d(300)), topic('mid', 'edu', d(200))],
      3,
    );
    expect(out.map((t) => t.topic)).toEqual(['new', 'mid', 'old']);
  });

  it('rotates categories round-robin to avoid consecutive repeats', () => {
    // Freshest-first: A1(300) > A2(200) > B1(100). Round-robin → A1, B1, A2.
    const out = prioritizeTopics(
      [topic('A1', 'edu', d(300)), topic('A2', 'edu', d(200)), topic('B1', 'news', d(100))],
      3,
    );
    expect(out.map((t) => t.topic)).toEqual(['A1', 'B1', 'A2']);
  });

  it('honours the count limit', () => {
    const out = prioritizeTopics(
      [topic('a', 'x', d(3)), topic('b', 'y', d(2)), topic('c', 'z', d(1))],
      2,
    );
    expect(out).toHaveLength(2);
  });

  it('places undated topics last', () => {
    const out = prioritizeTopics([topic('undated', 'edu'), topic('dated', 'edu', d(100))], 2);
    expect(out.map((t) => t.topic)).toEqual(['dated', 'undated']);
  });

  it('treats missing category as a single "uncategorized" bucket', () => {
    const out = prioritizeTopics([topic('a', undefined, d(2)), topic('b', undefined, d(1))], 2);
    expect(out.map((t) => t.topic)).toEqual(['a', 'b']);
  });
});
