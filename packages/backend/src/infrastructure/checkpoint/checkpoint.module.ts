import { Module } from '@nestjs/common';
import { RedisCheckpointSaver } from './redis-checkpoint';

@Module({
  providers: [RedisCheckpointSaver],
  exports: [RedisCheckpointSaver],
})
export class CheckpointModule {}
