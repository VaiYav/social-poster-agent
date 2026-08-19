/**
 * F1: EngagementSafetyService unit tests.
 *
 * Covers URL allow-list and content safety guardrails for engagement actions.
 */
import { describe, it, expect } from 'vitest';
import { EngagementSafetyService } from '../../../src/modules/engagement/engagement-safety.service';
import { SocialNetwork } from '@prisma/client';

describe('F1: EngagementSafetyService', () => {
  const service = new EngagementSafetyService();

  describe('validateUrl', () => {
    it('allows X URLs for X network', () => {
      expect(service.validateUrl(SocialNetwork.X, 'https://x.com/user/status/123').allowed).toBe(true);
      expect(service.validateUrl(SocialNetwork.X, 'https://twitter.com/user/status/123').allowed).toBe(true);
      expect(service.validateUrl(SocialNetwork.X, 'https://mobile.x.com/user/status/123').allowed).toBe(true);
    });

    it('allows Threads URLs for Threads network', () => {
      expect(service.validateUrl(SocialNetwork.THREADS, 'https://threads.net/@user/post/123').allowed).toBe(true);
      expect(service.validateUrl(SocialNetwork.THREADS, 'https://www.threads.net/t/123').allowed).toBe(true);
    });

    it('allows Facebook URLs for Facebook network', () => {
      expect(service.validateUrl(SocialNetwork.FACEBOOK, 'https://facebook.com/groups/xyz/posts/123').allowed).toBe(true);
      expect(service.validateUrl(SocialNetwork.FACEBOOK, 'https://mbasic.facebook.com/story.php?id=123').allowed).toBe(true);
    });

    it('blocks URLs from the wrong network', () => {
      const result = service.validateUrl(SocialNetwork.X, 'https://threads.net/@user/post/123');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not allowed');
    });

    it('blocks non-platform URLs', () => {
      const result = service.validateUrl(SocialNetwork.X, 'https://evil.example.com/phishing');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not allowed');
    });

    it('blocks invalid URLs', () => {
      const result = service.validateUrl(SocialNetwork.X, 'not-a-url');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Invalid URL');
    });
  });

  describe('checkContentSafety', () => {
    it('allows safe productivity comment', () => {
      const result = service.checkContentSafety('Product cycle really does feel like a second adolescence.');
      expect(result.safe).toBe(true);
    });

    it('blocks self-promo / follow-bait', () => {
      const result = service.checkContentSafety('Follow me for more productivity tips!');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Follow/subscribe bait');
    });

    it('blocks troll keywords', () => {
      const result = service.checkContentSafety('This is stupid and fake.');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Troll/spam');
    });

    it('blocks sensitive content', () => {
      const result = service.checkContentSafety('I am in crisis and want to self harm.');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('sensitive');
    });

    it('blocks low-value generic comments', () => {
      const result = service.checkContentSafety('Nice');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Generic reaction');
    });

    it('treats empty text as safe (no-op)', () => {
      expect(service.checkContentSafety('').safe).toBe(true);
      expect(service.checkContentSafety(null).safe).toBe(true);
    });
  });
});
