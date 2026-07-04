import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from './prompt-registry'
import { LangfuseService } from '../langfuse/langfuse.service.js'
import { IPromptPort } from '../../domain/ports/prompt.port.js'

/**
 * PromptRegistry module — provides the prompt management facade.
 *
 * Binds `IPromptPort` so consumers depend on the port abstraction, not
 * the concrete class (hexagonal architecture). The module is @Global so
 * all feature modules can inject `IPromptPort` without explicit imports.
 *
 * When LangfuseService is available (LangfuseModule is @Global), the
 * registry fetches prompts from Langfuse Prompt Management with SDK native
 * fallback. When Langfuse is disabled, it uses inline fallbacks from callers.
 */
@Global()
@Module({
  providers: [
    {
      provide: PromptRegistry,
      useFactory: (configService: ConfigService, langfuse?: LangfuseService): PromptRegistry => {
        return new PromptRegistry(configService, langfuse)
      },
      inject: [ConfigService, LangfuseService],
    },
    { provide: IPromptPort, useExisting: PromptRegistry },
  ],
  exports: [PromptRegistry, IPromptPort],
})
export class PromptRegistryModule {}
