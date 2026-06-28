/**
 * Sprint O / F13: Recycling Controller — REST endpoints for content recycling.
 */
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RecyclingService } from './recycling.service';
import { LocalhostGuard } from '../../infrastructure/guards/localhost.guard';

@Controller('recycling')
export class RecyclingController {
  constructor(private readonly recyclingService: RecyclingService) {}

  @Get('candidates')
  getCandidates(@Query('limit') limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 10, 50) : 10;
    return this.recyclingService.findRecyclablePosts(n);
  }

  @Post('run')
  @UseGuards(LocalhostGuard) // Triggers batch DB writes — restrict to localhost
  runRecycling(@Query('limit') limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 5, 20) : 5;
    return this.recyclingService.runRecycling(n);
  }

  @Post(':postId/recycle')
  @UseGuards(LocalhostGuard) // Triggers DB writes — restrict to localhost
  recyclePost(@Param('postId') postId: string) {
    return this.recyclingService.recyclePost(postId);
  }
}
