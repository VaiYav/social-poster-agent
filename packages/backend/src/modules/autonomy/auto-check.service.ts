/**
 * ADR-006: AutoCheck Service — content validation pipeline.
 *
 * Runs after generation, before auto-approve. A series of synchronous checks
 * that can reject content before it reaches the auto-approve gate.
 *
 * Content-safety checks (all must pass for content to proceed):
 *   1. Engagement-bait detector (algorithm penalty risk)
 *   2. Character limit per network
 *   3. Forbidden phrases (brand-voice violations)
 *   4. SimHash dedup (near-duplicate of existing content)
 *
 * Each check returns a CheckResult with pass/fail + reason.
 * The overall result is passed if ALL checks pass.
 *
 * A1/BUG-12: the LLM quality-score decision is intentionally NOT here — it lives
 * solely in AutoApproveService.evaluate() (the single decision-gate). A score
 * floor here previously pre-rejected scores 4-5, making evaluate()'s HUMAN_REVIEW
 * band [reviewThreshold, approveThreshold) unreachable. AutoCheck is now a pure
 * binary content-safety gate; score grading is the gate's job, not AutoCheck's.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { detectEngagementBait } from '../content-enhancements/engagement-bait.detector.js';
import { simhash, isDuplicateHash } from '../generation/simhash.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface CheckResult {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface AutoCheckResult {
  passed: boolean;
  checks: CheckResult[];
  rejectionReason?: string;
}

const NETWORK_LIMITS: Record<SocialNetwork, number> = {
  [SocialNetwork.X]: 280,
  [SocialNetwork.THREADS]: 500,
  [SocialNetwork.FACEBOOK]: 500,
};

// Forbidden phrases from brand-voice.md (fear-mongering, absolute predictions, medical/financial advice)
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\b(?:definitely|absolutely|100%)\s+(?:will|guaranteed)\b/i,
  /\b(?:medical|diagnosis|treat|cure)\s+(?:condition|disease|illness)\b/i,
  /\b(?:financial|investment|stock|crypto)\s+advice\b/i,
  /\b(?:doom|catastrophe|apocalypse|end of the world)\b/i,
];

@Injectable()
export class AutoCheckService {
  private readonly logger = new Logger(AutoCheckService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run all content-safety checks on a generated post.
   *
   * @param content Post text
   * @param network Target network
   * @returns AutoCheckResult with per-check details
   */
  async check(content: string, network: SocialNetwork): Promise<AutoCheckResult> {
    const checks: CheckResult[] = [];

    // 1. Engagement-bait check
    const baitMatches = detectEngagementBait(content);
    checks.push({
      name: 'engagement_bait',
      passed: baitMatches.length === 0,
      reason: baitMatches.length > 0
        ? `Bait patterns: ${baitMatches.map((m) => m.category).join(', ')}`
        : undefined,
    });

    // 2. Character limit
    const limit = NETWORK_LIMITS[network];
    checks.push({
      name: 'char_limit',
      passed: content.length <= limit,
      reason: content.length > limit
        ? `Content ${content.length} chars exceeds ${network} limit ${limit}`
        : undefined,
    });

    // 3. Forbidden phrases
    const forbiddenMatches = FORBIDDEN_PATTERNS.filter((p) => p.test(content));
    checks.push({
      name: 'forbidden_phrases',
      passed: forbiddenMatches.length === 0,
      reason: forbiddenMatches.length > 0
        ? `Forbidden patterns matched: ${forbiddenMatches.length}`
        : undefined,
    });

    // 4. SimHash dedup
    const candidateHash = simhash(content);
    const recentHashes = await this.loadRecentHashes(network);
    const isDup = isDuplicateHash(candidateHash, recentHashes);
    checks.push({
      name: 'simhash_dedup',
      passed: !isDup,
      reason: isDup ? 'Near-duplicate of existing content (SimHash distance ≤ 3)' : undefined,
    });

    const passed = checks.every((c) => c.passed);
    const failedChecks = checks.filter((c) => !c.passed);
    const rejectionReason = failedChecks.length > 0
      ? failedChecks.map((c) => `${c.name}: ${c.reason}`).join('; ')
      : undefined;

    if (!passed) {
      this.logger.warn(`AutoCheck FAILED for ${network}: ${rejectionReason}`);
    }

    return { passed, checks, rejectionReason };
  }

  /**
   * Load SimHash values from recent posts (last 30 days) for dedup checking.
   */
  private async loadRecentHashes(network: SocialNetwork): Promise<string[]> {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const posts = await this.prisma.post.findMany({
      where: {
        network,
        createdAt: { gte: since },
        OR: [
          { simhash: { not: null } },
          { status: 'POSTED' },
        ],
      },
      select: { simhash: true, content: true },
      take: 200,
    });

    return posts
      .map((p) => p.simhash ?? simhash(p.content))
      .filter(Boolean) as string[];
  }
}
