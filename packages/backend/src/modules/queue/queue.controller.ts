import { Controller, Get, Post, Param, ParseEnumPipe, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";
import { SocialNetwork } from "../../generated/prisma/client.js";
import { QueueService } from "./queue.service.js";
import { QueueTriageService } from "./queue-triage.service.js";

/**
 * Queue controller — inspect BullMQ job state per network + pause/resume (F5).
 * Used by the UI Queue page to show pending/active/failed jobs and control flow.
 *
 * Sprint Q: Added aggregated GET /stats (all networks) and POST /:network/retry-failed.
 * Sprint T: Added POST /triage and POST /:network/triage for LLM-in-the-loop queue triage.
 */
@ApiTags("queue")
@Controller("queue")
export class QueueController {
  constructor(
    private readonly queueService: QueueService,
    private readonly queueTriageService: QueueTriageService,
  ) {}

  @Get("stats")
  @ApiOperation({ summary: "Get aggregated BullMQ job counts for all networks (Sprint Q)" })
  @ApiResponse({ status: 200, description: "Array of per-network job counts with paused status" })
  async getAllStats() {
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const results = await Promise.all(
      networks.map(async (network) => {
        const counts = await this.queueService.getJobCounts(network);
        const paused = await this.queueService.isQueuePaused(network);
        return { network, ...counts, paused };
      }),
    );
    return results;
  }

  @Get("dashboard")
  @ApiOperation({ summary: "Queue dashboard: counts, failed samples, and triage summary (P2)" })
  @ApiResponse({ status: 200, description: "Aggregated queue dashboard" })
  async getDashboard() {
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];
    const perNetwork = await Promise.all(
      networks.map(async (network) => {
        const counts = await this.queueService.getJobCounts(network);
        const paused = await this.queueService.isQueuePaused(network);
        const failed = await this.queueService.getFailedJobs(network);
        return {
          network,
          counts,
          paused,
          failed,
        };
      }),
    );
    const totalFailed = perNetwork.reduce((sum, n) => sum + (n.counts.failed ?? 0), 0);
    const totalWaiting = perNetwork.reduce((sum, n) => sum + (n.counts.waiting ?? 0), 0);
    return {
      networks: perNetwork,
      summary: { totalFailed, totalWaiting },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get(":network/stats")
  @ApiOperation({ summary: "Get BullMQ job counts per network" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({
    status: 200,
    description: "Job counts: waiting, active, completed, failed, delayed",
  })
  async getStats(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return this.queueService.getJobCounts(network);
  }

  @Get(":network/failed")
  @ApiOperation({ summary: "List failed BullMQ jobs per network" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "List of failed jobs with error details" })
  async getFailed(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return this.queueService.getFailedJobs(network);
  }

  @Get(":network/paused")
  @ApiOperation({ summary: "Check if queue is paused (F5)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Boolean — whether the queue is currently paused" })
  async isPaused(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    return { paused: await this.queueService.isQueuePaused(network) };
  }

  @Post(":network/pause")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Pause queue for a network — stops new job processing (F5)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Queue paused" })
  async pause(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    await this.queueService.pauseQueue(network);
    return { paused: true, network };
  }

  @Post(":network/resume")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume a paused queue (F5)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Queue resumed" })
  async resume(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    await this.queueService.resumeQueue(network);
    return { paused: false, network };
  }

  @Post(":network/retry-failed")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Retry all failed jobs in a network queue (Sprint Q)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Number of jobs retried" })
  async retryFailed(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    const retried = await this.queueService.retryAllFailed(network);
    return { retried, network };
  }

  @Post(":network/clear-completed")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Clear completed jobs from a network queue (BullMQ dedup workaround)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Number of completed jobs cleared" })
  async clearCompleted(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    const cleared = await this.queueService.clearCompleted(network);
    return { cleared, network };
  }

  @Post("triage")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Run LLM triage on all enabled network queues (Sprint T)" })
  @ApiResponse({ status: 200, description: "Per-network triage results" })
  async triageAll() {
    const results = await this.queueTriageService.triageAll();
    return { results };
  }

  @Post(":network/triage")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Run LLM triage on a single network queue (Sprint T)" })
  @ApiParam({ name: "network", enum: ["X", "THREADS", "FACEBOOK"] })
  @ApiResponse({ status: 200, description: "Triage result for the network" })
  async triageNetwork(@Param("network", new ParseEnumPipe(SocialNetwork)) network: SocialNetwork) {
    const result = await this.queueTriageService.triageNetwork(network);
    return result;
  }
}
