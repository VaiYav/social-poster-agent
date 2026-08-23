/**
 * ADR-006: Flow Control Module — pause/resume for all agent flows.
 */
import { Module } from "@nestjs/common";
import { FlowControlService } from "./flow-control.service.js";
import { FlowControlController } from "./flow-control.controller.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";

@Module({
  imports: [RedisModule, SseModule],
  providers: [FlowControlService],
  controllers: [FlowControlController],
  exports: [FlowControlService],
})
export class FlowControlModule {}
