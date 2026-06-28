/**
 * Sprint O / F6: Analytics Service — aggregate metrics for dashboard.
 *
 * Computes posting stats, success rates, network breakdowns, and time-series
 * data for the analytics dashboard. All queries are read-only against Prisma.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus, SocialNetwork } from '@prisma/client';

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
  private async getNetworkStats(): Promise<Record<string, { total: number; posted: number; failed: number }>> {
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
  private async getDailyStats(days: number): Promise<{ date: string; posted: number; failed: number }[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const posts = await this.prisma.post.findMany({
      where: {
        createdAt: { gte: startDate },
        status: { in: [PostStatus.POSTED, PostStatus.FAILED] },
      },
      select: {
        status: true,
        createdAt: true,
      },
    });

    // Group by date
    const byDate = new Map<string, { posted: number; failed: number }>();

    for (const post of posts) {
      const dateStr = post.createdAt.toISOString().split('T')[0]!;
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
      const dateStr = d.toISOString().split('T')[0]!;
      const entry = byDate.get(dateStr) ?? { posted: 0, failed: 0 };
      result.push({ date: dateStr, ...entry });
    }

    return result;
  }

  /**
   * Get top performing posts (by engagement if available, otherwise by recency).
   */
  async getTopPosts(limit = 10): Promise<{ id: string; network: string; content: string; postedAt: Date | null; postUrl: string | null }[]> {
    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.POSTED },
      orderBy: { postedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        network: true,
        content: true,
        postedAt: true,
        postUrl: true,
      },
    });

    return posts;
  }
}
