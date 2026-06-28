/**
 * Sprint O: Shared paramtypes restoration for new feature modules.
 *
 * All e2e/system/integration tests that instantiate the full AppModule need
 * to restore esbuild paramtypes metadata for the new Sprint O services.
 * This helper avoids duplicating the same block in every test file.
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

export function defineParamtypes(target: unknown, types: unknown[]): void {
  Reflect.defineMetadata('design:paramtypes', types, target);
}

/**
 * Restore paramtypes for all Sprint O services.
 * Call this after the test file's own paramtypes restoration block.
 */
export async function restoreSprintOParamtypes(
  defineFn: (target: unknown, types: unknown[]) => void,
  PrismaService: unknown,
): Promise<void> {
  const CaptchaSolverService = (await import('../../src/infrastructure/captcha/captcha-solver.service.js')).CaptchaSolverService;
  const ProxyRotationService = (await import('../../src/infrastructure/proxy/proxy-rotation.service.js')).ProxyRotationService;
  const AnalyticsService = (await import('../../src/modules/analytics/analytics.service.js')).AnalyticsService;
  const AnalyticsController = (await import('../../src/modules/analytics/analytics.controller.js')).AnalyticsController;
  const RecyclingService = (await import('../../src/modules/recycling/recycling.service.js')).RecyclingService;
  const RecyclingController = (await import('../../src/modules/recycling/recycling.controller.js')).RecyclingController;
  const QuoteCardService = (await import('../../src/modules/quote-cards/quote-card.service.js')).QuoteCardService;
  const QuoteCardController = (await import('../../src/modules/quote-cards/quote-card.controller.js')).QuoteCardController;
  const RepliesService = (await import('../../src/modules/replies/replies.service.js')).RepliesService;
  const AccountsService = (await import('../../src/modules/accounts/accounts.service.js')).AccountsService;
  const MetricsScraperService = (await import('../../src/modules/analytics/metrics-scraper.service.js')).MetricsScraperService;
  const SseService = (await import('../../src/infrastructure/sse/sse.service.js')).SseService;
  const FlowControlService = (await import('../../src/modules/flow-control/flow-control.service.js')).FlowControlService;
  const PostsService = (await import('../../src/modules/posts/posts.service.js')).PostsService;
  const AutoCheckService = (await import('../../src/modules/autonomy/auto-check.service.js')).AutoCheckService;
  const AutoApproveService = (await import('../../src/modules/autonomy/auto-approve.service.js')).AutoApproveService;
  const AutonomousRunnerService = (await import('../../src/modules/autonomy/autonomous-runner.service.js')).AutonomousRunnerService;
  const AutoApproveListener = (await import('../../src/events/listeners/auto-approve.listener.js')).AutoApproveListener;

  defineFn(CaptchaSolverService, [ConfigService]);
  defineFn(ProxyRotationService, [ConfigService]);
  defineFn(AnalyticsService, [PrismaService]);
  defineFn(AnalyticsController, [AnalyticsService]);
  defineFn(MetricsScraperService, [PrismaService, SseService, Object]);
  defineFn(RecyclingService, [PrismaService]);
  defineFn(RecyclingController, [RecyclingService]);
  defineFn(QuoteCardService, [ConfigService]);
  defineFn(QuoteCardController, [QuoteCardService]);
  defineFn(RepliesService, [PrismaService, ConfigService, AccountsService]);

  // ADR-006 autonomy services (added to the AppModule graph; their paramtypes were missing
  // here, so esbuild-stripped metadata left `configService` undefined → full-app boot failure
  // in system/integration/acceptance/e2e specs — audit D3).
  defineFn(AutoCheckService, [ConfigService, PrismaService]);
  defineFn(AutoApproveService, [ConfigService, PrismaService, SseService, AutoCheckService]);
  defineFn(AutonomousRunnerService, [ConfigService, PrismaService, SseService, FlowControlService, AutoApproveService, ModuleRef]);
  defineFn(AutoApproveListener, [PostsService, PrismaService, ModuleRef, ConfigService]);
}
