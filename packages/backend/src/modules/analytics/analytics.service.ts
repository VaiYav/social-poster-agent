/**
 * Sprint O / F6: Analytics Service — aggregate metrics for dashboard.
 *
 * Computes posting stats, success rates, network breakdowns, and time-series
 * data for the analytics dashboard. All queries are read-only against Prisma.
 */
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import {
  PostStatus,
  SocialNetwork,
  GenerationTrigger,
  Prisma,
} from "../../generated/prisma/client";
import type { JudgeScores } from "@spa/shared";

export interface JudgeScoreAverages {
  antiAiTone: number | null;
  hookStrength: number | null;
  factualAccuracy: number | null;
  characterLimit: number | null;
  count: number;
}

export type JudgeDimension = "antiAiTone" | "hookStrength" | "factualAccuracy" | "characterLimit";

export interface JudgeStats {
  overall: JudgeScoreAverages;
  byDecision: Record<string, JudgeScoreAverages>;
}

export interface AnalyticsSummary {
  totalPosts: number;
  posted: number;
  failed: number;
  pending: number;
  successRate: number;
  byNetwork: Record<string, { total: number; posted: number; failed: number }>;
  last7Days: { date: string; posted: number; failed: number }[];
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get overall analytics summary.
   */
  async getSummary(): Promise<AnalyticsSummary> {
    const [totalPosts, posted, failed, pending, networkStats, dailyStats] = await Promise.all([
      this.prisma.post.count(),
      this.prisma.post.count({ where: { status: PostStatus.POSTED } }),
      this.prisma.post.count({ where: { status: PostStatus.FAILED } }),
      this.prisma.post.count({
        where: { status: { in: [PostStatus.DRAFT, PostStatus.APPROVED, PostStatus.POSTING] } },
      }),
      this.getNetworkStats(),
      this.getDailyStats(7),
    ]);

    const successRate = posted + failed > 0 ? (posted / (posted + failed)) * 100 : 0;

    return {
      totalPosts,
      posted,
      failed,
      pending,
      successRate: Math.round(successRate * 100) / 100,
      byNetwork: networkStats,
      last7Days: dailyStats,
    };
  }

  /**
   * Get per-network breakdown.
   */
  private async getNetworkStats(): Promise<
    Record<string, { total: number; posted: number; failed: number }>
  > {
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const result: Record<string, { total: number; posted: number; failed: number }> = {};

    for (const network of networks) {
      const [total, posted, failed] = await Promise.all([
        this.prisma.post.count({ where: { network } }),
        this.prisma.post.count({ where: { network, status: PostStatus.POSTED } }),
        this.prisma.post.count({ where: { network, status: PostStatus.FAILED } }),
      ]);
      result[network] = { total, posted, failed };
    }

    return result;
  }

  /**
   * Get daily posting stats for the last N days.
   */
  private async getDailyStats(
    days: number,
  ): Promise<{ date: string; posted: number; failed: number }[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const posts = await this.prisma.post.findMany({
      where: {
        status: { in: [PostStatus.POSTED, PostStatus.FAILED] },
        OR: [
          { status: PostStatus.POSTED, postedAt: { gte: startDate } },
          { status: PostStatus.FAILED, createdAt: { gte: startDate } },
        ],
      },
      select: {
        status: true,
        postedAt: true,
        createdAt: true,
      },
    });

    // Group by date
    const byDate = new Map<string, { posted: number; failed: number }>();

    for (const post of posts) {
      // 2.8.6: POSTED uses `postedAt`; FAILED falls back to `createdAt` (no failedAt column).
      const eventDate = post.status === PostStatus.POSTED ? post.postedAt : post.createdAt;
      if (!eventDate) continue;
      const dateStr = eventDate.toISOString().split("T")[0]!;
      const entry = byDate.get(dateStr) ?? { posted: 0, failed: 0 };
      if (post.status === PostStatus.POSTED) entry.posted++;
      if (post.status === PostStatus.FAILED) entry.failed++;
      byDate.set(dateStr, entry);
    }

    // Fill in missing days with zeros
    const result: { date: string; posted: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0]!;
      const entry = byDate.get(dateStr) ?? { posted: 0, failed: 0 };
      result.push({ date: dateStr, ...entry });
    }

