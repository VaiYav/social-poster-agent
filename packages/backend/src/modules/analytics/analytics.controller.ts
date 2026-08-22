/**
 * Sprint O / F6: Analytics Controller — REST endpoints for analytics dashboard.
 * F6 complete: summary + top posts + per-post metrics + manual scrape trigger.
 */
import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Optional,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { MetricsScraperService } from "./metrics-scraper.service";
import { ABTestService } from "./ab-test.service";
import { ABTestQuerySchema, type ABTestQuery } from "../../domain/dtos.js";
import { HookPerformanceBank } from "../content-enhancements/hook-performance-bank.js";

@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly metricsScraper: MetricsScraperService,
    private readonly abTestService: ABTestService,
    @Optional() private readonly hookBank?: HookPerformanceBank,
  ) {}

  @Get("summary")
  @ApiOperation({
    summary: "Get overall analytics summary (posts, success rate, network breakdown)",
  })
  getSummary() {
    return this.analyticsService.getSummary();
  }

  @Get("report")
  @ApiOperation({ summary: "Generate a full performance report for a date range" })
  @ApiQuery({
    name: "range",
    required: false,
    type: String,
    description: "Date range: 7d, 30d, 90d",
  })
  async getReport(@Query("range") range?: string) {
    const validRange = range === "7d" || range === "30d" || range === "90d" ? range : "30d";
    return this.analyticsService.generateReport(validRange);
  }

  @Get("autonomous")
  @ApiOperation({ summary: "Get autonomous decision and quality distribution stats" })
  async getAutonomousStats() {
    return this.analyticsService.getAutonomousStats();
  }

  @Get("top-posts")
  @ApiOperation({ summary: "Get top performing posts" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Max posts to return (default: 10, max: 50)",
  })
  getTopPosts(@Query("limit") limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 10, 50) : 10;
    return this.analyticsService.getTopPosts(n);
  }

  @Get("metrics/:postId")
  @ApiOperation({ summary: "F6: Get latest engagement metrics for a specific post" })
  @ApiResponse({ status: 200, description: "Latest metrics snapshot for the post" })
  getPostMetrics(@Param("postId") postId: string) {
    return this.metricsScraper.getLatestMetricsForPost(postId);
  }

  @Get("metrics/:postId/history")
  @ApiOperation({ summary: "F6: Get metrics time-series history for a post" })
  getPostMetricsHistory(@Param("postId") postId: string) {
    return this.metricsScraper.getMetricsHistory(postId);
  }

  @Get("ab-tests")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "P7: Get A/B test results by topic and network" })
  @ApiQuery({
    name: "days",
    required: false,
    type: Number,
    description: "Lookback period in days (default: 30, max: 365)",
  })
  @ApiQuery({
    name: "network",
    required: false,
    enum: ["X", "THREADS", "FACEBOOK"],
    description: "Filter by social network",
  })
  @ApiQuery({
    name: "minSampleSize",
    required: false,
    type: Number,
    description: "Minimum samples for a variant to be eligible as winner (default: 0)",
  })
  @ApiResponse({
    status: 200,
    description: "A/B test results with per-variant engagement averages",
  })
  async getAbTests(@Query() rawQuery: unknown) {
    const query = this.parseAbTestQuery(rawQuery);
    return this.abTestService.getAbTests(query);
  }

  private parseAbTestQuery(rawQuery: unknown): ABTestQuery {
    const { days, network, minSampleSize } = ABTestQuerySchema.parse(rawQuery);
    return { days, network, minSampleSize };
  }

  @Post("scrape")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "F6: Manually trigger metrics scraping (collects engagement from posted content)",
  })
  @ApiResponse({ status: 200, description: "Scraping result with collected/failed/skipped counts" })
  async triggerScrape() {
    return this.metricsScraper.collectMetrics();
  }

  // ── ADR-006 / Quality Feedback Loop: Hook Performance ──

  @Get("hook-performance")
  @ApiOperation({ summary: "QFL: Get hook performance stats per network (quality + engagement)" })
  @ApiResponse({
    status: 200,
    description: "Hook performance stats with quality scores and engagement metrics",
  })
  async getHookPerformance() {
    if (!this.hookBank) {
      return { networks: {}, lastUpdated: null, error: "HookPerformanceBank not available" };
    }
    return this.hookBank.getStats();
  }

  @Post("hook-performance/aggregate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "QFL: Manually trigger hook performance aggregation" })
  @ApiResponse({ status: 200, description: "Aggregation triggered successfully" })
  async triggerHookAggregation() {
    if (!this.hookBank) {
      return { success: false, error: "HookPerformanceBank not available" };
    }
    await this.hookBank.aggregateStats();
    return { success: true };
  }
}
