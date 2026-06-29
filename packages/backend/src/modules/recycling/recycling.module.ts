/**
 * Sprint O / F13: Recycling Module.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RecyclingService } from './recycling.service';
import { RecyclingController } from './recycling.controller';
import { GenerationModule } from '../generation/generation.module';

@Module({
  // RC3: GenerationModule provides GenerationService for graph-based re-writes.
  // ScheduleModule: RC2 flag-gated recycling cron.
  imports: [ScheduleModule, GenerationModule],
  controllers: [RecyclingController],
  providers: [RecyclingService],
})
export class RecyclingModule {}
