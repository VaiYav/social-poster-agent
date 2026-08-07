// Engagement controller — REST API endpoints for engagement actions.
// All endpoints trigger browser automation to perform the action.

import { Body, Controller, Get, Post, Query, BadRequestException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { EngagementService } from './engagement.service.js';
import { BrowsingSessionService } from './browsing-session.service.js';
import { EngagementSchedulerService } from './engagement-scheduler.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { SocialNetwork, InteractionType, InteractionStatus, BrowsingSessionStatus } from '@prisma/client';

const likeSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  postUrl: z.string().url(),
});

const commentSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  postUrl: z.string().url(),
  text: z.string().min(1).max(500),
});

const followSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  handleOrUrl: z.string().min(1),
});

const replySchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  postUrl: z.string().url(),
  text: z.string().min(1).max(500),
});

const repostSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  postUrl: z.string().url(),
});

const quoteSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  postUrl: z.string().url(),
  text: z.string().min(1).max(500),
});

const browsingSessionSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  durationSec: z.number().min(60).max(3600).optional(),
});

const networkQuerySchema = z.enum(['X', 'THREADS', 'FACEBOOK']).optional();
const interactionTypeQuerySchema = z.enum(Object.values(InteractionType) as [string, ...string[]]).optional();
const interactionStatusQuerySchema = z.enum(Object.values(InteractionStatus) as [string, ...string[]]).optional();
const browsingSessionStatusQuerySchema = z.enum(Object.values(BrowsingSessionStatus) as [string, ...string[]]).optional();
const limitQuerySchema = z.coerce.number().int().min(1).max(1000).optional();

@ApiTags('engagement')
@Controller('engagement')
@UseGuards(AdminGuard)
export class EngagementController {
  constructor(
    private readonly engagementService: EngagementService,
    private readonly browsingSessionService: BrowsingSessionService,
    private readonly engagementSchedulerService: EngagementSchedulerService,
  ) {}

  @Post('like')
  @ApiOperation({ summary: 'F1: Like a post on the given network' })
  @ApiResponse({ status: 201, description: 'Like interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async like(@Body() body: unknown) {
    const parsed = likeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.like(
      parsed.data.network as SocialNetwork,
      parsed.data.postUrl,
    );
  }

  @Post('comment')
  @ApiOperation({ summary: 'F1: Comment on a post on the given network' })
  @ApiResponse({ status: 201, description: 'Comment interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async comment(@Body() body: unknown) {
    const parsed = commentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.comment(
      parsed.data.network as SocialNetwork,
      parsed.data.postUrl,
      parsed.data.text,
    );
  }

  @Post('follow')
  @ApiOperation({ summary: 'F1: Follow a user/profile on the given network' })
  @ApiResponse({ status: 201, description: 'Follow interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async follow(@Body() body: unknown) {
    const parsed = followSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.follow(
      parsed.data.network as SocialNetwork,
      parsed.data.handleOrUrl,
    );
  }

  @Post('reply')
  @ApiOperation({ summary: 'F1: Reply to a comment on the given network' })
  @ApiResponse({ status: 201, description: 'Reply interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async reply(@Body() body: unknown) {
    const parsed = replySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.reply(
      parsed.data.network as SocialNetwork,
      parsed.data.postUrl,
      parsed.data.text,
    );
  }

  @Post('repost')
  @ApiOperation({ summary: 'F1: Repost a post on the given network' })
  @ApiResponse({ status: 201, description: 'Repost interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async repost(@Body() body: unknown) {
    const parsed = repostSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.repost(
      parsed.data.network as SocialNetwork,
      parsed.data.postUrl,
    );
  }

  @Post('quote')
  @ApiOperation({ summary: 'F1: Quote-post a post on the given network' })
  @ApiResponse({ status: 201, description: 'Quote interaction result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async quote(@Body() body: unknown) {
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.engagementService.quote(
      parsed.data.network as SocialNetwork,
      parsed.data.postUrl,
      parsed.data.text,
    );
  }

  @Post('browsing-session')
  @ApiOperation({ summary: 'F1: Start a browsing session for the given network' })
  @ApiResponse({ status: 201, description: 'Browsing session started' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async startBrowsingSession(@Body() body: unknown) {
    const parsed = browsingSessionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return this.browsingSessionService.runBrowsingSession(
      parsed.data.network as SocialNetwork,
      parsed.data.durationSec,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'F1: Get engagement stats for a network or all networks' })
  @ApiQuery({ name: 'network', required: false, description: 'X, THREADS, or FACEBOOK' })
  @ApiResponse({ status: 200, description: 'Engagement statistics' })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  async getStats(@Query('network') network?: string) {
    const parsed = networkQuerySchema.safeParse(network);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    const networkEnum = parsed.data ? SocialNetwork[parsed.data] : undefined;
    return this.engagementService.getStats(networkEnum);
  }

  @Get('interactions')
  @ApiOperation({ summary: 'F1: List recent interactions with optional filters' })
  @ApiQuery({ name: 'network', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of interactions' })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  async getInteractions(
    @Query('network') network?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedNetwork = networkQuerySchema.safeParse(network);
    const parsedType = interactionTypeQuerySchema.safeParse(type);
    const parsedStatus = interactionStatusQuerySchema.safeParse(status);
    const parsedLimit = limitQuerySchema.safeParse(limit);
    if (!parsedNetwork.success || !parsedType.success || !parsedStatus.success || !parsedLimit.success) {
      throw new BadRequestException(
        [parsedNetwork, parsedType, parsedStatus, parsedLimit]
          .filter((p) => !p.success)
          .map((p) => p.error!.message)
          .join('; '),
      );
    }
    return this.browsingSessionService.findInteractions({
      network: parsedNetwork.data ? SocialNetwork[parsedNetwork.data] : undefined,
      type: parsedType.data as InteractionType | undefined,
      status: parsedStatus.data as InteractionStatus | undefined,
      limit: parsedLimit.data,
    });
  }

  @Get('browsing-sessions')
  @ApiOperation({ summary: 'F1: List browsing sessions with optional filters' })
  @ApiQuery({ name: 'network', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of browsing sessions' })
  @ApiResponse({ status: 400, description: 'Invalid query parameter' })
  async getBrowsingSessions(
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedNetwork = networkQuerySchema.safeParse(network);
    const parsedStatus = browsingSessionStatusQuerySchema.safeParse(status);
    const parsedLimit = limitQuerySchema.safeParse(limit);
    if (!parsedNetwork.success || !parsedStatus.success || !parsedLimit.success) {
      throw new BadRequestException(
        [parsedNetwork, parsedStatus, parsedLimit]
          .filter((p) => !p.success)
          .map((p) => p.error!.message)
          .join('; '),
      );
    }
    return this.browsingSessionService.findAll({
      network: parsedNetwork.data ? SocialNetwork[parsedNetwork.data] : undefined,
      status: parsedStatus.data as BrowsingSessionStatus | undefined,
      limit: parsedLimit.data,
    });
  }

  @Get('scheduler/status')
  @ApiOperation({ summary: 'F1: Get engagement scheduler status' })
  @ApiResponse({ status: 200, description: 'Scheduler configuration and pending sessions' })
  async getSchedulerStatus() {
    return this.engagementSchedulerService.getStatus();
  }
}
