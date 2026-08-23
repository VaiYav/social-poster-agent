/**
 * ADR-006: Autonomy Module — auto-check, auto-approve, autonomous runner.
 *
 * Wires together:
 *   - AutoCheckService (content validation pipeline)
 *   - AutoApproveService (decision gate replacing HITL)
 *   - AutonomousRunnerService (cron-driven full pipeline)
 *
 * Depends on: FlowControlModule, PrismaModule, SseModule, GenerationModule (lazy).
 */
import { Module } from "@nestjs/common";
import { AutoCheckService } from "./auto-check.service.js";
import { AutoApproveService } from "./auto-approve.service.js";
import { AutonomousRunnerService } from "./autonomous-runner.service.js";
import { AutoApproveListener } from "./auto-approve.listener.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";

@Module({
  imports: [FlowControlModule, PrismaModule, SseModule, QueueInfraModule], // A5: IPostingQueuePort
  providers: [AutoCheckService, AutoApproveService, AutonomousRunnerService, AutoApproveListener],
  exports: [AutoCheckService, AutoApproveService, AutonomousRunnerService, AutoApproveListener],
})
export class AutonomyModule {}
