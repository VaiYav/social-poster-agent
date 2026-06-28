/**
 * ADR-006: Flow Control Controller — REST API for pause/resume.
 *
 * Endpoints:
 *   GET    /api/v1/flow-control/status        — get all flow statuses
 *   POST   /api/v1/flow-control/pause/:flow   — pause a specific flow
 *   POST   /api/v1/flow-control/resume/:flow  — resume a specific flow
 *   POST   /api/v1/flow-control/pause-all     — crisis mode: pause everything
 *   POST   /api/v1/flow-control/resume-all    — resume everything
 */
import { Controller, Get, Post, Param, Body, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { FlowControlService, type FlowName } from './flow-control.service';
import { z } from 'zod';

const reasonSchema = z.object({
  reason: z.string().max(500).optional(),
});

const VALID_FLOWS: FlowName[] = ['generation', 'posting', 'engagement', 'replies'];

function parseFlow(flow: string): FlowName {
  if (!VALID_FLOWS.includes(flow as FlowName)) {
    throw new BadRequestException(`Invalid flow '${flow}'. Valid: ${VALID_FLOWS.join(', ')}`);
  }
  return flow as FlowName;
}

@Controller('flow-control')
export class FlowControlController {
  constructor(private readonly flowControl: FlowControlService) {}

  @Get('status')
  async getStatus() {
    return this.flowControl.getStatus();
  }

  @Post('pause/:flow')
  @HttpCode(HttpStatus.OK)
  async pause(@Param('flow') flow: string, @Body() body: unknown) {
    const parsed = reasonSchema.safeParse(body);
    await this.flowControl.pause(parseFlow(flow), parsed.success ? parsed.data.reason : undefined);
    return { success: true, flow, paused: true };
  }

  @Post('resume/:flow')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('flow') flow: string) {
    await this.flowControl.resume(parseFlow(flow));
    return { success: true, flow, paused: false };
  }

  @Post('pause-all')
  @HttpCode(HttpStatus.OK)
  async pauseAll(@Body() body: unknown) {
    const parsed = reasonSchema.safeParse(body);
    await this.flowControl.pauseAll(parsed.success ? parsed.data.reason : undefined);
    return { success: true, paused: true };
  }

  @Post('resume-all')
  @HttpCode(HttpStatus.OK)
  async resumeAll() {
    await this.flowControl.resumeAll();
    return { success: true, paused: false };
  }
}
