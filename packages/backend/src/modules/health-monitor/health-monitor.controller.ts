import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AdminGuard } from "../auth/admin.guard";
import {
  HealthMonitorService,
  type HealthReport,
  type HealthSummary,
} from "./health-monitor.service";

/**
 * F21: Account Health Monitor — dashboard + manual trigger endpoints.
 */
@UseGuards(AdminGuard)
@ApiTags("health-monitor")
@Controller("health-monitor")
export class HealthMonitorController {
  constructor(private readonly healthMonitorService: HealthMonitorService) {}

  @Get("dashboard")
  @ApiOperation({ summary: "F21: Health dashboard — sessions, posts, queues, alerts" })
  @ApiResponse({ status: 200, description: "Health dashboard with summary" })
  async getDashboard(): Promise<HealthReport & { summary: HealthSummary }> {
    return this.healthMonitorService.getDashboard(true);
  }

  @Post("check")
  @ApiOperation({ summary: "F21: Trigger manual health check" })
  @ApiResponse({ status: 200, description: "Health check report" })
  async runCheck(): Promise<HealthReport> {
    return this.healthMonitorService.runHealthCheck();
  }

  @Post("reconcile")
  @ApiOperation({
    summary: "B3: Trigger manual reconciliation — re-enqueue orphaned APPROVED posts",
  })
  @ApiResponse({ status: 200, description: "Reconciliation result" })
  async runReconciliation(): Promise<{ requeued: number; skipped: number }> {
    return this.healthMonitorService.runReconciliation();
  }

  @Post("reap-stuck-browsing")
  @ApiOperation({
    summary: "Force-reap stuck ACTIVE browsing sessions and release the engagement lock",
  })
  @ApiResponse({ status: 200, description: "Stuck browsing sessions reaped" })
  async reapStuckBrowsing(): Promise<{ reaped: number }> {
    return this.healthMonitorService.reapStuckBrowsingSessions();
  }
}
