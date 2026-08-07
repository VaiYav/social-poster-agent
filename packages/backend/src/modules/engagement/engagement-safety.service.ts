/**
 * F1 Safety & Tests: engagement ban-risk and safety guardrails.
 *
 * Centralizes deterministic checks that prevent the autonomous agent from:
 *   - navigating to or interacting with non-platform URLs (phishing / malicious)
 *   - posting comments/quotes that contain self-promo, troll/spam, or sensitive content
 *   - running up engagement counts on accounts in browse-only warmup
 *
 * The checks are intentionally fast, local, and LLM-free so they run on every
 * API action and every generated comment/quote without extra latency.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import {
  detectSensitive,
  isLikelyTroll,
  isLowValueComment,
} from '../replies/sensitive-filter.js';

export interface ContentSafetyResult {
  safe: boolean;
  reason?: string;
}

export interface UrlValidationResult {
  allowed: boolean;
  reason?: string;
}

const ALLOWED_HOSTS: Partial<Record<SocialNetwork, string[]>> = {
  X: ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com', 'www.x.com', 'www.twitter.com'],
  THREADS: ['threads.net', 'www.threads.net'],
  FACEBOOK: ['facebook.com', 'mbasic.facebook.com', 'm.facebook.com', 'www.facebook.com', 'mobile.facebook.com'],
};

@Injectable()
export class EngagementSafetyService {
  private readonly logger = new Logger(EngagementSafetyService.name);

  /**
   * Validate that a post/profile URL belongs to the target social network.
   * Blocks any non-platform hostname to prevent navigating to malicious sites.
   */
  validateUrl(network: SocialNetwork, url: string): UrlValidationResult {
    try {
      const parsed = new URL(url);
      const allowed = ALLOWED_HOSTS[network] ?? [];
      const hostname = parsed.hostname.toLowerCase();
      if (allowed.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
        return { allowed: true };
      }
      this.logger.warn(`Blocked ${network} engagement URL with disallowed host: ${hostname}`);
      return { allowed: false, reason: `URL host ${hostname} is not allowed for ${network}` };
    } catch {
      this.logger.warn(`Blocked invalid engagement URL: ${url.slice(0, 120)}`);
      return { allowed: false, reason: 'Invalid URL' };
    }
  }

  /**
   * Validate that user-supplied or LLM-generated engagement text is safe to post.
   * Flags self-promo/spam, troll keywords, and sensitive topics.
   */
  checkContentSafety(text: string | null | undefined): ContentSafetyResult {
    if (!text || text.trim().length === 0) {
      return { safe: true };
    }

    const t = text.trim();

    const lowValue = isLowValueComment(t);
    if (lowValue.lowValue) {
      this.logger.debug(`Engagement text flagged as low-value: ${lowValue.reason}`);
      return { safe: false, reason: lowValue.reason };
    }

    if (isLikelyTroll(t)) {
      this.logger.warn('Engagement text flagged as troll/spam');
      return { safe: false, reason: 'Troll/spam keyword detected' };
    }

    const sensitive = detectSensitive(t);
    if (sensitive.sensitive) {
      this.logger.warn(`Engagement text flagged as sensitive: ${sensitive.reason}`);
      return { safe: false, reason: sensitive.reason ?? 'Sensitive content detected' };
    }

    return { safe: true };
  }
}
