import { Controller, Get, Post, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all browser sessions with status' })
  @ApiResponse({ status: 200, description: 'List of sessions per network' })
  async findAll() {
    return this.sessionsService.findAll();
  }

  @Post('health-check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run health check on a session (verifies browser session is still valid)' })
  @ApiQuery({ name: 'network', required: true, enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiResponse({ status: 200, description: 'Health check result' })
  async healthCheck(@Query('network') network: 'X' | 'THREADS' | 'FACEBOOK') {
    return this.sessionsService.healthCheck(network);
  }
}
