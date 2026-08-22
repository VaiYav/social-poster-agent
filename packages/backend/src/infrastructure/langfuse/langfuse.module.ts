import { Global, Module } from "@nestjs/common";
import { LangfuseService } from "./langfuse.service.js";
import { CircuitBreaker } from "../../domain/circuit-breaker.js";
import { LANGFUSE_PROMPT_BREAKER } from "./langfuse.tokens.js";

/**
 * LangfuseModule — global module providing LangfuseService.
 *
 * Always loaded (no feature flag) — LangfuseService is a no-op when
 * LANGFUSE_PUBLIC_KEY is not set. This avoids conditional DI wiring and
 * lets any service inject LangfuseService without worrying about whether
 * the module is registered.
 *
 * The OTel SDK is initialized separately in `langfuse-instrumentation.ts`
 * (imported at the top of main.ts) — this module just provides the
 * CallbackHandler factory.
 */
@Global()
@Module({
  providers: [
    LangfuseService,
    {
      provide: LANGFUSE_PROMPT_BREAKER,
      useFactory: (): CircuitBreaker =>
        new CircuitBreaker("langfuse-prompts", {
          failureThreshold: 3,
          resetTimeoutMs: 60_000, // 1 min cooldown after 3 consecutive failures
        }),
    },
  ],
  exports: [LangfuseService, LANGFUSE_PROMPT_BREAKER],
})
export class LangfuseModule {}
