/**
 * Engagement prompts unit tests.
 *
 * Tests prompt building and decision response parsing.
 *
 * Source: packages/backend/src/infrastructure/llm/prompts/v0.4.0/engagement-decision.ts
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionUserPrompt,
  buildCommentUserPrompt,
  parseDecisionResponse,
  buildBatchDecisionUserPrompt,
  parseBatchDecisionResponse,
  ENGAGEMENT_DECISION_SYSTEM_PROMPT,
  ENGAGEMENT_COMMENT_SYSTEM_PROMPT,
} from '../../../src/infrastructure/llm/prompts/v0.4.0/engagement-decision';
import type { PostContext } from '../../../src/domain/ports/engagement-decision.port';

function createPostContext(overrides: Partial<PostContext> = {}): PostContext {
  return {
    network: 'X',
    postUrl: 'https://x.com/user/status/123',
    postText: 'Mars in Aries brings energy.',
    hasMedia: true,
    source: 'hashtag',
    likesThisSession: 3,
    commentsThisSession: 1,
    likesMaxPerSession: 15,
    commentsMaxPerSession: 4,
    ...overrides,
  };
}

describe('Engagement Prompts', () => {
  // ── buildDecisionUserPrompt ──

  it('PR-001: builds decision prompt with all context fields', () => {
    const ctx = createPostContext({ authorHandle: 'astrologer' });
    const prompt = buildDecisionUserPrompt(ctx);
    expect(prompt).toContain('X');
    expect(prompt).toContain('hashtag');
    expect(prompt).toContain('astrologer');
    expect(prompt).toContain('true'); // hasMedia
    expect(prompt).toContain('Mars in Aries brings energy.');
    expect(prompt).toContain('3/15'); // likes budget
    expect(prompt).toContain('1/4'); // comments budget
  });

  it('PR-002: truncates long post text to 500 chars', () => {
    const longText = 'x'.repeat(1000);
    const ctx = createPostContext({ postText: longText });
    const prompt = buildDecisionUserPrompt(ctx);
    // The text should be truncated (500 chars max in the prompt)
    expect(prompt).not.toContain('x'.repeat(600));
  });

  it('PR-003: handles missing author handle', () => {
    const ctx = createPostContext({ authorHandle: undefined });
    const prompt = buildDecisionUserPrompt(ctx);
    expect(prompt).toContain('unknown');
  });

  // ── buildCommentUserPrompt ──

  it('PR-004: builds comment prompt with post context', () => {
    const ctx = createPostContext({ authorHandle: 'costar' });
    const prompt = buildCommentUserPrompt(ctx);
    expect(prompt).toContain('X');
    expect(prompt).toContain('costar');
    expect(prompt).toContain('Mars in Aries brings energy.');
  });

  it('PR-005: truncates long post text in comment prompt', () => {
    const longText = 'y'.repeat(1000);
    const ctx = createPostContext({ postText: longText });
    const prompt = buildCommentUserPrompt(ctx);
    expect(prompt).not.toContain('y'.repeat(600));
  });

  // ── parseDecisionResponse ──

  it('PR-006: parses valid JSON decision', () => {
    const result = parseDecisionResponse('{"action":"like","reason":"good","confidence":0.9}');
    expect(result.action).toBe('like');
    expect(result.reason).toBe('good');
    expect(result.confidence).toBe(0.9);
  });

  it('PR-007: parses JSON with commentText', () => {
    const result = parseDecisionResponse(
      '{"action":"comment","reason":"relevant","confidence":0.8,"commentText":"Great insight!"}',
    );
    expect(result.action).toBe('comment');
    expect(result.commentText).toBe('Great insight!');
  });

  it('PR-008: falls back to scroll for non-JSON response', () => {
    const result = parseDecisionResponse('not json');
    expect(result.action).toBe('scroll');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('PR-009: falls back to scroll for invalid action', () => {
    const result = parseDecisionResponse('{"action":"invalid","reason":"test","confidence":0.5}');
    expect(result.action).toBe('scroll');
  });

  it('PR-010: parses JSON wrapped in markdown code block', () => {
    const result = parseDecisionResponse('```json\n{"action":"read","reason":"interesting","confidence":0.7}\n```');
    expect(result.action).toBe('read');
    expect(result.confidence).toBe(0.7);
  });

  it('PR-011: handles missing confidence (defaults to 0.5)', () => {
    const result = parseDecisionResponse('{"action":"scroll","reason":"test"}');
    expect(result.confidence).toBe(0.5);
  });

  it('PR-012: handles missing reason (defaults to "No reason provided")', () => {
    const result = parseDecisionResponse('{"action":"scroll","confidence":0.5}');
    expect(result.reason).toBe('No reason provided');
  });

  it('PR-013: handles JSON parse error', () => {
    const result = parseDecisionResponse('{invalid json}');
    expect(result.action).toBe('scroll');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('PR-014: accepts all valid action types', () => {
    const actions = ['scroll', 'read', 'like', 'comment', 'open-thread', 'visit-profile', 'back', 'skip'];
    for (const action of actions) {
      const result = parseDecisionResponse(`{"action":"${action}","reason":"test","confidence":0.5}`);
      expect(result.action).toBe(action);
    }
  });

  // ── System prompts ──

  it('PR-015: decision system prompt contains budget awareness', () => {
    expect(ENGAGEMENT_DECISION_SYSTEM_PROMPT).toContain('budget');
    expect(ENGAGEMENT_DECISION_SYSTEM_PROMPT).toContain('BUDGET');
  });

  it('PR-016: decision system prompt contains anti-spam rules', () => {
    expect(ENGAGEMENT_DECISION_SYSTEM_PROMPT).toContain('generic');
    expect(ENGAGEMENT_DECISION_SYSTEM_PROMPT).toContain('ChatGPT');
  });

  it('PR-017: comment system prompt contains brand voice guidelines', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('astrology');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('dispositing planet');
  });

  it('PR-018: comment system prompt forbids self-promo', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('NO links');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('NO self-promotion');
  });

  // ── Language Adaptation (Sprint Q+) ──

  it('PR-018a: comment system prompt contains LANGUAGE section', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('LANGUAGE');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('CRITICAL');
  });

  it('PR-018b: comment system prompt instructs to match post language', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('SAME LANGUAGE');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('Ukrainian');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('Russian');
  });

  it('PR-018c: comment system prompt forbids language mismatch', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('English on a non-English');
  });

  it('PR-018d: comment system prompt includes Ukrainian example comments', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('GOOD comments (Ukrainian)');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('Сатурн повернувся');
  });

  it('PR-018e: comment system prompt includes Russian example comments', () => {
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('GOOD comments (Russian)');
    expect(ENGAGEMENT_COMMENT_SYSTEM_PROMPT).toContain('Сатурн вернулся');
  });

  it('PR-018f: comment user prompt instructs language matching', () => {
    const ctx = createPostContext({ postText: 'Це український пост' });
    const prompt = buildCommentUserPrompt(ctx);
    expect(prompt).toContain('Match the language');
    expect(prompt).toContain('Ukrainian');
  });

  // ── buildBatchDecisionUserPrompt ──

  it('PR-019: builds batch prompt with correct post count', () => {
    const contexts = [
      createPostContext({ postText: 'Post one' }),
      createPostContext({ postText: 'Post two' }),
      createPostContext({ postText: 'Post three' }),
    ];
    const prompt = buildBatchDecisionUserPrompt(contexts);
    expect(prompt).toContain('3 posts');
    expect(prompt).toContain('3 elements');
    expect(prompt).toContain('Post 1');
    expect(prompt).toContain('Post 2');
    expect(prompt).toContain('Post 3');
  });

  it('PR-020: batch prompt includes post text and budget for each post', () => {
    const contexts = [
      createPostContext({ postText: 'Mars in Aries', likesThisSession: 5, likesMaxPerSession: 10 }),
      createPostContext({ postText: 'Moon in Cancer', likesThisSession: 6, likesMaxPerSession: 10 }),
    ];
    const prompt = buildBatchDecisionUserPrompt(contexts);
    expect(prompt).toContain('Mars in Aries');
    expect(prompt).toContain('Moon in Cancer');
    expect(prompt).toContain('5/10');
    expect(prompt).toContain('6/10');
  });

  it('PR-021: batch prompt truncates post text to 300 chars', () => {
    const longText = 'z'.repeat(500);
    const ctx = createPostContext({ postText: longText });
    const prompt = buildBatchDecisionUserPrompt([ctx]);
    expect(prompt).not.toContain('z'.repeat(301));
  });

  it('PR-022: batch prompt handles single post', () => {
    const ctx = createPostContext({ postText: 'Single post' });
    const prompt = buildBatchDecisionUserPrompt([ctx]);
    expect(prompt).toContain('1 posts');
    expect(prompt).toContain('Post 1');
    expect(prompt).toContain('Single post');
  });

  // ── parseBatchDecisionResponse ──

  it('PR-023: parses valid JSON array of decisions', () => {
    const content = '[{"action":"like","reason":"good","confidence":0.9},{"action":"scroll","reason":"boring","confidence":0.6}]';
    const results = parseBatchDecisionResponse(content, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe('like');
    expect(results[1]!.action).toBe('scroll');
  });

  it('PR-024: parses batch with commentText', () => {
    const content = '[{"action":"comment","reason":"relevant","confidence":0.8,"commentText":"Great!"}]';
    const results = parseBatchDecisionResponse(content, 1);
    expect(results[0]!.action).toBe('comment');
    expect(results[0]!.commentText).toBe('Great!');
  });

  it('PR-025: falls back to scroll for non-JSON batch response', () => {
    const results = parseBatchDecisionResponse('not json at all', 3);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.action).toBe('scroll');
      expect(r.confidence).toBeLessThan(0.5);
    }
  });

  it('PR-026: falls back to scroll for invalid action in batch', () => {
    const content = '[{"action":"invalid","reason":"test","confidence":0.5}]';
    const results = parseBatchDecisionResponse(content, 1);
    expect(results[0]!.action).toBe('scroll');
  });

  it('PR-027: parses batch wrapped in markdown code block', () => {
    const content = '```json\n[{"action":"read","reason":"interesting","confidence":0.7}]\n```';
    const results = parseBatchDecisionResponse(content, 1);
    expect(results[0]!.action).toBe('read');
    expect(results[0]!.confidence).toBe(0.7);
  });

  it('PR-028: pads short response to expected count', () => {
    const content = '[{"action":"like","reason":"good","confidence":0.9}]';
    const results = parseBatchDecisionResponse(content, 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.action).toBe('like');
    expect(results[1]!.action).toBe('scroll'); // padded
    expect(results[2]!.action).toBe('scroll'); // padded
  });

  it('PR-029: truncates long response to expected count', () => {
    const content = '[{"action":"like","reason":"1","confidence":0.9},{"action":"like","reason":"2","confidence":0.9},{"action":"like","reason":"3","confidence":0.9}]';
    const results = parseBatchDecisionResponse(content, 2);
    expect(results).toHaveLength(2);
  });

  it('PR-030: handles JSON parse error in batch', () => {
    const results = parseBatchDecisionResponse('[invalid json]', 2);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.action).toBe('scroll');
    }
  });

  it('PR-031: handles empty batch', () => {
    const prompt = buildBatchDecisionUserPrompt([]);
    expect(prompt).toContain('0 posts');
  });
});
