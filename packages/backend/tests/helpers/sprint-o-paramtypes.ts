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
  const { SchedulerRegistry } = await import('@nestjs/schedule');
  const CaptchaSolverService = (await import('../../src/infrastructure/captcha/captcha-solver.service.js')).CaptchaSolverService;
  const ProxyRotationService = (await import('../../src/infrastructure/proxy/proxy-rotation.service.js')).ProxyRotationService;
  const AnalyticsService = (await import('../../src/modules/analytics/analytics.service.js')).AnalyticsService;
  const AnalyticsController = (await import('../../src/modules/analytics/analytics.controller.js')).AnalyticsController;
  const RecyclingService = (await import('../../src/modules/recycling/recycling.service.js')).RecyclingService;
  const GenerationService = (await import('../../src/modules/generation/generation.service.js')).GenerationService;
  const RecyclingController = (await import('../../src/modules/recycling/recycling.controller.js')).RecyclingController;
  const QuoteCardService = (await import('../../src/modules/quote-cards/quote-card.service.js')).QuoteCardService;
  const QuoteCardController = (await import('../../src/modules/quote-cards/quote-card.controller.js')).QuoteCardController;
  const AccountsService = (await import('../../src/modules/accounts/accounts.service.js')).AccountsService;
  const MetricsScraperService = (await import('../../src/modules/analytics/metrics-scraper.service.js')).MetricsScraperService;
  const SseService = (await import('../../src/infrastructure/sse/sse.service.js')).SseService;
  const FlowControlService = (await import('../../src/modules/flow-control/flow-control.service.js')).FlowControlService;
  const PostsService = (await import('../../src/modules/posts/posts.service.js')).PostsService;
  const AutoCheckService = (await import('../../src/modules/autonomy/auto-check.service.js')).AutoCheckService;
  const AutoApproveService = (await import('../../src/modules/autonomy/auto-approve.service.js')).AutoApproveService;
  const AutonomousRunnerService = (await import('../../src/modules/autonomy/autonomous-runner.service.js')).AutonomousRunnerService;
  const AutoApproveListener = (await import('../../src/events/listeners/auto-approve.listener.js')).AutoApproveListener;
  // Auth module (JWT cookie auth) — added to AppModule; esbuild strips paramtypes
  // so JwtService/ConfigService would be undefined without restoration.
  const AuthService = (await import('../../src/modules/auth/auth.service.js')).AuthService;
  const AuthController = (await import('../../src/modules/auth/auth.controller.js')).AuthController;
  const JwtAuthGuard = (await import('../../src/modules/auth/jwt-auth.guard.js')).JwtAuthGuard;
  const JwtService = (await import('@nestjs/jwt')).JwtService;

  defineFn(CaptchaSolverService, [ConfigService]);
  defineFn(ProxyRotationService, [ConfigService]);
  defineFn(AnalyticsService, [PrismaService]);
  defineFn(AnalyticsController, [AnalyticsService]);
  defineFn(MetricsScraperService, [PrismaService, SseService, SchedulerRegistry, Object]);
  defineFn(RecyclingService, [PrismaService, GenerationService]);
  defineFn(RecyclingController, [RecyclingService]);
  defineFn(QuoteCardService, [ConfigService]);
  defineFn(QuoteCardController, [QuoteCardService]);

  // ADR-006 autonomy services (added to the AppModule graph; their paramtypes were missing
  // here, so esbuild-stripped metadata left `configService` undefined → full-app boot failure
  // in system/integration/acceptance/e2e specs — audit D3).
  defineFn(AutoCheckService, [PrismaService]);
  defineFn(AutoApproveService, [ConfigService, PrismaService, SseService, AutoCheckService]);
  defineFn(AutonomousRunnerService, [ConfigService, PrismaService, SseService, FlowControlService, AutoApproveService, ModuleRef, Object]);
  defineFn(AutoApproveListener, [PostsService, PrismaService, ModuleRef, ConfigService, Object]);

  // Auth module — AuthService(Prisma, Jwt, Config), AuthController(Auth, Config), JwtAuthGuard(Jwt, Config)
  defineFn(AuthService, [PrismaService, JwtService, ConfigService]);
  defineFn(AuthController, [AuthService, ConfigService]);
  defineFn(JwtAuthGuard, [JwtService, ConfigService]);

  // DbContentReader stack — TopicGenerationService was added to AppModule without a
  // restore entry here, so `configService` resolved to undefined and EVERY full-app
  // spec failed at boot (pre-existing drift, fixed in the quality pass).
  const TopicGenerationService = (await import('../../src/infrastructure/content/topic-generation.service.js')).TopicGenerationService;
  const LlmService = (await import('../../src/infrastructure/llm/llm.service.js')).LlmService;
  defineFn(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService]);
}
