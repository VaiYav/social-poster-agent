import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { CryptoModule } from '../../infrastructure/crypto/crypto.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WarmupModule } from '../sessions/warmup.module';
import { PostsModule } from '../posts/posts.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { FlowControlModule } from '../flow-control/flow-control.module';
import { ContentEnhancementsModule } from '../content-enhancements/content-enhancements.module.js';
import { PostingService } from './posting.service';
import { PostingController } from './posting.controller';
import { ThreadProgressService } from './thread-progress.service';
import { XPoster } from './posters/x.poster';
import { ThreadsPoster } from './posters/threads.poster';
import { FacebookPoster } from './posters/facebook.poster';
import { BlueskyPoster } from './posters/bluesky.poster.js';
import { MastodonPoster } from './posters/mastodon.poster.js';
import { LinkedinSocialPoster } from './posters/linkedin-social.poster.js';
import { TelegramModule } from '../../infrastructure/telegram/telegram.module.js';

@Module({
  imports: [BrowserModule, CryptoModule, AccountsModule, SessionsModule, WarmupModule, PostsModule, RateLimitModule, PrismaModule, QueueInfraModule, FlowControlModule, ContentEnhancementsModule, TelegramModule],
  providers: [PostingService, ThreadProgressService, XPoster, ThreadsPoster, FacebookPoster, BlueskyPoster, MastodonPoster, LinkedinSocialPoster],
  controllers: [PostingController],
  exports: [PostingService, ThreadProgressService, BlueskyPoster, MastodonPoster, LinkedinSocialPoster],
})
export class PostingModule {}
