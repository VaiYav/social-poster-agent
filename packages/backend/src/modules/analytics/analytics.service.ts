/**
 * Sprint O / F6: Analytics Service — aggregate metrics for dashboard.
 *
 * Computes posting stats, success rates, network breakdowns, and time-series
 * data for the analytics dashboard. All queries are read-only against Prisma.
 */
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  PostStatus,
  SocialNetwork,
  GenerationTrigger,
  Prisma,
} from "../../generated/prisma/client.js";
import type { JudgeScores } from "@spa/shared";
import { computeBinaryCalibration } from "../evaluation/calibration-metrics.js";

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

export interface CostAnalytics {
  from: string;
  to: string;
  events: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  cacheHits: number;
  byAccount: Record<string, { costUsd: number; events: number; tokens: number }>;
  byProvider: Record<string, { costUsd: number; events: number; tokens: number }>;
  daily: Array<{ date: string; costUsd: number; events: number }>;
}

export interface ReviewCalibrationReport {
  windowDays: number;
  totalDecisions: number;
  byDecision: Record<string, number>;
  syncStatus: Record<string, number>;
  averageEditDistance: number | null;
  evidenceCoverage: {
    reasonCodes: number;
    rubric: number;
    trace: number;
    contentHashes: number;
  };
  calibration: {
    pairedSamples: number;
    agreementRate: number | null;
    kappa: number | null;
    precision: number | null;
    recall: number | null;
    tpr: number | null;
    tnr: number | null;
    status: "INSUFFICIENT_SAMPLE" | "READY_FOR_REVIEW";
  };
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