    return result;
  }

  /**
   * Get top performing posts (by engagement if available, otherwise by recency).
   */
  async getTopPosts(limit = 10): Promise<
    {
      id: string;
      network: string;
      content: string;
      postedAt: Date | null;
      postUrl: string | null;
    }[]
  > {
    // 2.8.7: Sort by engagement (likes + comments + shares) using the latest metrics record.
    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.POSTED },
      take: limit * 5,
      select: {
        id: true,
        network: true,
        content: true,
        postedAt: true,
        postUrl: true,
        metrics: {
          orderBy: { collectedAt: "desc" },
          take: 1,
          select: { likes: true, comments: true, shares: true },
        },
      },
    });

    const scored = posts.map((post) => {
      const latest = post.metrics[0];
      const engagement = (latest?.likes ?? 0) + (latest?.comments ?? 0) + (latest?.shares ?? 0);
      return { post, engagement };
    });

    const topScored = scored
      .sort((a, b) => {
        if (b.engagement !== a.engagement) return b.engagement - a.engagement;
        return (b.post.postedAt?.getTime() ?? 0) - (a.post.postedAt?.getTime() ?? 0);
      })
      .slice(0, limit);

    return topScored.map(({ post }) => ({
      id: post.id,
      network: post.network,
      content: post.content,
      postedAt: post.postedAt,
      postUrl: post.postUrl,
    }));
  }

  /**
   * Generate a full report for a date range (7d, 30d, 90d).
   * Returns the shape expected by the Reports UI.
   *
   * The Post table is consumed in cursor-paginated batches to avoid loading
   * the entire date range into memory at once.
   */
  async generateReport(range: string): Promise<{
    summary: {
      totalPosts: number;
      posted: number;
      failed: number;
      rejected: number;
      successRate: number;
      avgQualityScore: number | null;
    };
    byNetwork: Record<
      string,
      { total: number; posted: number; failed: number; successRate: number }
    >;
    byTrigger: Record<string, number>;
    dailyStats: { date: string; posted: number; failed: number }[];
    topPosts: {
      id: string;
      network: string;
      content: string;
      postedAt: string | null;
      qualityScore?: number;
    }[];
    autoApproveStats: {
      autoApproved: number;
      humanReview: number;
      rejected: number;
      avgScore: number;
    };
    judgeStats: JudgeStats;
  }> {
    const days = parseInt(range, 10) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const BATCH_SIZE = 500;

    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const byNetwork: Record<
      string,
      { total: number; posted: number; failed: number; successRate: number }
    > = {};
    for (const network of networks) {
      byNetwork[network] = { total: 0, posted: 0, failed: 0, successRate: 0 };
    }

    const byTrigger: Record<string, number> = {};
    const dailyStats = this.buildDailyStats(days);
    let autoApproved = 0;
    let humanReview = 0;
    let rejectedCount = 0;
    let autoApproveScoreSum = 0;
    let autoApproveScoreCount = 0;
    let qualityScoreSum = 0;
    let qualityScoreCount = 0;
    let topPosts: {
      id: string;
      network: string;
      content: string;
      postedAt: Date | null;
      qualityScore: number | null;
    }[] = [];
    let totalPosts = 0;
    let posted = 0;
    let failed = 0;
    let rejected = 0;

    const judgeOverallSums: Record<JudgeDimension, { sum: number; count: number }> = {
      antiAiTone: { sum: 0, count: 0 },
      hookStrength: { sum: 0, count: 0 },
      factualAccuracy: { sum: 0, count: 0 },
      characterLimit: { sum: 0, count: 0 },
    };
    const judgeByDecisionSums: Record<
      string,
      Record<JudgeDimension, { sum: number; count: number }>
    > = {};
    let judgePostsCount = 0;
    const judgeByDecisionPostsCount: Record<string, number> = {};

    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const batch = await this.prisma.post.findMany({
        where: { createdAt: { gte: startDate } },
        include: { generationRun: { select: { triggeredBy: true } } },
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
      });

      if (batch.length === 0) break;

      for (const post of batch) {
        totalPosts++;
        const network = post.network;
        const meta = (post.llmMetadata as Record<string, unknown> | null) ?? {};
        const decision = meta?.autoApproveDecision as string | undefined;
        const qualityScore = typeof meta?.qualityScore === "number" ? meta.qualityScore : null;
        const networkStats = byNetwork[network];

        if (networkStats) {
          networkStats.total++;
          if (post.status === PostStatus.POSTED) {
            networkStats.posted++;
          } else if (post.status === PostStatus.FAILED) {
            networkStats.failed++;
          }
        }

        if (post.status === PostStatus.POSTED) {
          posted++;
        } else if (post.status === PostStatus.FAILED) {
          failed++;
        } else if (post.status === PostStatus.REJECTED) {
          rejected++;
        }

        if (decision === "AUTO_APPROVE") {
          autoApproved++;
          if (qualityScore !== null) {
            autoApproveScoreSum += qualityScore;
            autoApproveScoreCount++;
          }
        } else if (decision === "HUMAN_REVIEW") {
          humanReview++;
        } else if (decision === "REJECT") {
          rejectedCount++;
        }

        if (qualityScore !== null) {
          qualityScoreSum += qualityScore;
          qualityScoreCount++;
        }

        const judgeScores = this.extractJudgeScores(meta);
        if (judgeScores) {
          judgePostsCount++;
          const decisionKey = decision ?? "UNKNOWN";
          judgeByDecisionPostsCount[decisionKey] =
            (judgeByDecisionPostsCount[decisionKey] ?? 0) + 1;

          const dimensions: JudgeDimension[] = [
            "antiAiTone",
            "hookStrength",
            "factualAccuracy",
            "characterLimit",
          ];
          for (const dim of dimensions) {
            const val = judgeScores[dim];
            if (typeof val === "number" && Number.isFinite(val)) {
              judgeOverallSums[dim].sum += val;
              judgeOverallSums[dim].count++;

              const byDecision = (judgeByDecisionSums[decisionKey] ??= {
                antiAiTone: { sum: 0, count: 0 },
                hookStrength: { sum: 0, count: 0 },
                factualAccuracy: { sum: 0, count: 0 },
                characterLimit: { sum: 0, count: 0 },
              });
              byDecision[dim].sum += val;
              byDecision[dim].count++;
            }
          }
        }

        const trigger = post.generationRun?.triggeredBy ?? "UNKNOWN";
        byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;

        if (post.status === PostStatus.POSTED && post.postedAt && post.postedAt >= startDate) {
          topPosts.push({
            id: post.id,
            network: post.network,
            content: post.content,
            postedAt: post.postedAt,
            qualityScore,
          });
          if (topPosts.length > 10) {
            topPosts = topPosts
              .filter((p) => p.qualityScore != null && p.qualityScore >= 0)
              .sort(
                (a, b) =>
                  (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
                  (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0),
              )
              .slice(0, 10);
          }
        }

        // Daily stats
        const eventDate = post.status === PostStatus.POSTED ? post.postedAt : post.createdAt;
        if (eventDate) {
          const dateStr = eventDate.toISOString().split("T")[0]!;
          const day = dailyStats.find((d) => d.date === dateStr);
          if (day) {
            if (post.status === PostStatus.POSTED) day.posted++;
            if (post.status === PostStatus.FAILED) day.failed++;
          }
        }
      }

      cursor = batch[batch.length - 1]!.id;
      hasMore = batch.length === BATCH_SIZE;
    }

    for (const network of networks) {
      const s = byNetwork[network];
      if (!s) continue;
      s.successRate = s.total > 0 ? Math.round((s.posted / s.total) * 1000) / 10 : 0;
    }

    topPosts = topPosts
      .filter((p) => p.qualityScore != null && p.qualityScore >= 0)
      .sort(
        (a, b) =>
          (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
          (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0),
      )
      .slice(0, 10);

    const successRate = totalPosts > 0 ? Math.round((posted / totalPosts) * 1000) / 10 : 0;

    const makeJudgeAverages = (
      sums: Record<JudgeDimension, { sum: number; count: number }>,
      count: number,
    ): JudgeScoreAverages => ({
      antiAiTone:
        sums.antiAiTone.count > 0
          ? Math.round((sums.antiAiTone.sum / sums.antiAiTone.count) * 100) / 100
          : null,
      hookStrength:
        sums.hookStrength.count > 0
          ? Math.round((sums.hookStrength.sum / sums.hookStrength.count) * 100) / 100
          : null,
      factualAccuracy:
        sums.factualAccuracy.count > 0
          ? Math.round((sums.factualAccuracy.sum / sums.factualAccuracy.count) * 100) / 100
          : null,
      characterLimit:
        sums.characterLimit.count > 0
          ? Math.round((sums.characterLimit.sum / sums.characterLimit.count) * 100) / 100
          : null,
      count,
    });

    const judgeStats: JudgeStats = {
      overall: makeJudgeAverages(judgeOverallSums, judgePostsCount),
      byDecision: Object.fromEntries(
        Object.entries(judgeByDecisionSums).map(([decision, sums]) => [
          decision,
          makeJudgeAverages(sums, judgeByDecisionPostsCount[decision] ?? 0),
        ]),
      ),
    };

    return {
      summary: {
        totalPosts,
        posted,
        failed,
        rejected,
        successRate,
        avgQualityScore:
          qualityScoreCount > 0
            ? Math.round((qualityScoreSum / qualityScoreCount) * 10) / 10
            : null,
      },
      byNetwork,
      byTrigger,
      dailyStats,
      topPosts: topPosts.map((p) => ({
        id: p.id,
        network: p.network,
        content: p.content,
        postedAt: p.postedAt?.toISOString() ?? null,
        qualityScore: p.qualityScore ?? undefined,
      })),
      autoApproveStats: {
        autoApproved,
        humanReview,
        rejected: rejectedCount,
        avgScore:
          autoApproveScoreCount > 0
            ? Math.round((autoApproveScoreSum / autoApproveScoreCount) * 10) / 10
            : 0,
      },
      judgeStats,
    };
  }

  /**
   * Get autonomous decision stats.
   *
   * Uses aggregate SQL instead of loading every Post row into memory.
   */
  async getAutonomousStats(): Promise<{
    totalGenerated: number;
    autoApproved: number;
    rejected: number;
    humanReview: number;
    avgQualityScore: number;
    qualityDistribution: { score: number; count: number }[];
    rejectReasons: { reason: string; count: number }[];
    judgeStats: JudgeStats;
  }> {
    const totalGenerated = await this.prisma.post.count();

    const [
      decisionRows,
      avgRows,
      distributionRows,
      reasonRows,
      judgeOverallRows,
      judgeByDecisionRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<Array<{ autoApproved: number; rejected: number; humanReview: number }>>(
        Prisma.sql`
          SELECT
            COUNT(*) FILTER (WHERE "llmMetadata"->>'autoApproveDecision' = 'AUTO_APPROVE')::int as "autoApproved",
            COUNT(*) FILTER (WHERE "llmMetadata"->>'autoApproveDecision' = 'REJECT')::int as "rejected",
            COUNT(*) FILTER (WHERE "llmMetadata"->>'autoApproveDecision' = 'HUMAN_REVIEW')::int as "humanReview"
          FROM "Post"
        `,
      ),
      this.prisma.$queryRaw<Array<{ avgScore: string | null }>>(
        Prisma.sql`
          SELECT AVG(("llmMetadata"->>'qualityScore')::numeric) as "avgScore"
          FROM "Post"
          WHERE "llmMetadata" ? 'qualityScore' AND "llmMetadata"->>'qualityScore' IS NOT NULL
        `,
      ),
      this.prisma.$queryRaw<Array<{ score: string; count: number }>>(
        Prisma.sql`
          SELECT ROUND(("llmMetadata"->>'qualityScore')::numeric) as "score", COUNT(*)::int as "count"
          FROM "Post"
          WHERE "llmMetadata" ? 'qualityScore' AND "llmMetadata"->>'qualityScore' IS NOT NULL
          GROUP BY ROUND(("llmMetadata"->>'qualityScore')::numeric)
          ORDER BY "score" ASC
        `,
      ),
      this.prisma.$queryRaw<Array<{ reason: string; count: number }>>(
        Prisma.sql`
          SELECT "llmMetadata"->>'autoApproveReason' as "reason", COUNT(*)::int as "count"
          FROM "Post"
          WHERE "llmMetadata" ? 'autoApproveReason' AND "llmMetadata"->>'autoApproveReason' IS NOT NULL
          GROUP BY "llmMetadata"->>'autoApproveReason'
          ORDER BY "count" DESC
        `,
      ),
      this.prisma.$queryRaw<
        Array<{
          antiAiTone: number | null;
          hookStrength: number | null;
          factualAccuracy: number | null;
          characterLimit: number | null;
          count: number;
        }>
      >(
        Prisma.sql`
          SELECT
            AVG(("llmMetadata"->'judgeScores'->>'anti_ai_tone')::numeric) as "antiAiTone",
            AVG(("llmMetadata"->'judgeScores'->>'hook_strength')::numeric) as "hookStrength",
            AVG(("llmMetadata"->'judgeScores'->>'factual_accuracy')::numeric) as "factualAccuracy",
            AVG(("llmMetadata"->'judgeScores'->>'character_limit')::numeric) as "characterLimit",
            COUNT(*)::int as "count"
          FROM "Post"
          WHERE "llmMetadata" ? 'judgeScores'
        `,
      ),
      this.prisma.$queryRaw<
        Array<{
          decision: string;
          antiAiTone: number | null;
          hookStrength: number | null;
          factualAccuracy: number | null;
          characterLimit: number | null;
          count: number;
        }>
      >(
        Prisma.sql`
          SELECT
            COALESCE("llmMetadata"->>'autoApproveDecision', 'UNKNOWN') as "decision",
            AVG(("llmMetadata"->'judgeScores'->>'anti_ai_tone')::numeric) as "antiAiTone",
            AVG(("llmMetadata"->'judgeScores'->>'hook_strength')::numeric) as "hookStrength",
            AVG(("llmMetadata"->'judgeScores'->>'factual_accuracy')::numeric) as "factualAccuracy",
            AVG(("llmMetadata"->'judgeScores'->>'character_limit')::numeric) as "characterLimit",
            COUNT(*)::int as "count"
          FROM "Post"
          WHERE "llmMetadata" ? 'judgeScores'
          GROUP BY COALESCE("llmMetadata"->>'autoApproveDecision', 'UNKNOWN')
        `,
      ),
    ]);

    const decision = decisionRows[0] ?? { autoApproved: 0, rejected: 0, humanReview: 0 };

    const avgScore = avgRows[0]?.avgScore != null ? Number(avgRows[0].avgScore) : 0;
    const avgQualityScore = avgScore ? Math.round(avgScore * 10) / 10 : 0;

    const judgeOverall = judgeOverallRows[0] ?? {
      antiAiTone: null,
      hookStrength: null,
      factualAccuracy: null,
      characterLimit: null,
      count: 0,
    };

    const byDecision: Record<string, JudgeScoreAverages> = {};
    for (const row of judgeByDecisionRows ?? []) {
      byDecision[row.decision] = {
        antiAiTone: row.antiAiTone ?? null,
        hookStrength: row.hookStrength ?? null,
        factualAccuracy: row.factualAccuracy ?? null,
        characterLimit: row.characterLimit ?? null,
        count: row.count,
      };
    }

    return {
      totalGenerated,
      autoApproved: decision.autoApproved,
      rejected: decision.rejected,
      humanReview: decision.humanReview,
      avgQualityScore,
      qualityDistribution: (distributionRows ?? [])
        .map((row) => ({ score: Number(row.score), count: row.count }))
        .sort((a, b) => a.score - b.score),
      rejectReasons: (reasonRows ?? [])
        .map((row) => ({ reason: row.reason, count: row.count }))
        .sort((a, b) => b.count - a.count),
      judgeStats: {
        overall: {
          antiAiTone: judgeOverall.antiAiTone ?? null,
          hookStrength: judgeOverall.hookStrength ?? null,
          factualAccuracy: judgeOverall.factualAccuracy ?? null,
          characterLimit: judgeOverall.characterLimit ?? null,
          count: judgeOverall.count,
        },
        byDecision,
      },
    };
  }

  /**
   * Extract numeric judge dimensions from Post.llmMetadata (JSON).
   * Ignores string reason fields and non-numeric / missing values.
   */
  private extractJudgeScores(
    meta: Record<string, unknown>,
  ): Partial<Record<JudgeDimension, number>> | null {
    const raw = meta?.judgeScores;
    if (typeof raw !== "object" || raw === null) return null;
    const v = raw as Record<string, unknown>;

    const scores: Partial<Record<keyof JudgeScoreAverages, number>> = {};
    const dimensions: [keyof JudgeScoreAverages, string][] = [
      ["antiAiTone", "anti_ai_tone"],
      ["hookStrength", "hook_strength"],
      ["factualAccuracy", "factual_accuracy"],
      ["characterLimit", "character_limit"],
    ];
    for (const [key, jsonKey] of dimensions) {
      const val = v[jsonKey];
      if (typeof val === "number" && Number.isFinite(val)) {
        scores[key] = val;
      }
    }
    return Object.keys(scores).length > 0 ? scores : null;
  }

  private buildDailyStats(days: number): { date: string; posted: number; failed: number }[] {
    const result: { date: string; posted: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      result.push({ date: d.toISOString().split("T")[0]!, posted: 0, failed: 0 });
    }
    return result;
  }
}
