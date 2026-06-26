import { Controller, Post, Body, Get, Param, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { GenerationService } from './generation.service';
import { GeneratePostsDtoSchema, type GeneratePostsDto } from '../../domain/dtos';
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
    const runId = await this.generationService.generate(
      dto.count,
      dto.networks,
      GenerationTrigger.MANUAL,
    );
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
}
