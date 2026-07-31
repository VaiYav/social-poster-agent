import { Controller, Post, Body, Get, Param, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { GenerationService } from './generation.service';
import { GeneratePostsDtoSchema, type GeneratePostsDto } from '../../domain/dtos.js';
import { GenerationTrigger } from '@prisma/client';

@ApiTags('generation')
@Controller('generation')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger content generation (LangGraph workflow)' })
  @ApiResponse({ status: 202, description: 'Generation run started' })
  async run(@Body() rawBody: unknown) {
    const dto = GeneratePostsDtoSchema.parse(rawBody ?? {}) as GeneratePostsDto;
    const body = rawBody as { humanReview?: boolean };
    const runId = await this.generationService.generate(
      dto.count,
      dto.networks,
      GenerationTrigger.MANUAL,
      dto.multiStage,
      body.humanReview ?? false,
    );
    return { runId, status: 'started' };
  }

  @Post('repurpose')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'F10: Content Repurposing — deep fact extraction from articles' })
  @ApiResponse({ status: 202, description: 'Repurposing generation run started' })
  async repurpose(@Body() rawBody: unknown) {
    const body = (rawBody ?? {}) as { articleCount?: number; networks?: string[] };
    const articleCount = Math.min(Math.max(body.articleCount ?? 2, 1), 5);
    const networks = body.networks as ['X', 'THREADS', 'FACEBOOK'] | undefined;
    const runId = await this.generationService.repurposeFromArticles(articleCount, networks);
    return { runId, status: 'started' };
  }

  @Post('recycle')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'F13: Content Recycling — regenerate old top posts with a fresh angle (evergreen revival)' })
  @ApiResponse({ status: 202, description: 'Recycling generation run started' })
  async recycle(@Body() rawBody: unknown) {
    const body = (rawBody ?? {}) as { minAgeDays?: number; postCount?: number; networks?: string[] };
    const minAgeDays = Math.min(Math.max(body.minAgeDays ?? 30, 7), 365);
    const postCount = Math.min(Math.max(body.postCount ?? 3, 1), 10);
    const networks = body.networks as ['X', 'THREADS', 'FACEBOOK'] | undefined;
    const runId = await this.generationService.recycleTopPosts(minAgeDays, postCount, networks);
    return { runId, status: 'started' };
  }

  @Get('runs')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List generation runs (most recent first)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max runs to return (default 20)' })
  @ApiResponse({ status: 200, description: 'List of generation runs with post counts' })
  async listRuns(@Query('limit') limit?: string) {
    return this.generationService.listRuns(limit ? Number.parseInt(limit, 10) : 20);
  }

  @Get('runs/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a generation run with its posts' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Generation run with posts' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async getRun(@Param('id') id: string) {
    const run = await this.generationService.getRun(id);
    if (!run) throw new NotFoundException(`Generation run ${id} not found`);
    return run;
  }

  // ── Sprint I: Resumability endpoints ──────────────────────────────────

  @Post('runs/:id/resume')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Sprint I: Resume an interrupted generation run from last checkpoint' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 202, description: 'Resume started' })
  async resumeRun(@Param('id') id: string) {
    return this.generationService.resumeRun(id);
  }

  @Post('runs/:id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sprint I: HITL — resume generation after human review of drafts' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Review applied, generation completed' })
  async resumeWithReview(
    @Param('id') id: string,
    @Body() body: { topic: string; approved: boolean; edits?: Record<string, string> },
  ) {
    return this.generationService.resumeWithReview(id, body.topic, body.approved, body.edits);
  }

  @Post('runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sprint I: Pause a running generation run' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'Run paused' })
  async pauseRun(@Param('id') id: string) {
    return this.generationService.pauseRun(id);
  }

  @Get('runs/:id/checkpoints')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sprint I: List checkpoints for a generation run' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'List of checkpoint IDs' })
  async listCheckpoints(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.generationService.listCheckpoints(id, limit ? Number.parseInt(limit, 10) : 10);
  }

  @Get('runs/:id/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sprint I: Get generation run state at a specific checkpoint' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'topic', required: true, type: String, description: 'Topic name (thread_id = runId:topic)' })
  @ApiQuery({ name: 'checkpointId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Graph state at checkpoint' })
  async getCheckpointState(
    @Param('id') id: string,
    @Query('topic') topic: string,
    @Query('checkpointId') checkpointId?: string,
  ) {
    return this.generationService.getCheckpointState(id, topic, checkpointId ?? '');
  }
}
