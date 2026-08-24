import { Module } from "@nestjs/common";
import { RedisCheckpointSaver } from "./redis-checkpoint.js";

@Module({
  providers: [RedisCheckpointSaver],
  exports: [RedisCheckpointSaver],
})
export class CheckpointModule {}
