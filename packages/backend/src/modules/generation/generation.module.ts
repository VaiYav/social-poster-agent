import { Module } from '@nestjs/common';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { CheckpointModule } from '../../infrastructure/checkpoint/checkpoint.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { ContentSourceModule } from '../content-source/content-source.module';
import { AccountsModule } from '../accounts/accounts.module';
import { PostsModule } from '../posts/posts.module';
import { TrendingModule } from '../trending/trending.module';
import { ContentEnhancementsModule } from '../content-enhancements/content-enhancements.module';
import { GenerationService } from './generation.service';
import { GenerationController } from './generation.controller';
import { CronService } from './cron.service';

@Module({
  imports: [
    LlmModule,
    CheckpointModule,
    SseModule,
    ContentSourceModule,
    AccountsModule,
    PostsModule,
    TrendingModule,
    ContentEnhancementsModule,
  ],
  providers: [GenerationService, GenerationController, CronService],
  controllers: [GenerationController],
  exports: [GenerationService],
})
export class GenerationModule {}
