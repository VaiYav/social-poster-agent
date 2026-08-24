/**
 * Sprint O / F6: Analytics Module.
 * F6 complete: read-only dashboard + metrics scraping cron.
 */
import { Module } from "@nestjs/common";
import { AnalyticsService } from "./analytics.service.js";
import { AnalyticsController } from "./analytics.controller.js";
import { MetricsScraperService } from "./metrics-scraper.service.js";
import { ABTestService } from "./ab-test.service.js";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { ContentEnhancementsModule } from "../content-enhancements/content-enhancements.module.js";
import { EvaluationModule } from "../evaluation/evaluation.module.js";

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BrowserModule,
    SseModule,
    ContentEnhancementsModule,
    EvaluationModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, MetricsScraperService, ABTestService],
  exports: [AnalyticsService, MetricsScraperService, ABTestService],
})
export class AnalyticsModule {}
