/**
 * Sprint O / F13: Recycling Module.
 */
import { Module } from '@nestjs/common';
import { RecyclingService } from './recycling.service';
import { RecyclingController } from './recycling.controller';
import { GenerationModule } from '../generation/generation.module';

// RC3: GenerationModule provides GenerationService for graph-based re-writes.
// RC2: the recyclingCron @Cron is discovered by the global ScheduleModule.forRoot() in
// AppModule — do NOT import a bare ScheduleModule here (breaks SchedulerOrchestrator in
// partial module graphs).
@Module({
  imports: [GenerationModule],
  controllers: [RecyclingController],
  providers: [RecyclingService],
})
export class RecyclingModule {}
