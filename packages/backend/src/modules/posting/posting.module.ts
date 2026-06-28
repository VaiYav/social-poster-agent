import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { CryptoModule } from '../../infrastructure/crypto/crypto.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WarmupModule } from '../sessions/warmup.module';
import { PostsModule } from '../posts/posts.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { FlowControlModule } from '../flow-control/flow-control.module';
import { PostingService } from './posting.service';
import { PostingController } from './posting.controller';
import { ThreadProgressService } from './thread-progress.service';
import { XPoster } from './posters/x.poster';
import { ThreadsPoster } from './posters/threads.poster';
import { FacebookPoster } from './posters/facebook.poster';

@Module({
  imports: [BrowserModule, SseModule, CryptoModule, AccountsModule, SessionsModule, WarmupModule, PostsModule, RateLimitModule, PrismaModule, QueueInfraModule, FlowControlModule],
  providers: [PostingService, ThreadProgressService, XPoster, ThreadsPoster, FacebookPoster],
  controllers: [PostingController],
  exports: [PostingService, ThreadProgressService],
})
export class PostingModule {}
