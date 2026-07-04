import { Global, Module } from '@nestjs/common';
import { LangfuseService } from './langfuse.service.js';

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
  providers: [LangfuseService],
  exports: [LangfuseService],
})
export class LangfuseModule {}
