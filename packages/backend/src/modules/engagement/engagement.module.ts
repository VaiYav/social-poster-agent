// Engagement module — wires up engagement service, browsing session service,
// engagers, and controller.

import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module.js';
import { SseModule } from '../../infrastructure/sse/sse.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { EngagementService } from './engagement.service.js';
import { BrowsingSessionService } from './browsing-session.service.js';
import { EngagementController } from './engagement.controller.js';
import { XEngager } from './engagers/x.engager.js';
import { ThreadsEngager } from './engagers/threads.engager.js';
import { FacebookEngager } from './engagers/facebook.engager.js';

@Module({
  imports: [
    BrowserModule,
    SseModule,
    AccountsModule,
    SessionsModule,
    RateLimitModule,
    PrismaModule,
  ],
  providers: [
    EngagementService,
    BrowsingSessionService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
  ],
  controllers: [EngagementController],
  exports: [EngagementService, BrowsingSessionService],
})
export class EngagementModule {}
