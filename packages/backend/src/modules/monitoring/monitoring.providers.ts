import { OptionalFactoryDependency } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { HealthMonitorService } from '../health-monitor/health-monitor.service';
import { QueueService } from '../queue/queue.service';
import { SessionsService } from '../sessions/sessions.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { TrendingScraperService } from '../trending/trending-scraper.service';
import { FlowControlService } from '../flow-control/flow-control.service';
import { GenerationService } from '../generation/generation.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { MetricsPublisher } from './metrics-publisher.js';
import { IMetricsCollector } from './metrics-collector.js';
import {
  AnalyticsMetricsCollector,
  EngagementMetricsCollector,
  FlowControlMetricsCollector,
  GenerationMetricsCollector,
  HealthMetricsCollector,
  LlmMetricsCollector,
  OrchestratorMetricsCollector,
  PostingMetricsCollector,
  QueueMetricsCollector,
  RateLimitsMetricsCollector,
  RepliesMetricsCollector,
  SessionsMetricsCollector,
  TrendingMetricsCollector,
} from './collectors.js';

/**
 * Collector registry provider.
 *
 * NestJS does not support Angular-style `multi` providers, so we build the
 * `IMetricsCollector[]` array explicitly in a `useFactory`. The factory is
 * injected with every collector's runtime dependency (all optional services are
 * declared as `{ token, optional: true }` so missing modules do not fail
 * bootstrap). This keeps `MetricsPublisher` itself free of concrete collector
 * knowledge while still being safe under esbuild/vitest (which strips
 * `design:paramtypes` for the collector classes).
 */
export const metricsPublisherProviders = [
  MetricsPublisher,
  {
    provide: IMetricsCollector,
    useFactory: (
      health: HealthMonitorService,
      queue: QueueService,
      sessions: SessionsService,
      rateLimit: RateLimitService,
      analytics: AnalyticsService,
      trending: TrendingScraperService,
      llm: LlmService,
      flowControl: FlowControlService,
      orchestrator: OrchestratorService | undefined,
      prisma: PrismaService,
      generation: GenerationService,
    ): IMetricsCollector[] => [
      new HealthMetricsCollector(health),
      new QueueMetricsCollector(queue),
      new SessionsMetricsCollector(sessions),
      new RateLimitsMetricsCollector(rateLimit),
      new AnalyticsMetricsCollector(analytics),
      new TrendingMetricsCollector(trending),
      new LlmMetricsCollector(llm),
      new FlowControlMetricsCollector(flowControl),
      ...(orchestrator ? [new OrchestratorMetricsCollector(orchestrator)] : []),
      new EngagementMetricsCollector(prisma),
      new RepliesMetricsCollector(prisma),
      new GenerationMetricsCollector(prisma),
      new PostingMetricsCollector(prisma),
    ],
    inject: [
      HealthMonitorService,
      QueueService,
      SessionsService,
      RateLimitService,
      AnalyticsService,
      TrendingScraperService,
      LlmService,
      FlowControlService,
      { token: OrchestratorService, optional: true } as OptionalFactoryDependency,
      PrismaService,
      GenerationService,
    ],
  },
];
