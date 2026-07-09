/**
 * Sprint O / F6: Analytics Module.
 * F6 complete: read-only dashboard + metrics scraping cron.
 */
import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { MetricsScraperService } from './metrics-scraper.service';
import { ABTestService } from './ab-test.service';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { ContentEnhancementsModule } from '../content-enhancements/content-enhancements.module';

@Module({
  imports: [PrismaModule, BrowserModule, SseModule, ContentEnhancementsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, MetricsScraperService, ABTestService],
  exports: [AnalyticsService, MetricsScraperService, ABTestService],
})
export class AnalyticsModule {}
