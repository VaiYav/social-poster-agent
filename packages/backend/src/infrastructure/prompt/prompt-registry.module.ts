import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from './prompt-registry'
import { LangfuseService } from '../langfuse/langfuse.service.js'
import { IPromptPort, PROMPT_FALLBACK_PROVIDERS, type IPromptFallbackProvider } from '../../domain/ports/prompt.port.js'

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
 *
 * Intermediate fallback providers can be registered by binding to
 * `PROMPT_FALLBACK_PROVIDERS` in any module.
 */
@Global()
@Module({
  providers: [
    // Default: empty array. Other modules can override by binding to
    // PROMPT_FALLBACK_PROVIDERS with `useFactory: () => [new MyProvider()]`.
    { provide: PROMPT_FALLBACK_PROVIDERS, useValue: [] },
    {
      provide: PromptRegistry,
      useFactory: (
        configService: ConfigService,
        langfuse: LangfuseService | undefined,
        fallbackProviders: IPromptFallbackProvider[],
      ): PromptRegistry => {
        return new PromptRegistry(configService, langfuse, fallbackProviders)
      },
      inject: [ConfigService, LangfuseService, PROMPT_FALLBACK_PROVIDERS],
    },
    { provide: IPromptPort, useExisting: PromptRegistry },
  ],
  exports: [PromptRegistry, IPromptPort],
})
export class PromptRegistryModule {}
