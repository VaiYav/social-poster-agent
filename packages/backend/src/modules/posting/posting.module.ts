import { Module } from "@nestjs/common";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { CryptoModule } from "../../infrastructure/crypto/crypto.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { WarmupModule } from "../sessions/warmup.module.js";
import { PostsModule } from "../posts/posts.module.js";
import { RateLimitModule } from "../rate-limit/rate-limit.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { ContentEnhancementsModule } from "../content-enhancements/content-enhancements.module.js";
import { LinkAttributionModule } from "../link-attribution/link-attribution.module.js";
import { PostingService } from "./posting.service.js";
import { PostingController } from "./posting.controller.js";
import { ThreadProgressService } from "./thread-progress.service.js";
import { XPoster } from "./posters/x.poster.js";
import { ThreadsPoster } from "./posters/threads.poster.js";
import { FacebookPoster } from "./posters/facebook.poster.js";
import { BlueskyPoster } from "./posters/bluesky.poster.js";
import { MastodonPoster } from "./posters/mastodon.poster.js";
import { LinkedinSocialPoster } from "./posters/linkedin-social.poster.js";
import { TelegramModule } from "../../infrastructure/telegram/telegram.module.js";
import { PolicyModule } from "../policy/policy.module.js";
import { PostingGuardChain } from "./posting-guards.service.js";
import { PostingDispatcher } from "./poster-registry.service.js";
import { PostVerificationService } from "./post-verification.service.js";
import { ThreadOrchestrator } from "./thread-posting.service.js";
import { PostSideEffectsService } from "./post-side-effects.service.js";
import { CtaAttributionService } from "./cta-attribution.service.js";

@Module({
  imports: [
    BrowserModule,
    CryptoModule,
    AccountsModule,
    SessionsModule,
    WarmupModule,
    PostsModule,
    RateLimitModule,
    PrismaModule,
    QueueInfraModule,
    FlowControlModule,
    ContentEnhancementsModule,
    TelegramModule,
    LinkAttributionModule,
    PolicyModule,
  ],
  providers: [
    PostingService,
    ThreadProgressService,
    XPoster,
    ThreadsPoster,
    FacebookPoster,
    BlueskyPoster,
    MastodonPoster,
    LinkedinSocialPoster,
    PostingGuardChain,
    PostingDispatcher,
    PostVerificationService,
    ThreadOrchestrator,
    PostSideEffectsService,
    CtaAttributionService,
  ],
  controllers: [PostingController],
  exports: [
    PostingService,
    ThreadProgressService,
    BlueskyPoster,
    MastodonPoster,
    LinkedinSocialPoster,
  ],
})
export class PostingModule {}
