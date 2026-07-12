import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthMonitorService, type HealthReport, type HealthSummary } from './health-monitor.service';

/**
 * F21: Account Health Monitor — dashboard + manual trigger endpoints.
 */
@ApiTags('health-monitor')
@Controller('health-monitor')
export class HealthMonitorController {
  constructor(private readonly healthMonitorService: HealthMonitorService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'F21: Health dashboard — sessions, posts, queues, alerts' })
  @ApiResponse({ status: 200, description: 'Health dashboard with summary' })
  async getDashboard(): Promise<HealthReport & { summary: HealthSummary }> {
    return this.healthMonitorService.getDashboard(true);
  }

  @Post('check')
  @ApiOperation({ summary: 'F21: Trigger manual health check' })
  @ApiResponse({ status: 200, description: 'Health check report' })
  async runCheck(): Promise<HealthReport> {
    return this.healthMonitorService.runHealthCheck();
  }

  @Post('reconcile')
  @ApiOperation({ summary: 'B3: Trigger manual reconciliation — re-enqueue orphaned APPROVED posts' })
  @ApiResponse({ status: 200, description: 'Reconciliation result' })
  async runReconciliation(): Promise<{ requeued: number; skipped: number }> {
    return this.healthMonitorService.runReconciliation();
  }
}
