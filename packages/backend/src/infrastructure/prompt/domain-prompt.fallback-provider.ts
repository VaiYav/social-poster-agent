import { Injectable, Logger } from "@nestjs/common";
import type {
  IPromptFallbackProvider,
  CompiledChatPrompt,
} from "../../domain/ports/prompt.port.js";
import { interpolate } from "../../domain/prompt-interpolation.js";
import { DomainConfigService } from "../../domain/domain-config/domain-config.service.js";

/**
 * File-based prompt fallback provider.
 *
 * Loads prompt templates from `DOMAIN_PROMPT_DIR` (default `config/prompts/default`)
 * and interpolates them with the caller's variables plus the brand/domain context.
 * This makes prompts fully external and domain-agnostic.
 */
@Injectable()
export class DomainPromptFallbackProvider implements IPromptFallbackProvider {
  private readonly logger = new Logger(DomainPromptFallbackProvider.name);

  constructor(private readonly domainConfig: DomainConfigService) {}

  async tryGetChatPrompt(
    name: string,
    variables: Record<string, string>,
  ): Promise<CompiledChatPrompt | null> {
    const template = await this.domainConfig.getChatPromptTemplate(name);
    if (!template) return null;
    const ctx = await this.buildContext(variables);
    return {
      systemPrompt: interpolate(template.systemPrompt, ctx),
      userPrompt: interpolate(template.userPrompt, ctx),
      label: "domain-file",
      isFallback: true,
    };
  }

  async tryGetTextPrompt(name: string, variables: Record<string, string>): Promise<string | null> {
    const raw = await this.domainConfig.getPromptTemplate(name);
    if (!raw) return null;
    const ctx = await this.buildContext(variables);
    return interpolate(raw, ctx);
  }

  private async buildContext(overrides: Record<string, string>): Promise<Record<string, string>> {
    const brandVoice = await this.domainConfig.getBrandVoice();
    const topicCategories = this.domainConfig.getTopicCategories();
    const trendingNiches = await this.domainConfig.getTrendingNiches();
    const slop = await this.domainConfig.getSlopLexicon();

    const englishSlop = slop["en"];
    const slopList = englishSlop
      ? [...(englishSlop.words ?? []), ...(englishSlop.phrases ?? [])].join(", ")
      : "";

    return {
      brandName: this.domainConfig.brandName,
      brandDescription: this.domainConfig.brandDescription,
      domain: this.domainConfig.domain,
      domainDescription: this.domainConfig.domainDescription,
      brandVoice,
      blogBaseUrl: this.domainConfig.blogBaseUrl,
      topicCategories: topicCategories.join(", "),
      trendingNiches: trendingNiches.map((n) => `${n.label} (${n.keywords.join(", ")})`).join("; "),
      slopList,
      ...overrides,
    };
  }
}
