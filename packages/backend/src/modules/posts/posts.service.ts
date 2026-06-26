import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus, type SocialNetwork, type Prisma } from '@prisma/client';
import type { PostQueryDto, UpdatePostStatusDto } from '../../domain/dtos';

/**
 * Posts service — CRUD + status transitions for Post entities.
 * Status flow: DRAFT → APPROVED → POSTING → POSTED | FAILED
 *                    → REJECTED (operator rejects draft)
 */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findMany(query: PostQueryDto) {
    const where = {
      ...(query.status && { status: query.status }),
      ...(query.network && { network: query.network }),
      ...(query.accountId && { accountId: query.accountId }),
    };

    const [posts, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        include: { account: true, thread: true },
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      posts,
      total,
      limit: query.limit,
      offset: query.offset,
      page: Math.floor(query.offset / query.limit) + 1,
      pageSize: query.limit,
      hasMore: query.offset + query.limit < total,
    };
  }

  async findById(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: { account: true, thread: true, generationRun: true },
    });
    if (!post) {
      throw new NotFoundException(`Post ${id} not found`);
    }
    return post;
  }

  async findDrafts(network?: SocialNetwork) {
    return this.prisma.post.findMany({
      where: {
        status: PostStatus.DRAFT,
        ...(network && { network }),
      },
      orderBy: { createdAt: 'desc' },
      include: { account: true },
    });
  }

  async create(data: {
    accountId: string;
    network: SocialNetwork;
    content: string;
    threadId?: string;
    threadPosition?: number;
    generationRunId?: string;
    sourceRef?: Prisma.InputJsonValue;
    llmMetadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.post.create({ data });
  }

  async updateStatus(id: string, dto: UpdatePostStatusDto) {
    const post = await this.findById(id);

    const updateData: Prisma.PostUpdateInput = {
      status: dto.status,
    };
    if (dto.postUrl) updateData.postUrl = dto.postUrl;
    if (dto.errorMessage) updateData.errorMessage = dto.errorMessage;
    if (dto.status === PostStatus.APPROVED) updateData.approvedAt = new Date();
    if (dto.status === PostStatus.POSTED) updateData.postedAt = new Date();

    this.logger.log(`Post ${id}: ${post.status} → ${dto.status}`);

    return this.prisma.post.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * D2: Approve a post — optionally with edited content.
   * Operator can edit the post text before approving.
   */
  async approve(id: string, editedContent?: string) {
    const post = await this.findById(id);

    const updateData: Prisma.PostUpdateInput = {
      status: PostStatus.APPROVED,
      approvedAt: new Date(),
    };

    if (editedContent && editedContent.trim().length > 0) {
      updateData.content = editedContent.trim();
      this.logger.log(`Post ${id}: approved with edited content (${editedContent.length} chars)`);
    } else {
      this.logger.log(`Post ${id}: approved (no edits) — ${post.status} → APPROVED`);
    }

    return this.prisma.post.update({
      where: { id },
      data: updateData,
    });
  }

  async findBySourceAndNetwork(sourcePath: string, network: SocialNetwork, sinceDays = 14) {
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);

    const posts = await this.prisma.post.findMany({
      where: {
        network,
        createdAt: { gte: since },
      },
    });

    // Filter by sourceRef.path in code (Prisma JSON filtering is limited)
    return posts.filter((p) => {
      if (!p.sourceRef || typeof p.sourceRef !== 'object') return false;
      const ref = p.sourceRef as Record<string, unknown>;
      return ref['path'] === sourcePath;
    });
  }
}
