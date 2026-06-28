/**
 * ADR-006: Flow Control Module — pause/resume for all agent flows.
 */
import { Module } from '@nestjs/common';
import { FlowControlService } from './flow-control.service';
import { FlowControlController } from './flow-control.controller';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { SseModule } from '../../infrastructure/sse/sse.module';

@Module({
  imports: [RedisModule, SseModule],
  providers: [FlowControlService],
  controllers: [FlowControlController],
  exports: [FlowControlService],
})
export class FlowControlModule {}
