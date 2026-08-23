import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  PostStatus,
  type SocialNetwork,
  type Prisma,
  type Post,
} from "../../generated/prisma/client.js";
import type {
  PostQueryDto,
  UpdatePostStatusDto,
  CalendarQueryDto,
  SchedulePostDto,
} from "../../domain/dtos.js";
import type {
  PostDraftGeneratedEvent,
  PostApprovedEvent,
  PostRejectedEvent,
  PostReviewFeedback,
} from "@spa/shared";
import { PostEvents } from "../../events/enums/post-events.enum.js";
import { checkContentLength } from "./network-limits.js";
import { simhash } from "../generation/simhash.js";
import { AutoCheckService } from "../autonomy/auto-check.service.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { resolve, relative } from "node:path";
import { stat } from "node:fs/promises";
import {
  hashReviewContent,
  normalizedEditDistance,
  type ReviewDecision,
} from "./review-feedback.js";

/**
 * Extract the source path from a sourceRef JSON object when it is present.
 * Returns `null` when the ref is not an object or has no string `path`.
 */
export function extractSourcePath(sourceRef: unknown): string | null {
  if (!sourceRef || typeof sourceRef !== "object") return null;
  const path = (sourceRef as Record<string, unknown>)["path"];
  return typeof path === "string" ? path : null;
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
    @Optional() private readonly configService?: ConfigService,
  ) {}

  private reviewReasonsEnforced(): boolean {
    return parseBool(
      this.configService?.get<string>("REVIEW_FEEDBACK_ENFORCE_REASONS", "false") ?? "false",
    );
  }

  private validateReviewFeedback(
    decision: ReviewDecision,
    feedback: PostReviewFeedback | undefined,
    editDistance: number,
  ): void {
    if (!this.reviewReasonsEnforced()) return;
    const reasonCodes = feedback?.reasonCodes ?? [];
    if (decision === "REJECT" && reasonCodes.length === 0) {
      throw new BadRequestException("A rejection requires at least one review reason code");
    }
    if (decision === "APPROVE_EDITED" && editDistance >= 0.05 && reasonCodes.length === 0) {
      throw new BadRequestException(
        "An edited approval with >=5% normalized change requires at least one review reason code",
      );
    }
  }

  private async persistReviewDecision(
    tx: Prisma.TransactionClient,
    post: Pick<Post, "id" | "content" | "generationRunId" | "llmMetadata">,
    decision: ReviewDecision,
    finalContent: string,
    feedback: PostReviewFeedback | undefined,
    actorId: string | undefined,
  ): Promise<void> {
    const latest = await tx.postReviewDecision.findFirst({
      where: { postId: post.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const metadata =
      post.llmMetadata && typeof post.llmMetadata === "object" && !Array.isArray(post.llmMetadata)
        ? (post.llmMetadata as Record<string, unknown>)
        : {};
    const editDistance =
      decision === "REJECT" ? null : normalizedEditDistance(post.content, finalContent);

    await tx.postReviewDecision.create({
      data: {
        postId: post.id,
        version: (latest?.version ?? 0) + 1,
        actorId: actorId ?? null,
        decision,
        reasonCodes: feedback?.reasonCodes ?? [],
        rubric: feedback?.rubric,
        comment: feedback?.comment,
        originalContentHash: hashReviewContent(post.content),
        finalContentHash: decision === "REJECT" ? null : hashReviewContent(finalContent),
        normalizedEditDistance: editDistance,
        generationRunId: post.generationRunId ?? null,
        langfuseTraceId:
          typeof metadata.langfuseTraceId === "string" ? metadata.langfuseTraceId : null,
        langfuseObservationId:
          typeof metadata.langfuseObservationId === "string"
            ? metadata.langfuseObservationId
            : null,
        syncStatus: "PENDING",
      },
    });
  }

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
      [PostStatus.POSTED]: [PostStatus.VERIFIED],
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
        orderBy: { createdAt: "desc" },
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
      orderBy: { createdAt: "desc" },
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

  async getMediaFile(postId: string): Promise<{ path: string; mimeType: string } | null> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { media: true },
    });
    if (!post?.media || typeof post.media !== "object" || Array.isArray(post.media)) return null;
    const metadata = post.media as Record<string, unknown>;
    const image = metadata.image;
    const pathValue =
      image && typeof image === "object" && !Array.isArray(image)
        ? (image as Record<string, unknown>).path
        : metadata.path;
    if (typeof pathValue !== "string" || pathValue.length === 0) return null;
    const outputDir = resolve(
      this.configService?.get<string>("IMAGE_OUTPUT_DIR", "./spa-images") ?? "./spa-images",
    );
    const filePath = resolve(pathValue);
    const rel = relative(outputDir, filePath);
    if (rel.startsWith("..") || rel.includes("\0")) {
      this.logger.warn(`Blocked media path outside IMAGE_OUTPUT_DIR for post ${postId}`);
      return null;
    }
    const file = await stat(filePath).catch(() => null);
    if (!file?.isFile()) return null;
    return { path: filePath, mimeType: "image/png" };
  }

  /**
   * Emit DRAFT_GENERATED for a persisted draft. Call this AFTER a transaction
   * commits when create() was used with `{ emitEvent: false }` inside that tx.
   */
  emitDraftGenerated(postId: string, network: SocialNetwork): void {
    this.eventEmitter.emit(PostEvents.DRAFT_GENERATED, {
      postId,
      network,
    } satisfies PostDraftGeneratedEvent);
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
  async approve(
    id: string,
    editedContent?: string,
    feedback?: PostReviewFeedback,
    actorId?: string,
  ) {
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
    const decision: ReviewDecision =
      editedContent && editedContent.trim().length > 0 ? "APPROVE_EDITED" : "APPROVE_UNCHANGED";
    const editDistance = normalizedEditDistance(post.content, effectiveContent);
    this.validateReviewFeedback(decision, feedback, editDistance);
    const lengthCheck = checkContentLength(post.network, effectiveContent);
    if (!lengthCheck.ok) {
      throw new BadRequestException(
        `Post ${id} content is ${lengthCheck.length} chars — exceeds the ${post.network} limit of ${lengthCheck.limit}`,
      );
    }

    // F7: preserve a future scheduled time if the operator scheduled the draft
    // before approving. Otherwise record approval time as now.
    const now = new Date();
    const updateData: Prisma.PostUpdateInput = {
      status: PostStatus.APPROVED,
      approvedAt: post.approvedAt && post.approvedAt > now ? post.approvedAt : now,
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

    const updated = await this.prisma.$transaction(async (tx) => {
      // Conditional update makes concurrent approvals/rejections mutually exclusive.
      const claimed = await tx.post.updateMany({
        where: { id, status: PostStatus.DRAFT },
        data: updateData,
      });
      if (claimed.count === 0) {
        throw new ConflictException(`Post ${id} cannot be approved after a concurrent transition`);
      }
      const committed = await tx.post.findUnique({ where: { id } });
      if (!committed) throw new NotFoundException(`Post ${id} not found`);
      await this.persistReviewDecision(tx, post, decision, effectiveContent, feedback, actorId);
      return committed;
    });

    this.eventEmitter.emit(PostEvents.APPROVED, {
      postId: id,
      network: post.network,
    } satisfies PostApprovedEvent);
    return updated;
  }

  /**
   * PO1: Reject a draft post — only valid from DRAFT (can't resurrect/cancel
   * posts already in the posting pipeline).
   */
  async reject(id: string, feedback?: PostReviewFeedback, actorId?: string) {
    const post = await this.findById(id);
    if (post.status !== PostStatus.DRAFT) {
      throw new ConflictException(
        `Post ${id} cannot be rejected from status ${post.status} (only DRAFT)`,
      );
    }
    this.validateReviewFeedback("REJECT", feedback, 0);
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.post.updateMany({
        where: { id, status: PostStatus.DRAFT },
        data: { status: PostStatus.REJECTED },
      });
      if (claimed.count === 0) {
        throw new ConflictException(`Post ${id} cannot be rejected after a concurrent transition`);
      }
      const committed = await tx.post.findUnique({ where: { id } });
      if (!committed) throw new NotFoundException(`Post ${id} not found`);
      await this.persistReviewDecision(tx, committed, "REJECT", post.content, feedback, actorId);
      return committed;
    });
    this.logger.log(`Post ${id}: ${post.status} → REJECTED`);
    this.eventEmitter.emit(PostEvents.REJECTED, {
      postId: id,
      network: post.network,
    } satisfies PostRejectedEvent);
    return updated;
  }

  /**
   * F7: Content Calendar — fetch posts that should appear on a calendar, keyed by
   * the best available event date (postedAt > approvedAt > createdAt).
   *
   * Uses a wide createdAt query plus an in-memory filter so the calendar naturally
   * shows approved/posted events that may have been created much earlier.
   */
  async findCalendar(query: CalendarQueryDto) {
    const from = new Date(query.from);
    from.setHours(0, 0, 0, 0);
    const to = new Date(query.to);
    to.setHours(23, 59, 59, 999);

    const bufferDays = 90;
    const createdFrom = new Date(from);
    createdFrom.setDate(createdFrom.getDate() - bufferDays);
    const createdTo = new Date(to);
    createdTo.setDate(createdTo.getDate() + bufferDays);

    const where: Prisma.PostWhereInput = {
      ...(query.network && { network: query.network }),
      ...(query.status && { status: query.status }),
      createdAt: { gte: createdFrom, lte: createdTo },
    };

    const posts = await this.prisma.post.findMany({
      where,
      include: { account: { select: { id: true, handle: true, network: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const events = posts
      .map((post) => {
        const timestamp =
          post.status === PostStatus.POSTED || post.status === PostStatus.VERIFIED
            ? (post.postedAt ?? post.approvedAt ?? post.createdAt)
            : (post.approvedAt ?? post.createdAt);
        if (!timestamp) return null;
        const t = new Date(timestamp);
        if (t < from || t > to) return null;
        return {
          id: post.id,
          network: post.network,
          status: post.status,
          content: post.content,
          timestamp: t.toISOString(),
          account: post.account,
          postUrl: post.postUrl,
          errorMessage: post.errorMessage,
        };
      })
      .filter(Boolean);

    return events as Array<{
      id: string;
      network: string;
      status: string;
      content: string;
      timestamp: string;
      account: { id: string; handle: string | null; network: string } | null;
      postUrl: string | null;
      errorMessage: string | null;
    }>;
  }

  /**
   * F7: Reschedule a post by updating its approvedAt timestamp.
   * Allowed while the post is still in the pipeline (DRAFT, APPROVED, POSTING).
   */
  async schedule(id: string, dto: SchedulePostDto) {
    const post = await this.findById(id);

    if (
      post.status === PostStatus.POSTED ||
      post.status === PostStatus.FAILED ||
      post.status === PostStatus.REJECTED ||
      post.status === PostStatus.VERIFIED
    ) {
      throw new ConflictException(`Post ${id} cannot be rescheduled from status ${post.status}`);
    }

    const scheduledAt = new Date(dto.scheduledAt);
    const updated = await this.prisma.post.update({
      where: { id },
      data: { approvedAt: scheduledAt },
    });

    this.logger.log(`Post ${id} rescheduled to ${scheduledAt.toISOString()}`);
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
      orderBy: { threadPosition: "asc" },
    });
  }

  /**
   * F2: Find the root post of a thread (threadPosition=0).
   */
  async findThreadRoot(threadId: string): Promise<Post | null> {
    return this.prisma.post.findFirst({
      where: { threadId, threadPosition: 0 },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * F2: Find a post in a thread by its exact threadPosition.
   */
  async findByThreadPosition(threadId: string, position: number): Promise<Post | null> {
    return this.prisma.post.findFirst({
      where: { threadId, threadPosition: position },
      orderBy: { createdAt: "asc" },
    });
  }
}
