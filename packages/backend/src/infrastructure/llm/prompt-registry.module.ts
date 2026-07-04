import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from './prompt-registry'
import { v040Prompts } from './prompts/index.js'
import { LangfuseService } from '../langfuse/langfuse.service.js'

/**
 * PromptRegistry module — provides the versioned prompt registry.
 *
 * On instantiation the v0.4.0 templates are registered under both their
 * semantic version and the 'latest' alias so callers can pin a version or
 * always get the newest.
 *
 * When LangfuseService is available (LangfuseModule is @Global), the registry
 * fetches prompts from Langfuse Prompt Management first, falling back to the
 * local v0.4.0 templates.
 */
@Module({
  providers: [
    {
      provide: PromptRegistry,
      useFactory: (configService: ConfigService, langfuse?: LangfuseService): PromptRegistry => {
        const registry = new PromptRegistry(configService, langfuse)
        for (const tpl of v040Prompts) {
          registry.register(tpl.version, tpl.name, {
            systemPrompt: tpl.systemPrompt,
            userPromptTemplate: tpl.userPromptTemplate,
            description: tpl.description,
          })
          // Also register under the 'latest' alias
          registry.register('latest', tpl.name, {
            systemPrompt: tpl.systemPrompt,
            userPromptTemplate: tpl.userPromptTemplate,
            description: tpl.description,
          })
        }
        return registry
      },
      inject: [ConfigService, LangfuseService],
    },
  ],
  exports: [PromptRegistry],
})
export class PromptRegistryModule {}
