import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SseService } from '../../infrastructure/sse/sse.service';

/**
 * Events controller — SSE endpoint for real-time post status updates.
 *
 * UI connects: GET /events/sse
 * Content-Type: text/event-stream
 *
 * Events:
 * - { type: 'connected', clientId }
 * - { type: 'post_status', postId, status, network, url?, error? }
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly sseService: SseService) {}

  @Get('sse')
  @ApiOperation({ summary: 'SSE stream for real-time post status updates' })
  sse(@Req() req: Request, @Res() res: Response): void {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();

    const clientId = this.sseService.addClient(res, req.ip);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      if (clientId) this.sseService.touchClient(clientId);
      res.write(': heartbeat\n\n');
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      if (clientId) this.sseService.removeClient(clientId);
    });
  }
}
