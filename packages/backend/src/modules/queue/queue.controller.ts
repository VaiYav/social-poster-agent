import { Controller, Get, Post, Param, ParseEnumPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SocialNetwork } from '@prisma/client';
import { QueueService } from './queue.service';

/**
 * Queue controller — inspect BullMQ job state per network + pause/resume (F5).
 * Used by the UI Queue page to show pending/active/failed jobs and control flow.
 *
 * Sprint Q: Added aggregated GET /stats (all networks) and POST /:network/retry-failed.
 */
@ApiTags('queue')
@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get aggregated BullMQ job counts for all networks (Sprint Q)' })
  @ApiResponse({ status: 200, description: 'Array of per-network job counts with paused status' })
  async getAllStats() {
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const results = await Promise.all(
      networks.map(async (network) => {
        const counts = await this.queueService.getJobCounts(network);
        const paused = await this.queueService.isQueuePaused(network);
        return { network, ...counts, paused };
      }),
    );
    return results;
  }

  @Get(':network/stats')
  @ApiOperation({ summary: 'Get BullMQ job counts per network' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Job counts: waiting, active, completed, failed, delayed' })
  async getStats(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return this.queueService.getJobCounts(network);
  }

  @Get(':network/failed')
  @ApiOperation({ summary: 'List failed BullMQ jobs per network' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'List of failed jobs with error details' })
  async getFailed(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return this.queueService.getFailedJobs(network);
  }

  @Get(':network/paused')
  @ApiOperation({ summary: 'Check if queue is paused (F5)' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Boolean — whether the queue is currently paused' })
  async isPaused(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return { paused: await this.queueService.isQueuePaused(network) };
  }

  @Post(':network/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause queue for a network — stops new job processing (F5)' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Queue paused' })
  async pause(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    await this.queueService.pauseQueue(network);
    return { paused: true, network };
  }

  @Post(':network/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused queue (F5)' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Queue resumed' })
  async resume(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    await this.queueService.resumeQueue(network);
    return { paused: false, network };
  }

  @Post(':network/retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed jobs in a network queue (Sprint Q)' })
  @ApiParam({ name: 'network', enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Number of jobs retried' })
  async retryFailed(@Param('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    const retried = await this.queueService.retryAllFailed(network);
    return { retried, network };
  }
}
