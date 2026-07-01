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

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { FlowControlModule } from '../flow-control/flow-control.module';
import { QueueModule } from '../queue/queue.module';
import { NotificationsModule } from '../../infrastructure/notifications/notifications.module';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { CheckpointModule } from '../../infrastructure/checkpoint/checkpoint.module';
import { StateCollectorService } from './state-collector.service.js';
import { PostingWindowService } from './posting-window.service.js';
import { DecisionEngineService } from './decision-engine.service.js';
import { ActionExecutorService } from './action-executor.service.js';
import { OrchestratorService } from './orchestrator.service.js';
import { OrchestratorController } from './orchestrator.controller.js';
import { WatchdogCron } from './watchdog.cron.js';

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
    // EventEmitter2 is provided globally by EventsEdaModule in app.module.ts
    // SseModule no longer needed — orchestrator emits domain events via EventEmitter2,
    // SseEventListener bridges them to SSE
  ],
  controllers: [OrchestratorController],
  providers: [
    StateCollectorService,
    PostingWindowService,
    DecisionEngineService,
    ActionExecutorService,
    OrchestratorService,
    WatchdogCron,
  ],
  exports: [StateCollectorService, DecisionEngineService, ActionExecutorService, OrchestratorService],
})
export class OrchestratorModule {}
