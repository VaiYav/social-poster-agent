import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PostsModule } from '../posts/posts.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PostingService } from './posting.service';
import { PostingController } from './posting.controller';
import { XPoster } from './posters/x.poster';
import { ThreadsPoster } from './posters/threads.poster';
import { FacebookPoster } from './posters/facebook.poster';

@Module({
  imports: [BrowserModule, SseModule, AccountsModule, SessionsModule, PostsModule, RateLimitModule],
  providers: [PostingService, XPoster, ThreadsPoster, FacebookPoster],
  controllers: [PostingController],
  exports: [PostingService],
})
export class PostingModule {}
