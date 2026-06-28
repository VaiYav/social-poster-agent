/**
 * Sprint O / F13: Recycling Module.
 */
import { Module } from '@nestjs/common';
import { RecyclingService } from './recycling.service';
import { RecyclingController } from './recycling.controller';

@Module({
  controllers: [RecyclingController],
  providers: [RecyclingService],
})
export class RecyclingModule {}
