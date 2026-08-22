import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthMonitorController } from "./health-monitor.controller";
import { HealthMonitorService } from "./health-monitor.service";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module";
import { SseModule } from "../../infrastructure/sse/sse.module";
import { QueueModule } from "../queue/queue.module";
import { QueueModule as QueueInfraModule } from "../../infrastructure/queue/queue.module";

@Module({
  imports: [PrismaModule, SseModule, ScheduleModule, QueueModule, QueueInfraModule],
  controllers: [HealthMonitorController],
  providers: [HealthMonitorService],
  exports: [HealthMonitorService],
})
export class HealthMonitorModule {}
