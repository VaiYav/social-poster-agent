// Engagement module — wires up engagement service, browsing session service,
// engagers, human behavior engine, targeting, scheduler, and controller.

import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module.js';
import { SseModule } from '../../infrastructure/sse/sse.module.js';
import { LlmModule } from '../../infrastructure/llm/llm.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WarmupModule } from '../sessions/warmup.module.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { EngagementService } from './engagement.service.js';
import { BrowsingSessionService } from './browsing-session.service.js';
import { EngagementController } from './engagement.controller.js';
import { XEngager } from './engagers/x.engager.js';
import { ThreadsEngager } from './engagers/threads.engager.js';
import { FacebookEngager } from './engagers/facebook.engager.js';
import { HumanBehaviorEngine } from './human-behavior-engine.js';
import { EngagementDecisionService } from './engagement-decision.service.js';
import { TargetingService } from './targeting.service.js';
import { EngagementSchedulerService } from './engagement-scheduler.service.js';
import { IEngagementDecisionPort } from '../../domain/ports/engagement-decision.port.js';

@Module({
  imports: [
    BrowserModule,
    SseModule,
    LlmModule,
    AccountsModule,
    SessionsModule,
    WarmupModule,
    RateLimitModule,
    QueueModule,
    PrismaModule,
  ],
  providers: [
    EngagementService,
    BrowsingSessionService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
    HumanBehaviorEngine,
    TargetingService,
    EngagementSchedulerService,
    {
      provide: IEngagementDecisionPort,
      useClass: EngagementDecisionService,
    },
  ],
  controllers: [EngagementController],
  exports: [EngagementService, BrowsingSessionService, EngagementSchedulerService],
})
export class EngagementModule {}
