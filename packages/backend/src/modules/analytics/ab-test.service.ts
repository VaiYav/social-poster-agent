/**
 * A/B Test Service — aggregates real-world outcomes of PostVariant rows.
 *
 * Groups posted variants by topic + network, computes per-variant averages,
 * and returns a simple winner (highest average engagement). This is the
 * backend for the `/analytics/ab-tests` dashboard endpoint.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus } from '@prisma/client';
import type { ABTest, ABTestQuery, ABTestVariant } from '@spa/shared';
import {
  type VariantStatsRow,
  computeVariantStats,
  extractTopic,
  pickWinner,
} from '../content-enhancements/ab-test.utils.js';

@Injectable()
export class ABTestService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get A/B test results grouped by topic + network.
   */
  async getAbTests(query: ABTestQuery): Promise<ABTest[]> {
    const since = new Date();
    since.setDate(since.getDate() - query.days);

    const rows = await this.prisma.postVariant.findMany({
      where: {
        selected: true,
        label: { in: ['a', 'b'] },
        post: {
          status: PostStatus.POSTED,
          postedAt: { gte: since },
          ...(query.network ? { network: query.network } : {}),
        },
      },
      include: {
        post: {
          select: {
            id: true,
            network: true,
            postedAt: true,
            postUrl: true,
            sourceRef: true,
          },
        },
      },
      orderBy: { post: { postedAt: 'desc' } },
    });

    const typedRows = rows as VariantStatsRow[];

    // Group by topic + network. Topic is read from sourceRef JSON.
    const groups = new Map<string, { topic: string; network: string; rows: VariantStatsRow[] }>();

    for (const row of typedRows) {
      const topic = extractTopic(row);
      const key = `${topic}::${row.post.network}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(key, { topic, network: row.post.network, rows: [row] });
      }
    }

    const results: ABTest[] = [];

    for (const { topic, network, rows } of groups.values()) {
      const byLabel = new Map<string, VariantStatsRow[]>();
      for (const row of rows) {
        const list = byLabel.get(row.label) ?? [];
        list.push(row);
        byLabel.set(row.label, list);
      }

      const variants: ABTestVariant[] = [];
      for (const [label, labelRows] of byLabel) {
        variants.push(computeVariantStats(label, labelRows));
      }

      const winner = pickWinner(variants, query.minSampleSize ?? 0);

      const firstPostedAt = rows.reduce(
        (min, r) => (r.post.postedAt && r.post.postedAt < min ? r.post.postedAt : min),
        rows[0]?.post.postedAt ?? new Date(),
      );
      const lastPostedAt = rows.reduce(
        (max, r) => (r.post.postedAt && r.post.postedAt > max ? r.post.postedAt : max),
        rows[0]?.post.postedAt ?? new Date(),
      );

      results.push({
        testId: `${topic}::${network}`,
        topic,
        network,
        totalPosts: rows.length,
        variants,
        winner,
        firstPostedAt: firstPostedAt?.toISOString() ?? null,
        lastPostedAt: lastPostedAt?.toISOString() ?? null,
      });
    }

    // Sort by most recent activity.
    return results.sort((a, b) => {
      const aTime = a.lastPostedAt ? new Date(a.lastPostedAt).getTime() : 0;
      const bTime = b.lastPostedAt ? new Date(b.lastPostedAt).getTime() : 0;
      return bTime - aTime;
    });
  }
}