  async getCostAnalytics(query: {
    accountId?: string;
    from?: Date;
    to?: Date;
  }): Promise<CostAnalytics> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 7 * 86_400_000);
    const rows = await this.prisma.llmUsageEvent.findMany({
      where: {
        accountId: query.accountId,
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: "asc" },
      take: 50_000,
    });
    const byAccount: CostAnalytics["byAccount"] = {};
    const byProvider: CostAnalytics["byProvider"] = {};
    const daily = new Map<string, { costUsd: number; events: number }>();
    let totalCostUsd = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let cacheHits = 0;
    for (const row of rows) {
      const costUsd = Number(row.costUsd) || 0;
      const tokens = row.tokensIn + row.tokensOut;
      totalCostUsd += costUsd;
      totalTokensIn += row.tokensIn;
      totalTokensOut += row.tokensOut;
      if (row.cached) cacheHits++;
      const accountKey = row.accountId ?? "unattributed";
      const account = (byAccount[accountKey] ??= { costUsd: 0, events: 0, tokens: 0 });
      account.costUsd += costUsd;
      account.events++;
      account.tokens += tokens;
      const provider = (byProvider[row.provider] ??= { costUsd: 0, events: 0, tokens: 0 });
      provider.costUsd += costUsd;
      provider.events++;
      provider.tokens += tokens;
      const day = row.createdAt.toISOString().slice(0, 10);
      const dailyEntry = daily.get(day) ?? { costUsd: 0, events: 0 };
      dailyEntry.costUsd += costUsd;
      dailyEntry.events++;
      daily.set(day, dailyEntry);
    }
    const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      events: rows.length,
      totalCostUsd: round(totalCostUsd),
      totalTokensIn,
      totalTokensOut,
      cacheHits,
      byAccount: Object.fromEntries(
        Object.entries(byAccount).map(([key, value]) => [
          key,
          { ...value, costUsd: round(value.costUsd) },
        ]),
      ),
      byProvider: Object.fromEntries(
        Object.entries(byProvider).map(([key, value]) => [
          key,
          { ...value, costUsd: round(value.costUsd) },
        ]),
      ),
      daily: [...daily.entries()].map(([date, value]) => ({
        ...value,
        date,
        costUsd: round(value.costUsd),
      })),
    };
  }

  /**
   * EVAL-701: read-only review truth, sync health and preliminary judge-human
   * calibration. This is diagnostic evidence, not an autonomous promotion gate.
   */
  async getReviewCalibration(days = 30): Promise<ReviewCalibrationReport> {
    const windowDays = Math.min(365, Math.max(1, Math.trunc(days) || 30));
    const startDate = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await this.prisma.postReviewDecision.findMany({
      where: { createdAt: { gte: startDate } },
      select: {
        decision: true,
        reasonCodes: true,
        rubric: true,
        syncStatus: true,
        normalizedEditDistance: true,
        originalContentHash: true,
        finalContentHash: true,
        langfuseTraceId: true,
        langfuseObservationId: true,
        post: { select: { judgeScores: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10_000,
    });

    const byDecision: Record<string, number> = {};
    const syncStatus: Record<string, number> = {};
    let editSum = 0;
    let editCount = 0;
    let reasonCount = 0;
    let rubricCount = 0;
    let traceCount = 0;
    let hashCount = 0;
    let pairedSamples = 0;
    const calibrationPairs: Array<{ judgePass: boolean; humanPass: boolean }> = [];

    for (const row of rows) {
      byDecision[row.decision] = (byDecision[row.decision] ?? 0) + 1;
      syncStatus[row.syncStatus] = (syncStatus[row.syncStatus] ?? 0) + 1;

      const reasons = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
      if (reasons.length > 0) reasonCount++;
      if (row.rubric && typeof row.rubric === "object" && !Array.isArray(row.rubric)) {
        rubricCount++;
      }
      if (row.langfuseTraceId || row.langfuseObservationId) traceCount++;
      if (row.originalContentHash && (row.finalContentHash || row.decision === "REJECT")) {
        hashCount++;
      }
      if (typeof row.normalizedEditDistance === "number") {
        editSum += row.normalizedEditDistance;
        editCount++;
      }

      const judge = parseJudgeScores(row.post?.judgeScores);
      const rubric = parseReviewRubric(row.rubric);
      if (judge && rubric) {
        const pairs: Array<[number, number]> = [
          [judge.anti_ai_tone, rubric.humanVoice],
          [judge.hook_strength, rubric.hookStrength],
          [judge.factual_accuracy, rubric.factualSupport],
          [judge.character_limit, rubric.platformFit],
        ];
        for (const [judgeValue, humanValue] of pairs) {
          if (humanValue === 1) continue;
          pairedSamples++;
          calibrationPairs.push({ judgePass: judgeValue >= 0.7, humanPass: humanValue === 2 });
        }
      }
    }

    const calibrationMetrics = computeBinaryCalibration(calibrationPairs);

    return {
      windowDays,
      totalDecisions: rows.length,
      byDecision,
      syncStatus,
      averageEditDistance: editCount > 0 ? round(editSum / editCount, 3) : null,
      evidenceCoverage: {
        reasonCodes: coverage(reasonCount, rows.length),
        rubric: coverage(rubricCount, rows.length),
        trace: coverage(traceCount, rows.length),
        contentHashes: coverage(hashCount, rows.length),
      },
      calibration: {
        pairedSamples,
        agreementRate: calibrationMetrics.accuracy,
        kappa: calibrationMetrics.kappa,
        precision: calibrationMetrics.precision,
        recall: calibrationMetrics.recall,
        tpr: calibrationMetrics.tpr,
        tnr: calibrationMetrics.tnr,
        status: pairedSamples >= 30 ? "READY_FOR_REVIEW" : "INSUFFICIENT_SAMPLE",
      },
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

type CalibrationJudgeScores = {
  anti_ai_tone: number;
  hook_strength: number;
  factual_accuracy: number;
  character_limit: number;
};

type CalibrationRubric = {
  humanVoice: number;
  hookStrength: number;
  factualSupport: number;
  platformFit: number;
};

function parseJudgeScores(value: unknown): CalibrationJudgeScores | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["anti_ai_tone", "hook_strength", "factual_accuracy", "character_limit"] as const;
  if (!keys.every((key) => typeof raw[key] === "number" && Number.isFinite(raw[key]))) {
    return null;
  }
  return {
    anti_ai_tone: raw.anti_ai_tone as number,
    hook_strength: raw.hook_strength as number,
    factual_accuracy: raw.factual_accuracy as number,
    character_limit: raw.character_limit as number,
  };
}

function parseReviewRubric(value: unknown): CalibrationRubric | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["humanVoice", "hookStrength", "factualSupport", "platformFit"] as const;
  if (
    !keys.every(
      (key) =>
        typeof raw[key] === "number" &&
        Number.isInteger(raw[key]) &&
        (raw[key] as number) >= 0 &&
        (raw[key] as number) <= 2,
    )
  ) {
    return null;
  }
  return {
    humanVoice: raw.humanVoice as number,
    hookStrength: raw.hookStrength as number,
    factualSupport: raw.factualSupport as number,
    platformFit: raw.platformFit as number,
  };
}

function coverage(count: number, total: number): number {
  return total > 0 ? round(count / total, 3) : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
