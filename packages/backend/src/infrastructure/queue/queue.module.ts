import { Module } from '@nestjs/common';
import { QueueFactory } from './queue.factory';

@Module({
  providers: [QueueFactory],
  exports: [QueueFactory],
})
export class QueueModule {}
