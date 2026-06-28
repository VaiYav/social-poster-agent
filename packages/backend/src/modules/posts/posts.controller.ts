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
import type { SocialNetwork } from '@prisma/client';
import { IPostingQueuePort } from '../../domain/ports/posting-queue.port.js';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { PostsService } from './posts.service';
import {
  CreatePostDtoSchema,
  UpdatePostStatusDtoSchema,
  PostQueryDtoSchema,
  ApprovePostDtoSchema,
  type CreatePostDto,
  type UpdatePostStatusDto,
  type PostQueryDto,
  type ApprovePostDto,
} from '../../domain/dtos';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly postsService: PostsService,
    @Inject(IPostingQueuePort) private readonly postingQueue: IPostingQueuePort,
  ) {}

  /**
   * A5: enqueue via IPostingQueuePort (bound in QueueInfraModule). The port breaks the
   * PostsModule → QueueModule → PostingModule → PostsModule cycle without a ModuleRef hack.
   * Failures are swallowed — the reconciliation cron re-enqueues APPROVED posts that weren't queued.
   */
  private async enqueueForPosting(postId: string, network: string): Promise<void> {
    try {
      await this.postingQueue.enqueuePosting(postId, network as SocialNetwork);
    } catch (err) {
      this.logger.error(`Failed to enqueue post ${postId}: ${(err as Error).message}`);
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
      await this.enqueueForPosting(post.id, post.network as string);
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
