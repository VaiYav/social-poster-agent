import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthMonitorController } from "./health-monitor.controller.js";
import { HealthMonitorService } from "./health-monitor.service.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";

@Module({
  imports: [PrismaModule, SseModule, ScheduleModule, QueueModule, QueueInfraModule],
  controllers: [HealthMonitorController],
  providers: [HealthMonitorService],
  exports: [HealthMonitorService],
})
export class HealthMonitorModule {}
