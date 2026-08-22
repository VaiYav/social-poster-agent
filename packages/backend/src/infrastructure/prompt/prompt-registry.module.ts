import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PromptRegistry } from "./prompt-registry.js";
import { LangfuseService } from "../langfuse/langfuse.service.js";
import {
  IPromptPort,
  PROMPT_FALLBACK_PROVIDERS,
  type IPromptFallbackProvider,
} from "../../domain/ports/prompt.port.js";
import { DomainPromptFallbackProvider } from "./domain-prompt.fallback-provider.js";
import { DomainConfigService } from "../../domain/domain-config/domain-config.service.js";

/**
 * PromptRegistry module — provides the prompt management facade.
 *
 * Binds `IPromptPort` so consumers depend on the port abstraction, not
 * the concrete class (hexagonal architecture). The module is @Global so
 * all feature modules can inject `IPromptPort` without explicit imports.
 *
 * When LangfuseService is available (LangfuseModule is @Global), the
 * registry fetches prompts from Langfuse Prompt Management with SDK native
 * fallback. When Langfuse is disabled, it uses inline fallbacks from callers
 * or prompt files from `DOMAIN_PROMPT_DIR`.
 *
 * Intermediate fallback providers can be registered by binding to
 * `PROMPT_FALLBACK_PROVIDERS` in any module.
 */
@Global()
@Module({
  providers: [
    // Domain prompt files take priority over inline fallbacks when no remote
    // prompt manager is available or when a local prompt file overrides it.
    {
      provide: PROMPT_FALLBACK_PROVIDERS,
      useFactory: (domainConfig: DomainConfigService): IPromptFallbackProvider[] => [
        new DomainPromptFallbackProvider(domainConfig),
      ],
      inject: [DomainConfigService],
    },
    {
      provide: PromptRegistry,
      useFactory: (
        configService: ConfigService,
        langfuse: LangfuseService | undefined,
        fallbackProviders: IPromptFallbackProvider[],
      ): PromptRegistry => {
        return new PromptRegistry(configService, langfuse, fallbackProviders);
      },
      inject: [ConfigService, LangfuseService, PROMPT_FALLBACK_PROVIDERS],
    },
    { provide: IPromptPort, useExisting: PromptRegistry },
  ],
  exports: [PromptRegistry, IPromptPort],
})
export class PromptRegistryModule {}
