/**
 * OrchestratorController — REST endpoints for orchestrator status + control.
 *
 * Endpoints:
 *   GET    /api/v1/orchestrator/status   — current status (enabled, running, heartbeat)
 *   GET    /api/v1/orchestrator/history  — action history (last N cycles)
 *   POST   /api/v1/orchestrator/pause    — pause all flows (kill switch)
 *   POST   /api/v1/orchestrator/resume   — resume all flows
 *   POST   /api/v1/orchestrator/restart  — restart orchestrator (stop + start)
 *   POST   /api/v1/orchestrator/reset    — reset checkpoint (fresh start)
 */

import { Controller, Get, Post, Query, Logger } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service.js';
import { FlowControlService } from '../flow-control/flow-control.service.js';

@Controller('orchestrator')
export class OrchestratorController {
  private readonly logger = new Logger(OrchestratorController.name);

  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly flowControlService: FlowControlService,
  ) {}

  @Get('status')
  async getStatus() {
    return this.orchestratorService.getStatus();
  }

  @Get('history')
  async getHistory(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 50;
    const n = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 200)) : 50;
    return this.orchestratorService.getHistory(n);
  }

  @Post('pause')
  async pause() {
    await this.flowControlService.pauseAll('Manual pause via orchestrator API');
    this.logger.log('Orchestrator paused via API');
    return { success: true, message: 'All flows paused' };
  }

  @Post('resume')
  async resume() {
    await this.flowControlService.resumeAll();
    this.logger.log('Orchestrator resumed via API');
    return { success: true, message: 'All flows resumed' };
  }

  @Post('restart')
  async restart() {
    this.logger.log('Orchestrator restart requested via API');
    await this.orchestratorService.stop();
    await new Promise((r) => setTimeout(r, 3000));
    await this.orchestratorService.start();
    return { success: true, message: 'Orchestrator restarted' };
  }

  @Post('reset')
  async resetCheckpoint() {
    await this.orchestratorService.resetCheckpoint();
    this.logger.log('Orchestrator checkpoint reset via API');
    return { success: true, message: 'Checkpoint reset — next restart will begin fresh' };
  }
}
