import { Module } from "@nestjs/common";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [QueueInfraModule],
  controllers: [HealthController],
})
export class HealthModule {}
