import { Controller, Get, Param, ParseEnumPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SocialNetwork } from '@prisma/client';
import { QueueService } from './queue.service';

/**
 * Queue controller — inspect BullMQ job state per network.
 * Used by the UI Queue page to show pending/active/failed jobs.
 */
@ApiTags('queue')
@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

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
}
