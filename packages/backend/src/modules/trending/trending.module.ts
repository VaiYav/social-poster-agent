import { Module } from '@nestjs/common';
import { TrendingService } from './trending.service';
import { TrendingScraperService } from './trending-scraper.service';
import { TrendingController } from './trending.controller';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { LlmModule } from '../../infrastructure/llm/llm.module';

@Module({
  imports: [BrowserModule, LlmModule],
  providers: [TrendingService, TrendingScraperService],
  controllers: [TrendingController],
  exports: [TrendingService, TrendingScraperService],
})
export class TrendingModule {}
