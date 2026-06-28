import { Injectable, Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'

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

  constructor(private readonly configService: ConfigService) {
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
}
