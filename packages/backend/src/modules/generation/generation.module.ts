import { Module } from '@nestjs/common';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { CheckpointModule } from '../../infrastructure/checkpoint/checkpoint.module';
import { ContentSourceModule } from '../content-source/content-source.module';
import { AccountsModule } from '../accounts/accounts.module';
import { PostsModule } from '../posts/posts.module';
import { GenerationService } from './generation.service';
import { GenerationController } from './generation.controller';
import { CronService } from './cron.service';

@Module({
  imports: [LlmModule, CheckpointModule, ContentSourceModule, AccountsModule, PostsModule],
  providers: [GenerationService, GenerationController, CronService],
  controllers: [GenerationController],
  exports: [GenerationService],
})
export class GenerationModule {}
