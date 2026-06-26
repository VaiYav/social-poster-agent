// Engagement controller — REST API endpoints for engagement actions.
// All endpoints trigger browser automation to perform the action.

import { Body, Controller, Get, Param, Post, Query, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EngagementService } from './engagement.service.js';
import { BrowsingSessionService } from './browsing-session.service.js';
import { SocialNetwork } from '@prisma/client';

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

const browsingSessionSchema = z.object({
  network: z.enum(['X', 'THREADS', 'FACEBOOK']),
  durationSec: z.number().min(60).max(3600).optional(),
});

@Controller('engagement')
export class EngagementController {
  constructor(
    private readonly engagementService: EngagementService,
    private readonly browsingSessionService: BrowsingSessionService,
  ) {}

  @Post('like')
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

  @Post('browsing-session')
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
  async getStats(@Query('network') network?: string) {
    const networkEnum = network
      ? (SocialNetwork[network as keyof typeof SocialNetwork] as SocialNetwork)
      : undefined;
    return this.engagementService.getStats(networkEnum);
  }

  @Get('interactions')
  async getInteractions(
    @Query('network') network?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.browsingSessionService.findInteractions({
      network: network
        ? (SocialNetwork[network as keyof typeof SocialNetwork] as SocialNetwork)
        : undefined,
      type: type as never,
      status: status as never,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('browsing-sessions')
  async getBrowsingSessions(
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.browsingSessionService.findAll({
      network: network
        ? (SocialNetwork[network as keyof typeof SocialNetwork] as SocialNetwork)
        : undefined,
      status: status as never,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
