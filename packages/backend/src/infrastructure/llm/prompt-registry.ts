import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { LangfuseService } from '../langfuse/langfuse.service.js'

/**
 * A versioned prompt template.
 *
 * `userPromptTemplate` contains placeholders like {topic}, {keywords} that are
 * interpolated at call time. `version` ties a template to a specific prompt
 * release so we can A/B test and roll back without code changes.
 */
export interface PromptTemplate {
  version: string
  name: string
  systemPrompt: string
  userPromptTemplate: string // with {topic}, {keywords} etc placeholders
  description?: string
}

/**
 * Result of compiling a chat prompt — system + user messages ready for llm.generateChat().
 */
export interface CompiledChatPrompt {
  systemPrompt: string
  userPrompt: string
}

/**
 * Internal storage key — composite of version + name.
 */
type RegistryKey = `${string}::${string}`

/**
 * PromptRegistry — central store for versioned prompt templates.
 *
 * Replaces the static `PROMPT_VERSION` constant on LlmService (audit finding).
 * Templates are registered at bootstrap and retrieved by (version, name).
 * When a requested version is missing, the registry falls back to the special
 * 'latest' version so callers don't need to know the exact active version.
 *
 * The active version is sourced from the PROMPT_VERSION env var via ConfigService,
 * defaulting to 'latest'.
 */
@Injectable()
export class PromptRegistry {
  private readonly logger = new Logger(PromptRegistry.name)
  private readonly templates = new Map<RegistryKey, PromptTemplate>()
  private readonly versions = new Set<string>()
  private readonly currentVersion: string

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly langfuse?: LangfuseService,
  ) {
    this.currentVersion = this.configService.get<string>('PROMPT_VERSION', 'latest')
  }

  /**
   * Register a prompt template under a specific version + name.
   * Overwrites any existing template with the same version+name.
   */
  register(version: string, name: string, template: Omit<PromptTemplate, 'version' | 'name'>): void {
    const key: RegistryKey = `${version}::${name}`
    const full: PromptTemplate = { ...template, version, name }
    this.templates.set(key, full)
    this.versions.add(version)
    this.logger.debug(`Registered prompt "${name}" v${version}`)
  }

  /**
   * Retrieve a prompt template by version + name.
   * Falls back to the 'latest' version when the requested version is not found.
   * Throws when no template exists for the name in either the requested or
   * 'latest' version.
   */
  get(version: string, name: string): PromptTemplate {
    const exact = this.templates.get(`${version}::${name}`)
    if (exact) return exact

    const latest = this.templates.get(`latest::${name}`)
    if (latest) {
      this.logger.warn(
        `Prompt "${name}" not found for v${version} — falling back to "latest"`,
      )
      return latest
    }

    throw new Error(
      `Prompt template "${name}" not found (requested v${version}, no "latest" fallback)`,
    )
  }

  /**
   * List all registered versions (including 'latest' if registered).
   */
  listVersions(): string[] {
    return Array.from(this.versions)
  }

  /**
   * The active prompt version, sourced from PROMPT_VERSION env var.
   */
  getCurrentVersion(): string {
    return this.currentVersion
  }

  // ── Langfuse Prompt Management (async, with local fallback) ──────────────

  /**
   * Fetch and compile a chat prompt from Langfuse Prompt Management.
   *
   * Tries Langfuse first (production label, 5-min cache). If Langfuse is
   * disabled or the prompt is not found, falls back to the local PromptTemplate
   * registry (compiling with simple {var} substitution).
   *
   * @param name Prompt name in Langfuse (e.g. 'research-extract')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback — used when neither Langfuse nor
   *   the local registry has the prompt. This is how graph nodes pass their
   *   inline prompts as last-resort fallbacks.
   */
  async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback?: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt> {
    // Try Langfuse first
    if (this.langfuse) {
      const prompt = await this.langfuse.getChatPrompt(name)
      if (prompt) {
        try {
          const compiled = prompt.compile(variables) as Array<{ role: string; content: string }>
          const systemMsg = compiled.find((m) => m.role === 'system')
          const userMsg = compiled.find((m) => m.role === 'user')
          if (systemMsg && userMsg) {
            return { systemPrompt: systemMsg.content, userPrompt: userMsg.content }
          }
        } catch (err) {
          this.logger.debug(`Langfuse compile failed for "${name}": ${(err as Error).message}`)
        }
      }
    }

    // Try local registry
    try {
      const template = this.get(this.currentVersion, name)
      return {
        systemPrompt: interpolate(template.systemPrompt, variables),
        userPrompt: interpolate(template.userPromptTemplate, variables),
      }
    } catch {
      // Not in local registry
    }

    // Last resort: inline fallback from the caller
    if (fallback) {
      return {
        systemPrompt: interpolate(fallback.systemPrompt, variables),
        userPrompt: interpolate(fallback.userPrompt, variables),
      }
    }

    throw new Error(`Prompt "${name}" not found in Langfuse, local registry, or fallback`)
  }

  /**
   * Fetch and compile a text prompt from Langfuse Prompt Management.
   * Same fallback chain as getCompiledChat.
   *
   * @param name Prompt name in Langfuse (e.g. 'critique-post')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback text
   */
  async getCompiledText(
    name: string,
    variables: Record<string, string>,
    fallback?: string,
  ): Promise<string> {
    // Try Langfuse first
    if (this.langfuse) {
      const prompt = await this.langfuse.getTextPrompt(name)
      if (prompt) {
        try {
          return prompt.compile(variables) as string
        } catch (err) {
          this.logger.debug(`Langfuse compile failed for "${name}": ${(err as Error).message}`)
        }
      }
    }

    // Last resort: inline fallback from the caller
    if (fallback) {
      return interpolate(fallback, variables)
    }

    throw new Error(`Text prompt "${name}" not found in Langfuse or fallback`)
  }
}

/**
 * Simple {var} interpolation for local fallback prompts.
 * Langfuse uses {{double-brace}} syntax; local templates use {single-brace}.
 * This replaces {var} with the corresponding value.
 */
function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string): string => {
    return key in variables ? String(variables[key]) : match
  })
}
