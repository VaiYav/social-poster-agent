/**
 * Sprint Q: Replies Controller — REST API for reply monitoring.
 *
 * Endpoints:
 *   GET    /api/v1/replies/pending          — comments pending human review
 *   GET    /api/v1/replies/stats             — reply monitoring stats
 *   POST   /api/v1/replies/:id/manual-reply  — manually reply to a human-review comment
 *   POST   /api/v1/replies/:id/dismiss       — dismiss a human-review comment
 *   POST   /api/v1/replies/run               — manually trigger monitoring cycle
 */
import { Controller, Get, Post, Body, Param, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { RepliesMonitorService } from './replies-monitor.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CommentStatus } from '@prisma/client';
import { z } from 'zod';

const manualReplySchema = z.object({
  replyText: z.string().min(1).max(500),
});

@ApiTags('replies')
@Controller('replies')
export class RepliesController {
  constructor(
    private readonly repliesMonitor: RepliesMonitorService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Feature-flag guard — all write endpoints require REPLIES_ENABLED=true.
   * Read endpoints (pending, stats) are allowed even when disabled so operators
   * can inspect historical data.
   */
  private ensureEnabled(): void {
    if (!this.repliesMonitor.isEnabled()) {
      throw new BadRequestException('Replies module is disabled (REPLIES_ENABLED != true)');
    }
  }

  /**
   * Get comments pending human review.
   */
  @Get('pending')
  @ApiOperation({ summary: 'Get comments pending human review' })
  @ApiResponse({ status: 200, description: 'List of comments awaiting human review' })
  async getPending() {
    return this.repliesMonitor.getPendingHumanReview();
  }

  /**
   * Get reply monitoring stats — counts by status.
   */
  @Get('stats')
  @ApiOperation({ summary: 'Get reply monitoring stats' })
  @ApiResponse({ status: 200, description: 'Reply monitoring statistics and enabled flag' })
  async getStats() {
    const [newCount, replied, skipped, humanReview, repliedManual] = await Promise.all([
      this.prisma.incomingComment.count({ where: { status: CommentStatus.NEW } }),
      this.prisma.incomingComment.count({ where: { status: CommentStatus.REPLIED } }),
      this.prisma.incomingComment.count({ where: { status: CommentStatus.SKIPPED } }),
      this.prisma.incomingComment.count({ where: { status: CommentStatus.HUMAN_REVIEW } }),
      this.prisma.incomingComment.count({ where: { status: CommentStatus.REPLIED_MANUAL } }),
    ]);
    return {
      enabled: this.repliesMonitor.isEnabled(),
      counts: { new: newCount, replied, skipped, humanReview, repliedManual },
      pendingReview: humanReview,
    };
  }

  /**
   * Manually reply to a human-review comment.
   */
  @Post(':id/manual-reply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually reply to a human-review comment' })
  @ApiParam({ name: 'id', description: 'Comment id' })
  @ApiBody({ schema: { type: 'object', properties: { replyText: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['replyText'] } })
  @ApiResponse({ status: 200, description: 'Reply result' })
  @ApiResponse({ status: 400, description: 'Replies module disabled or invalid reply text' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async manualReply(@Param('id') id: string, @Body() body: unknown) {
    this.ensureEnabled();
    const parsed = manualReplySchema.safeParse(body);
    if (!parsed.success) {
      return { success: false, error: parsed.error.message };
    }
    return this.repliesMonitor.manualReply(id, parsed.data.replyText);
  }

  /**
   * Dismiss a human-review comment (skip replying).
   */
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a human-review comment (skip replying)' })
  @ApiParam({ name: 'id', description: 'Comment id' })
  @ApiResponse({ status: 200, description: 'Dismiss result' })
  @ApiResponse({ status: 400, description: 'Replies module disabled' })
  async dismiss(@Param('id') id: string) {
    this.ensureEnabled();
    await this.repliesMonitor.dismissReview(id);
    return { success: true };
  }

  /**
   * Manually trigger a monitoring cycle (for testing/debugging).
   */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger a replies monitoring cycle' })
  @ApiResponse({ status: 200, description: 'Monitoring cycle statistics' })
  @ApiResponse({ status: 400, description: 'Replies module disabled' })
  async runCycle() {
    this.ensureEnabled();
    return this.repliesMonitor.runMonitoringCycle();
  }
}
