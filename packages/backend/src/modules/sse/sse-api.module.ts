import { Module } from "@nestjs/common";
import { SseModule as SseCoreModule } from "../../infrastructure/sse/sse.module.js";
import { SseController } from "./sse.controller.js";

@Module({
  imports: [SseCoreModule],
  controllers: [SseController],
})
export class SseApiModule {}
