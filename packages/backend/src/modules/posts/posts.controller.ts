import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { type SocialNetwork, PostStatus, type Prisma } from '@prisma/client';
import { IPostingQueuePort } from '../../domain/ports/posting-queue.port.js';
import { PostingWindowService } from '../orchestrator/posting-window.service.js';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { PostsService } from './posts.service';
import {
  CreatePostDtoSchema,
  UpdatePostStatusDtoSchema,
  PostQueryDtoSchema,
  ApprovePostDtoSchema,
  CalendarQueryDtoSchema,
  SchedulePostDtoSchema,
  type CreatePostDto,
  type UpdatePostStatusDto,
  type PostQueryDto,
  type ApprovePostDto,
  type CalendarQueryDto,
  type SchedulePostDto,
} from '../../domain/dtos.js';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly postsService: PostsService,
    @Inject(IPostingQueuePort) private readonly postingQueue: IPostingQueuePort,
    private readonly postingWindowService: PostingWindowService,
  ) {}

  /**
   * A5: enqueue via IPostingQueuePort (bound in QueueInfraModule). The port breaks the
   * PostsModule → QueueModule → PostingModule → PostsModule cycle without a ModuleRef hack.
   *
   * F7: if a scheduled time is set and is in the future, post at that exact time.
   *
   * F11 Best Time to Post: if the post is approved outside the current engagement window,
   * enqueue it with a delay so the worker runs inside the next window.
   */
  private async enqueueForPosting(post: {
    id: string;
    network: SocialNetwork;
    approvedAt: Date | null;
    threadPosition?: number;
    llmMetadata?: Prisma.JsonValue | null;
  }): Promise<void> {
    try {
      const { id: postId, network, approvedAt, threadPosition = 0 } = post;

      // F7: respect a future scheduled time before applying posting-window logic.
      if (approvedAt && approvedAt.getTime() > Date.now()) {
        const delay = approvedAt.getTime() - Date.now();
        this.logger.log(
          `Post ${postId} scheduled for ${approvedAt.toISOString()} — delaying ${Math.round(delay / 60000)}min`,
        );
        await this.postingQueue.enqueuePosting(postId, network, { delay });
        return;
      }

      // F2: multi-stage continuations (position > 0) are queued with a delay so
      // the root has time to post before the worker tries to reply.
      const llmMetadata = (post.llmMetadata as { multiStage?: boolean } | null) ?? {};
      const isMultiStage = llmMetadata.multiStage === true;
      if (isMultiStage && threadPosition > 0) {
        const delayMs = parseInt(process.env['THREAD_CONTINUATION_DELAY_MS'] ?? '1800000', 10);
        const delay = delayMs * threadPosition;
        this.logger.log(
          `F2: continuation ${postId} (position ${threadPosition}) queued with ${Math.round(delay / 60000)}min delay`,
        );
        await this.postingQueue.enqueuePosting(postId, network, { delay, priority: 5 });
        return;
      }

      const window = await this.postingWindowService.getRecommendation(network);
      if (!window.inWindow) {
        const delay = await this.postingWindowService.getDelayToNextWindow(network);
        this.logger.log(
          `Post ${postId} approved outside posting window for ${network} — delaying ${Math.round(delay / 60000)}min`,
        );
        await this.postingQueue.enqueuePosting(postId, network, { delay });
        return;
      }
      await this.postingQueue.enqueuePosting(postId, network);
    } catch (err) {
      this.logger.error(`Failed to enqueue post ${post.id}: ${(err as Error).message}`);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List posts (paginated, filterable by status/network)' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED'] })
  @ApiQuery({ name: 'network', required: false, enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of posts' })
  async findMany(@Query() rawQuery: unknown) {
    const query = PostQueryDtoSchema.parse(rawQuery) as PostQueryDto;
    return this.postsService.findMany(query);
  }

  @Get('drafts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List draft posts (pending review)' })
  @ApiQuery({ name: 'network', required: false, enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'List of draft posts' })
  async findDrafts(@Query('network') network?: 'X' | 'THREADS' | 'FACEBOOK') {
    return this.postsService.findDrafts(network);
  }

  @Get('calendar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F7: Get posts as calendar events in a date range' })
  @ApiQuery({ name: 'from', required: true, type: String, description: 'Start date (ISO date or datetime)' })
  @ApiQuery({ name: 'to', required: true, type: String, description: 'End date (ISO date or datetime)' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'APPROVED', 'POSTING', 'POSTED', 'FAILED', 'REJECTED', 'JUDGED', 'VERIFIED'] })
  @ApiQuery({ name: 'network', required: false, enum: ['X', 'THREADS', 'FACEBOOK', 'DEVTO', 'HASHNODE', 'LINKEDIN', 'BLUESKY', 'MASTODON', 'TELEGRAM', 'MEDIUM', 'SUBSTACK', 'REDDIT', 'QUORA', 'PINTEREST'] })
  @ApiResponse({ status: 200, description: 'List of calendar events' })
  async getCalendar(@Query() rawQuery: unknown) {
    let query: CalendarQueryDto;
    try {
      query = CalendarQueryDtoSchema.parse(rawQuery) as CalendarQueryDto;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return this.postsService.findCalendar(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a single post by ID' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Post details' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async findById(@Param('id') id: string) {
    return this.postsService.findById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new post manually' })
  @ApiResponse({ status: 201, description: 'Post created' })
  async create(@Body() rawBody: unknown) {
    // Minor-30: return 400 for Zod validation errors instead of 500
    let dto: CreatePostDto;
    try {
      dto = CreatePostDtoSchema.parse(rawBody) as CreatePostDto;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return this.postsService.create(dto);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update post status' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status value' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async updateStatus(@Param('id') id: string, @Body() rawBody: unknown) {
    // Minor-30: return 400 for Zod validation errors instead of 500
    let dto: UpdatePostStatusDto;
    try {
      dto = UpdatePostStatusDtoSchema.parse(rawBody) as UpdatePostStatusDto;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    try {
      return await this.postsService.updateStatus(id, dto);
    } catch {
      throw new NotFoundException(`Post ${id} not found`);
    }
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a draft post (optionally with edited content) — enqueues to BullMQ posting queue' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Post approved and enqueued for posting' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async approve(@Param('id') id: string, @Body() rawBody: unknown) {
    // Minor-30: return 400 for Zod validation errors instead of 404
    let dto: ApprovePostDto;
    try {
      dto = ApprovePostDtoSchema.parse(rawBody ?? {}) as ApprovePostDto;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    try {
      const post = await this.postsService.approve(id, dto.editedContent);

      // P0 fix: enqueue to BullMQ posting queue — this is the core approve→post happy path
      await this.enqueueForPosting(post);
      this.logger.log(`Post ${id} approved and enqueued for ${post.network}`);

      return post;
    } catch (err) {
      // PO1/PO3: surface the real error — 409 for invalid transition, 404 for
      // missing, 400 for bad body. Don't mask DB errors as 404.
      if (
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      this.logger.error(`Approve failed for post ${id}: ${(err as Error).message}`);
      throw new NotFoundException(`Post ${id} not found`);
    }
  }

  @Patch(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F7: Reschedule a post to a specific date/time' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Post rescheduled' })
  @ApiResponse({ status: 400, description: 'Invalid scheduledAt value' })
  @ApiResponse({ status: 409, description: 'Post cannot be rescheduled from this status' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async schedule(@Param('id') id: string, @Body() rawBody: unknown) {
    let dto: SchedulePostDto;
    try {
      dto = SchedulePostDtoSchema.parse(rawBody) as SchedulePostDto;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    try {
      const post = await this.postsService.schedule(id, dto);

      // F7: if the post is already APPROVED/POSTING, re-enqueue with the new delay.
      if (post.status === PostStatus.APPROVED || post.status === PostStatus.POSTING) {
        await this.enqueueForPosting(post);
      }

      return post;
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      this.logger.error(`Reschedule failed for post ${id}: ${(err as Error).message}`);
      throw new NotFoundException(`Post ${id} not found`);
    }
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a draft post' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Post rejected' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async reject(@Param('id') id: string) {
    try {
      return await this.postsService.reject(id);
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      throw new NotFoundException(`Post ${id} not found`);
    }
  }
}
