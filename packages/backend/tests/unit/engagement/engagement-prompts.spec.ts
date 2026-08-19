/**
 * Engagement prompts unit tests.
 *
 * Tests prompt building and decision response parsing.
 *
 * Source: packages/backend/src/infrastructure/llm/prompts/v0.4.0/engagement-decision.ts
 */
import { describe, it, expect } from 'vitest';
import {
  ENGAGEMENT_DECISION_PROMPT,
  ENGAGEMENT_COMMENT_PROMPT,
  ENGAGEMENT_QUOTE_PROMPT,
  ENGAGEMENT_BATCH_DECISION_PROMPT,
  parseDecisionResponse,
  parseBatchDecisionResponse,
  parseCommentResponse,
  parseQuoteResponse,
} from '../../../src/infrastructure/llm/prompts/v0.4.0/engagement-decision.js';
import { interpolate } from '../../../src/domain/prompt-interpolation.js';
import type { PostContext } from '../../../src/domain/ports/engagement-decision.port';

function createPostContext(overrides: Partial<PostContext> = {}): PostContext {
  return {
    network: 'X',
    postUrl: 'https://x.com/user/status/123',
    postText: 'Remote Work in Q1 brings energy.',
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
    expect(ENGAGEMENT_DECISION_PROMPT.systemPrompt).toContain('budget');
    expect(ENGAGEMENT_DECISION_PROMPT.systemPrompt).toContain('BUDGET');
  });

  it('PR-016: decision system prompt contains anti-spam rules', () => {
    expect(ENGAGEMENT_DECISION_PROMPT.systemPrompt).toContain('generic');
    expect(ENGAGEMENT_DECISION_PROMPT.systemPrompt).toContain('ChatGPT');
  });

  it('PR-017: comment system prompt contains brand voice guidelines', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('topic area');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('NO generic phrases');
  });

  it('PR-018: comment system prompt forbids self-promo', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('NO links');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('NO self-promotion');
  });

  // ── Language Adaptation (Sprint Q+) ──

  it('PR-018a: comment system prompt contains LANGUAGE section', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('LANGUAGE');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('CRITICAL');
  });

  it('PR-018b: comment system prompt instructs to match post language', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('EXACTLY this language');
  });

  it('PR-018c: comment system prompt forbids language mismatch', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('English on a non-English');
  });

  it('PR-018f: comment system prompt includes JSON language schema', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('Respond as JSON');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('"language"');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('en|ru|uk|es|it');
  });

  it('PR-018g: quote system prompt includes JSON language schema', () => {
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('Respond as JSON');
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('"language"');
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('en|ru|uk|es|it');
  });

  it('PR-018h: comment system prompt includes detectedLanguage placeholder', () => {
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('{detectedLanguage}');
    expect(ENGAGEMENT_COMMENT_PROMPT.systemPrompt).toContain('EXACTLY this language');
  });

  it('PR-018i: quote system prompt includes detectedLanguage placeholder', () => {
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('{detectedLanguage}');
    expect(ENGAGEMENT_QUOTE_PROMPT.systemPrompt).toContain('EXACTLY this language');
  });

  // ── parseCommentResponse ──

  it('PR-COM-001: parses JSON comment response with language', () => {
    const result = parseCommentResponse('{"language":"es","comment":"¡Gracias por el post!"}');
    expect(result.language).toBe('es');
    expect(result.comment).toBe('¡Gracias por el post!');
  });

  it('PR-COM-002: parses JSON wrapped in markdown', () => {
    const result = parseCommentResponse('```json\n{"language":"it","comment":"Grazie"}\n```');
    expect(result.language).toBe('it');
    expect(result.comment).toBe('Grazie');
  });

  it('PR-COM-003: falls back to raw text when JSON parse fails', () => {
    const result = parseCommentResponse('Just a plain comment');
    expect(result.language).toBeUndefined();
    expect(result.comment).toBe('Just a plain comment');
  });

  it('PR-COM-004: returns null for empty response', () => {
    expect(parseCommentResponse('').comment).toBeNull();
    expect(parseCommentResponse('   ').comment).toBeNull();
  });

  it('PR-COM-005: handles JSON without comment field (fallback to raw)', () => {
    const result = parseCommentResponse('{"language":"en"}');
    // No comment field — fallback to raw text
    expect(result.comment).toBe('{"language":"en"}');
  });

  // ── parseQuoteResponse ──

  it('PR-QUO-001: parses JSON quote response with language', () => {
    const result = parseQuoteResponse('{"language":"es","quote":"¡Excelente post!"}');
    expect(result.language).toBe('es');
    expect(result.quote).toBe('¡Excelente post!');
  });

  it('PR-QUO-002: parses JSON wrapped in markdown', () => {
    const result = parseQuoteResponse('```json\n{"language":"it","quote":"Ottimo post!"}\n```');
    expect(result.language).toBe('it');
    expect(result.quote).toBe('Ottimo post!');
  });

  it('PR-QUO-003: falls back to raw text when JSON parse fails', () => {
    const result = parseQuoteResponse('Just a plain quote');
    expect(result.language).toBeUndefined();
    expect(result.quote).toBe('Just a plain quote');
  });

  it('PR-QUO-004: returns null for empty response', () => {
    expect(parseQuoteResponse('').quote).toBeNull();
    expect(parseQuoteResponse('   ').quote).toBeNull();
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

});
