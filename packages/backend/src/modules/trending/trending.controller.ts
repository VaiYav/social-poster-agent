import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TrendingService } from './trending.service';
import { TrendingScraperService } from './trending-scraper.service';
import { LocalhostGuard } from '../../infrastructure/guards/localhost.guard';

@ApiTags('trending')
@Controller('trending')
export class TrendingController {
  constructor(
    private readonly trendingService: TrendingService,
    private readonly scraperService: TrendingScraperService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F22: Get all configured trending events with status' })
  @ApiResponse({ status: 200, description: 'List of all known events with trending status' })
  async getAll() {
    return this.trendingService.getTrendingTopics();
  }

  @Get('active')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F22: Get currently trending topics (within event window)' })
  @ApiResponse({ status: 200, description: 'List of currently trending topics' })
  async getActive() {
    return this.trendingService.getActiveTrending();
  }

  @Get('next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F22: Get the next upcoming trending topic' })
  @ApiResponse({ status: 200, description: 'Next upcoming trending topic or null' })
  async getNext() {
    return this.trendingService.getNextUpcoming();
  }

  // ── Item 38: Google Trends + X scraping endpoints ──

  @Get('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F22/Item 38: Get Google Trends daily trending searches (RSS feed)' })
  @ApiResponse({ status: 200, description: 'List of Google Trends trending topics' })
  async getGoogleTrends() {
    return this.scraperService.getGoogleTrends(20);
  }

  @Get('x')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LocalhostGuard) // Triggers browser scrape — restrict to localhost
  @ApiOperation({ summary: 'F22/Item 38: Get X (Twitter) trending topics (browser scrape)' })
  @ApiResponse({ status: 200, description: 'List of X trending topics scraped via browser' })
  async getXTrends() {
    return this.scraperService.getXTrends(20);
  }

  @Get('merged')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LocalhostGuard) // Triggers browser scrape (X trends) — restrict to localhost
  @ApiOperation({ summary: 'F22/Item 38: Get merged trending topics from all sources (events + Google + X)' })
  @ApiResponse({ status: 200, description: 'Merged and prioritized trending topics from all sources' })
  async getMerged() {
    const active = this.trendingService.getActiveTrending();
    const eventTopics = active.map((t) => ({ topic: t.topic, networks: t.networks }));
    return this.scraperService.getMergedTrending(eventTopics);
  }

  @Get('cache-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F22/Item 38: Get trending scraper cache status' })
  @ApiResponse({ status: 200, description: 'Cache status for Google Trends and X Trends' })
  async getCacheStatus() {
    return this.scraperService.getCacheStatus();
  }
}
