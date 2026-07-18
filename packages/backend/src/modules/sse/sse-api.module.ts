import { Module } from '@nestjs/common';
import { SseModule as SseCoreModule } from '../../infrastructure/sse/sse.module';
import { SseController } from './sse.controller';

@Module({
  imports: [SseCoreModule],
  controllers: [SseController],
})
export class SseApiModule {}
