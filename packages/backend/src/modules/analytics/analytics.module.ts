/**
 * Sprint O / F6: Analytics Module.
 * F6 complete: read-only dashboard + metrics scraping cron.
 */
import { Module, Optional } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { MetricsScraperService } from './metrics-scraper.service';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { ContentEnhancementsModule } from '../content-enhancements/content-enhancements.module';
import { HookPerformanceBank } from '../content-enhancements/hook-performance-bank';

@Module({
  imports: [PrismaModule, BrowserModule, SseModule, ContentEnhancementsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, MetricsScraperService],
  exports: [AnalyticsService, MetricsScraperService],
})
export class AnalyticsModule {}
