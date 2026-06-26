import { Module } from '@nestjs/common';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { EventsController } from './events.controller';

@Module({
  imports: [SseModule],
  controllers: [EventsController],
})
export class EventsModule {}
