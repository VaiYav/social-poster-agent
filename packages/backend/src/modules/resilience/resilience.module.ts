import { Module } from "@nestjs/common";
import { ResilienceService } from "./resilience.service.js";

/**
 * ResilienceModule — unified degradation model (ROADMAP_V2 M1.5 skeleton).
 * Global so any subsystem (LLM, browser, sessions, queues, Langfuse) can
 * report health without explicit imports; full wiring lands at M3 GA.
 */
@Module({
  providers: [ResilienceService],
  exports: [ResilienceService],
})
export class ResilienceModule {}
