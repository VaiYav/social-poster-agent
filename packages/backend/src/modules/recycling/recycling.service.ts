/**
 * Sprint O / F13: Content Recycling Service — refresh old top-performing posts.
 *
 * Identifies posts that performed well (posted >30 days ago) and creates
 * new draft variants with updated angles/hooks. Avoids exact duplicates via SimHash.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus } from '@prisma/client';
import { simhash, hammingDistance } from '../generation/simhash.js';

@Injectable()
export class RecyclingService {
  private readonly logger = new Logger(RecyclingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find posts eligible for recycling — posted >30 days ago, not yet recycled.
   */
  async findRecyclablePosts(limit = 10): Promise<{ id: string; network: string; content: string; postedAt: Date | null }[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.post.findMany({
      where: {
        status: PostStatus.POSTED,
        postedAt: { lt: thirtyDaysAgo },
        // Check llmMetadata for recycled flag
        llmMetadata: { path: ['recycled'], not: true },
      },
      orderBy: { postedAt: 'desc' },
      take: limit * 2, // get more than needed, filter by simhash
      select: {
        id: true,
        network: true,
        content: true,
        postedAt: true,
        accountId: true,
        sourceRef: true,
      },
    });

    // Filter out posts that are too similar to recent posts
    const recentHashes = await this.loadRecentHashes();
    const recyclable = posts.filter((post) => {
      const hash = simhash(post.content);
      return !recentHashes.some((existing) => hammingDistance(hash, existing) <= 5);
    });

    return recyclable.slice(0, limit);
  }

  /**
   * Create a recycled draft from an old post.
   * The draft will be picked up by the generation pipeline for re-writing.
   */
  async recyclePost(postId: string): Promise<{ id: string; status: string } | null> {
    const original = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!original || original.status !== PostStatus.POSTED) {
      return null;
    }

    // Mark original as recycled
    const metadata = (original.llmMetadata as Record<string, unknown> | null) ?? {};
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        llmMetadata: { ...metadata, recycled: true, recycledAt: new Date().toISOString() },
      },
    });

    // Create a new draft with reference to the original
    const draft = await this.prisma.post.create({
      data: {
        accountId: original.accountId,
        network: original.network,
        content: original.content, // Will be re-written by generation pipeline
        status: PostStatus.DRAFT,
        sourceRef: {
          ...(original.sourceRef as Record<string, unknown> | null),
          recycledFrom: original.id,
        },
        llmMetadata: {
          recycled: true,
          originalPostId: original.id,
          promptVersion: '0.3.0-recycle',
        },
      },
    });

    this.logger.log(`Recycled post ${postId} → new draft ${draft.id}`);
    return { id: draft.id, status: draft.status };
  }

  /**
   * Run recycling for all eligible posts.
   */
  async runRecycling(limit = 5): Promise<{ recycled: number; skipped: number }> {
    this.logger.log(`Running content recycling (limit: ${limit})...`);

    const candidates = await this.findRecyclablePosts(limit);

    let recycled = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        const result = await this.recyclePost(candidate.id);
        if (result) {
          recycled++;
        } else {
          skipped++;
        }
      } catch (err) {
        this.logger.error(`Failed to recycle post ${candidate.id}: ${(err as Error).message}`);
        skipped++;
      }
    }

    this.logger.log(`Recycling complete: ${recycled} recycled, ${skipped} skipped`);
    return { recycled, skipped };
  }

  private async loadRecentHashes(): Promise<string[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentPosts = await this.prisma.post.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      select: { content: true, simhash: true },
      take: 100,
    });

    return recentPosts.map((p) => p.simhash ?? simhash(p.content));
  }
}
