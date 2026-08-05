import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostStatus, type SocialNetwork, type Prisma, type Post } from '@prisma/client';
import type { PostQueryDto, UpdatePostStatusDto } from '../../domain/dtos.js';
import type { PostDraftGeneratedEvent, PostApprovedEvent, PostRejectedEvent } from '@spa/shared';
import { PostEvents } from '../../events/enums/post-events.enum';
import { checkContentLength } from './network-limits.js';
import { simhash } from '../generation/simhash.js';
import { AutoCheckService } from '../autonomy/auto-check.service.js';

/**
 * Extract the source path from a sourceRef JSON object when it is present.
 * Returns `null` when the ref is not an object or has no string `path`.
 */
export function extractSourcePath(sourceRef: unknown): string | null {
  if (!sourceRef || typeof sourceRef !== 'object') return null;
  const path = (sourceRef as Record<string, unknown>)['path'];
  return typeof path === 'string' ? path : null;
}

/**
 * Posts service — CRUD + status transitions for Post entities.
 * Status flow: DRAFT → APPROVED → POSTING → POSTED | FAILED
 *                    → REJECTED (operator rejects draft)
 */
@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Valid status transitions for the post state machine.
   * DRAFT → APPROVED | REJECTED
   * APPROVED → POSTING | FAILED
   * POSTING → POSTED | FAILED | APPROVED
   * Any state → same state (idempotent/no-op)
   */
  private isValidTransition(current: PostStatus, next: PostStatus): boolean {
    if (current === next) return true;
    const allowed: Partial<Record<PostStatus, PostStatus[]>> = {
      [PostStatus.DRAFT]: [PostStatus.APPROVED, PostStatus.REJECTED],
      // APPROVED can also be set directly to POSTED/FAILED by posting/continuations
      // in tests and by the worker setting FAILED before POSTING (disabled network).
      [PostStatus.APPROVED]: [PostStatus.POSTING, PostStatus.POSTED, PostStatus.FAILED],
      [PostStatus.POSTING]: [PostStatus.POSTED, PostStatus.FAILED, PostStatus.APPROVED],
      [PostStatus.POSTED]: [],
      [PostStatus.FAILED]: [],
      [PostStatus.REJECTED]: [],
      // Phase 1+ syndication statuses
      [PostStatus.JUDGED]: [PostStatus.APPROVED, PostStatus.REJECTED],
      [PostStatus.VERIFIED]: [],
    };
    return allowed[current]?.includes(next) ?? false;
  }

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

  async create(
    data: Prisma.PostUncheckedCreateInput,
    // A4: optional transaction client so callers can persist atomically (e.g.
    // thread assembly in GenerationService). Defaults to the non-transactional
    // client, so every existing caller is unaffected.
    client: Prisma.TransactionClient = this.prisma,
    // H1: when persisting inside a transaction, pass `{ emitEvent: false }` and
    // emit DRAFT_GENERATED via emitDraftGenerated() AFTER the tx commits —
    // otherwise the async auto-approve + SSE listeners query a row that is not
    // yet committed (null read / pre-commit race).
    opts: { emitEvent?: boolean } = {},
  ) {
    const post = await client.post.create({
      data: {
        ...data,
        sourcePath: data.sourcePath ?? extractSourcePath(data.sourceRef),
      },
    });
    if (opts.emitEvent !== false) {
      this.emitDraftGenerated(post.id, post.network);
    }
    return post;
  }

  /**
   * Emit DRAFT_GENERATED for a persisted draft. Call this AFTER a transaction
   * commits when create() was used with `{ emitEvent: false }` inside that tx.
   */
  emitDraftGenerated(postId: string, network: SocialNetwork): void {
    this.eventEmitter.emit(PostEvents.DRAFT_GENERATED, { postId, network } satisfies PostDraftGeneratedEvent);
  }

  async updateStatus(id: string, dto: UpdatePostStatusDto) {
    const post = await this.findById(id);

    if (!this.isValidTransition(post.status, dto.status)) {
      throw new BadRequestException(
        `Invalid post status transition: ${post.status} → ${dto.status}`,
      );
    }

    const updateData: Prisma.PostUpdateInput = {
      status: dto.status,
    };
    if (dto.postUrl) updateData.postUrl = dto.postUrl;
    if (dto.errorMessage) updateData.errorMessage = dto.errorMessage;
    if (dto.status === PostStatus.APPROVED) updateData.approvedAt = new Date();
    if (dto.status === PostStatus.POSTED) updateData.postedAt = new Date();

    this.logger.log(`Post ${id}: ${post.status} → ${dto.status}`);

    const updated = await this.prisma.post.update({
      where: { id },
      data: updateData,
    });

    // PostingService publishes SSE directly for POSTING/POSTED/FAILED; we do not
    // emit those domain events here to avoid duplicate post_status SSE events.
    // DRAFT/APPROVED/REJECTED are emitted by create/approve/reject.

    return updated;
  }

  /**
   * D2: Approve a post — optionally with edited content.
   * Operator can edit the post text before approving.
   */
  async approve(id: string, editedContent?: string) {
    const post = await this.findById(id);

    // PO1: only DRAFT posts can be approved — block re-approving POSTED/POSTING/
    // FAILED/REJECTED (would re-post or resurrect a rejected post).
    if (post.status !== PostStatus.DRAFT) {
      throw new ConflictException(
        `Post ${id} cannot be approved from status ${post.status} (only DRAFT)`,
      );
    }

    // PO2: validate effective content length against the network limit, so an over-limit
    // edited (or generated) post can't be approved and then fail at posting time.
    const effectiveContent =
      editedContent && editedContent.trim().length > 0 ? editedContent.trim() : post.content;
    const lengthCheck = checkContentLength(post.network, effectiveContent);
    if (!lengthCheck.ok) {
      throw new BadRequestException(
        `Post ${id} content is ${lengthCheck.length} chars — exceeds the ${post.network} limit of ${lengthCheck.limit}`,
      );
    }

    const updateData: Prisma.PostUpdateInput = {
      status: PostStatus.APPROVED,
      approvedAt: new Date(),
    };

    if (editedContent && editedContent.trim().length > 0) {
      const trimmedContent = editedContent.trim();
      updateData.content = trimmedContent;
      // D2: recompute SimHash for edited content and re-run the content-safety gate
      // (engagement-bait, forbidden phrases, near-duplicate) before approving.
      updateData.simhash = simhash(trimmedContent);
      const autoCheck = new AutoCheckService(this.prisma);
      const checkResult = await autoCheck.check(trimmedContent, post.network, id);
      if (!checkResult.passed) {
        throw new BadRequestException(
          `Post ${id} edited content failed AutoCheck: ${checkResult.rejectionReason}`,
        );
      }
      this.logger.log(`Post ${id}: approved with edited content (${trimmedContent.length} chars)`);
    } else {
      this.logger.log(`Post ${id}: approved (no edits) — ${post.status} → APPROVED`);
    }

    const updated = await this.prisma.post.update({
      where: { id },
      data: updateData,
    });

    this.eventEmitter.emit(PostEvents.APPROVED, { postId: id, network: post.network } satisfies PostApprovedEvent);
    return updated;
  }

  /**
   * PO1: Reject a draft post — only valid from DRAFT (can't resurrect/cancel
   * posts already in the posting pipeline).
   */
  async reject(id: string) {
    const post = await this.findById(id);
    if (post.status !== PostStatus.DRAFT) {
      throw new ConflictException(
        `Post ${id} cannot be rejected from status ${post.status} (only DRAFT)`,
      );
    }
    const updated = await this.prisma.post.update({
      where: { id },
      data: { status: PostStatus.REJECTED },
    });
    this.logger.log(`Post ${id}: ${post.status} → REJECTED`);
    this.eventEmitter.emit(PostEvents.REJECTED, { postId: id, network: post.network } satisfies PostRejectedEvent);
    return updated;
  }

  async findBySourceAndNetwork(sourcePath: string, network: SocialNetwork, sinceDays = 14) {
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);

    return this.prisma.post.findMany({
      where: {
        sourcePath,
        network,
        // Only treat posts that are actually queued or published as "already covered".
        // DRAFT/HUMAN_REVIEW are not yet queued, and FAILED/REJECTED never reached
        // the network — excluding them lets generation retry the same topic.
        status: { in: [PostStatus.APPROVED, PostStatus.POSTING, PostStatus.POSTED] },
        OR: [{ approvedAt: { gte: since } }, { postedAt: { gte: since } }],
      },
    });
  }

  /**
   * P0-2: Find continuation posts in a thread (position > 0) for multi-stage posting.
   * Returns posts ordered by threadPosition ascending.
   */
  async findThreadContinuations(threadId: string): Promise<Post[]> {
    return this.prisma.post.findMany({
      where: {
        threadId,
        threadPosition: { gt: 0 },
        status: PostStatus.APPROVED,
      },
      orderBy: { threadPosition: 'asc' },
    });
  }
}
