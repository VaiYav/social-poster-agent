import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from './prompt-registry'
import { v040Prompts } from './prompts/index.js'

/**
 * PromptRegistry module — provides the versioned prompt registry.
 *
 * On instantiation the v0.4.0 templates are registered under both their
 * semantic version and the 'latest' alias so callers can pin a version or
 * always get the newest.
 */
@Module({
  providers: [
    {
      provide: PromptRegistry,
      useFactory: (configService: ConfigService): PromptRegistry => {
        const registry = new PromptRegistry(configService)
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
      inject: [ConfigService],
    },
  ],
  exports: [PromptRegistry],
})
export class PromptRegistryModule {}
