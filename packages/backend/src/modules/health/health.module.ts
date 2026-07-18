import { Module } from '@nestjs/common';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { HealthController } from './health.controller';

@Module({
  imports: [QueueInfraModule],
  controllers: [HealthController],
})
export class HealthModule {}
