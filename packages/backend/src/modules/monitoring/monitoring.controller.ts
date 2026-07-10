/**
 * Monitoring REST API — full-system snapshot for the real-time dashboard.
 *
 * GET /api/v1/monitoring/snapshot returns the latest published metrics snapshot.
 * If the snapshot has not been collected yet, it triggers a collection synchronously.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetricsPublisher, type MonitoringSnapshot } from './metrics-publisher';

@ApiTags('monitoring')
@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly metricsPublisher: MetricsPublisher) {}

  @Get('snapshot')
  @ApiOperation({ summary: 'Get the latest full-system metrics snapshot' })
  @ApiResponse({ status: 200, description: 'Monitoring snapshot with all agents' })
  @ApiResponse({ status: 503, description: 'Snapshot not yet available' })
  async getSnapshot(): Promise<MonitoringSnapshot> {
    let snapshot = this.metricsPublisher.getLatestSnapshot();
    if (!snapshot) {
      snapshot = await this.metricsPublisher.collectSnapshot();
    }
    return snapshot;
  }

  @Get('agents')
  @ApiOperation({ summary: 'Alias for /monitoring/snapshot' })
  async getAgents(): Promise<MonitoringSnapshot> {
    return this.getSnapshot();
  }
}
