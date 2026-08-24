/**
 * OrchestratorModule — LangGraph agent loop that replaces all crons.
 *
 * Conditional: only loaded when ORCHESTRATOR_ENABLED=true.
 * When false, the old cron-based scheduling is used instead.
 *
 * Components:
 *   - StateCollectorService: OBSERVE — collects WorldState from DB/Redis/services
 *   - DecisionEngineService: DECIDE — hard rules + LLM + guardrails (Phase 2)
 *   - ActionExecutorService: EXECUTE — dispatches to existing services (Phase 3)
 *   - OrchestratorService: lifecycle — start/stop the graph loop (Phase 4)
 *   - WatchdogCron: safety net — restarts orchestrator if heartbeat stale
 *   - OrchestratorController: REST endpoints for status/control (Phase 7)
 */

import { DynamicModule, Module } from "@nestjs/common";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { RateLimitModule } from "../rate-limit/rate-limit.module.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { NotificationsModule } from "../../infrastructure/notifications/notifications.module.js";
import { LlmModule } from "../../infrastructure/llm/llm.module.js";
import { CheckpointModule } from "../../infrastructure/checkpoint/checkpoint.module.js";
import { EngagementModule } from "../engagement/engagement.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { StateCollectorService } from "./state-collector.service.js";
import { PostingWindowModule } from "./posting-window.module.js";
import { HardRulesService } from "./hard-rules.service.js";
import { LlmDecisionService } from "./llm-decision.service.js";
import { NetworkSelector } from "./network-selector.js";
import { GuardrailsService } from "./guardrails.service.js";
import { RulesEngine } from "./rules-engine.js";
import { DecisionEngineService } from "./decision-engine.service.js";
import { ActionExecutorService } from "./action-executor.service.js";
import { OrchestratorHistoryService } from "./orchestrator-history.service.js";
import {
  GenerateTopicsHandler,
  GeneratePostsHandler,
  PostHandler,
  BrowseHandler,
  RecoverSessionHandler,
  CheckRepliesHandler,
  RefreshTrendsHandler,
  HealthCheckHandler,
  ReconcileHandler,
  TriageQueueHandler,
  ScrapeMetricsHandler,
  RecycleContentHandler,
  AggregateHooksHandler,
} from "./action-handlers.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { OrchestratorController } from "./orchestrator.controller.js";
import { WatchdogCron } from "./watchdog.cron.js";
import { EvaluationModule } from "../evaluation/evaluation.module.js";

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    RateLimitModule,
    FlowControlModule,
    QueueModule,
    NotificationsModule,
    LlmModule,
    CheckpointModule,
    AccountsModule,
    PostingWindowModule,
    EvaluationModule,
    // EventEmitter2 is provided globally by EventsEdaModule in app.module.ts
    // SseModule no longer needed — orchestrator emits domain events via EventEmitter2,
    // SseEventListener bridges them to SSE
  ],
  controllers: [OrchestratorController],
  providers: [
    StateCollectorService,
    HardRulesService,
    LlmDecisionService,
    NetworkSelector,
    GuardrailsService,
    RulesEngine,
    DecisionEngineService,
    // Action handlers (X18 strategy pattern)
    GenerateTopicsHandler,
    GeneratePostsHandler,
    PostHandler,
    BrowseHandler,
    RecoverSessionHandler,
    CheckRepliesHandler,
    RefreshTrendsHandler,
    HealthCheckHandler,
    ReconcileHandler,
    TriageQueueHandler,
    ScrapeMetricsHandler,
    RecycleContentHandler,
    AggregateHooksHandler,
    ActionExecutorService,
    OrchestratorHistoryService,
    OrchestratorService,
    WatchdogCron,
  ],
  exports: [
    StateCollectorService,
    DecisionEngineService,
    ActionExecutorService,
    OrchestratorService,
  ],
})
export class OrchestratorModule {
  /**
   * AppModule owns bootstrap-time feature flags. Keeping the conditional import
   * here as a dynamic-module option avoids a second process.env read in the
   * orchestrator module while preserving the optional engagement wiring.
   */
  static forRoot(engagementEnabled: boolean): DynamicModule {
    return {
      module: OrchestratorModule,
      imports: engagementEnabled ? [EngagementModule] : [],
    };
  }
}
