/**
 * P1: isPermalink / normalizePermalink — guard against recording a non-permalink
 * URL (compose / home / profile) as a successfully POSTED post.
 *
 * Source: packages/backend/src/modules/posting/posters/permalink.ts
 */
import { describe, it, expect } from 'vitest';

import { isPermalink, normalizePermalink } from '../../../src/modules/posting/posters/permalink.js';

describe('permalink (P1 — native post-URL guard)', () => {
  describe('X', () => {
    it('accepts a /status/<id> permalink', () => {
      expect(isPermalink('https://x.com/myhandle/status/1788000000000000001', 'X')).toBe(true);
    });
    it.each([
      'https://x.com/home',
      'https://x.com/compose/post',
      'https://x.com/myhandle', // profile, not a post
      'https://x.com/i/flow/login',
    ])('rejects non-permalink %s', (url) => {
      expect(isPermalink(url, 'X')).toBe(false);
    });
  });

  describe('THREADS', () => {
    it('accepts a /@handle/post/<id> permalink', () => {
      expect(isPermalink('https://www.threads.com/@myhandle/post/CuX1y_2-3', 'THREADS')).toBe(true);
    });
    it.each(['https://www.threads.com/', 'https://www.threads.com/@myhandle'])(
      'rejects non-permalink %s',
      (url) => {
        expect(isPermalink(url, 'THREADS')).toBe(false);
      },
    );
  });

  describe('FACEBOOK', () => {
    it.each([
      'https://www.facebook.com/myzodiacai/posts/123456789',
      'https://www.facebook.com/story/permalink/123456',
      'https://www.facebook.com/photos/987654',
    ])('accepts a post permalink %s', (url) => {
      expect(isPermalink(url, 'FACEBOOK')).toBe(true);
    });
    it.each(['https://www.facebook.com/home', 'https://www.facebook.com/myzodiacai'])(
      'rejects non-permalink %s',
      (url) => {
        expect(isPermalink(url, 'FACEBOOK')).toBe(false);
      },
    );
  });

  it('treats null / undefined / empty as non-permalink', () => {
    expect(isPermalink(null, 'X')).toBe(false);
    expect(isPermalink(undefined, 'THREADS')).toBe(false);
    expect(isPermalink('', 'FACEBOOK')).toBe(false);
  });

  describe('normalizePermalink', () => {
    it('returns the URL when it is a permalink', () => {
      const url = 'https://x.com/myhandle/status/1788000000000000001';
      expect(normalizePermalink(url, 'X')).toBe(url);
    });
    it('returns null when it is not a permalink', () => {
      expect(normalizePermalink('https://x.com/home', 'X')).toBeNull();
      expect(normalizePermalink(undefined, 'X')).toBeNull();
    });
  });
});
