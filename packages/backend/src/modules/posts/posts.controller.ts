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
} from '@nestjs/common';
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
  constructor(private readonly postsService: PostsService) {}

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
    const dto = CreatePostDtoSchema.parse(rawBody) as CreatePostDto;
    return this.postsService.create(dto);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update post status' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async updateStatus(@Param('id') id: string, @Body() rawBody: unknown) {
    const dto = UpdatePostStatusDtoSchema.parse(rawBody) as UpdatePostStatusDto;
    try {
      return await this.postsService.updateStatus(id, dto);
    } catch {
      throw new NotFoundException(`Post ${id} not found`);
    }
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a draft post (optionally with edited content) — moves to posting queue' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Post approved' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  async approve(@Param('id') id: string, @Body() rawBody: unknown) {
    try {
      // D2: accept optional editedContent — operator can edit post before approving
      const dto = ApprovePostDtoSchema.parse(rawBody ?? {}) as ApprovePostDto;
      return await this.postsService.approve(id, dto.editedContent);
    } catch {
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
      return await this.postsService.updateStatus(id, { status: 'REJECTED' });
    } catch {
      throw new NotFoundException(`Post ${id} not found`);
    }
  }
}
