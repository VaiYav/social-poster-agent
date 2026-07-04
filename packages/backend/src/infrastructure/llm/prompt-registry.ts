import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { LangfuseService } from '../langfuse/langfuse.service.js'
import type { IPromptPort, CompiledChatPrompt } from '../../domain/ports/prompt.port.js'

// Re-export for backward compatibility — consumers should migrate to
// importing from domain/ports/prompt.port.js instead.
export type { CompiledChatPrompt } from '../../domain/ports/prompt.port.js'

/**
 * PromptRegistry — facade for prompt management.
 *
 * Implements `IPromptPort` so consumers depend on the port abstraction,
 * not the concrete class (hexagonal architecture).
 *
 * Fallback chain (2-tier):
 *   1. Langfuse Prompt Management (with SDK native `fallback` parameter —
 *      if the fetch fails, the SDK returns fallback content automatically)
 *   2. Inline fallback from the caller (when Langfuse is completely disabled)
 *
 * The inline fallback uses `{var}` syntax (for local `interpolate()`).
 * It is converted to `{{var}}` Mustache syntax before passing to the SDK,
 * so `compile()` works correctly on both remote and fallback content.
 *
 * The active version is sourced from the PROMPT_VERSION env var via
 * ConfigService, defaulting to 'latest'.
 */
@Injectable()
export class PromptRegistry implements IPromptPort {
  private readonly logger = new Logger(PromptRegistry.name)
  private readonly currentVersion: string

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly langfuse?: LangfuseService,
  ) {
    this.currentVersion = this.configService.get<string>('PROMPT_VERSION', 'latest')
  }

  /**
   * The active prompt version, sourced from PROMPT_VERSION env var.
   * Used for tracking in llmMetadata.
   */
  getCurrentVersion(): string {
    return this.currentVersion
  }

  /**
   * Fetch and compile a chat prompt from Langfuse Prompt Management.
   *
   * Uses the SDK's native `fallback` parameter — if the Langfuse fetch fails,
   * the SDK returns a prompt client with `isFallback: true` containing the
   * fallback content. This eliminates the need for a manual fallback chain.
   *
   * The inline fallback (from the caller) uses `{var}` syntax (for local
   * `interpolate()`). It is converted to `{{var}}` Mustache syntax before
   * passing to the SDK, so `compile()` works correctly on both remote and
   * fallback content.
   *
   * When Langfuse is completely disabled (no client), falls back to
   * `interpolate()` on the inline fallback.
   *
   * @param name Prompt name in Langfuse (e.g. 'research-extract')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback ({var} syntax)
   */
  async getCompiledChat(
    name: string,
    variables: Record<string, string>,
    fallback?: CompiledChatPrompt,
  ): Promise<CompiledChatPrompt> {
    // Convert inline fallback to SDK format (ChatMessage[] with {{var}} syntax)
    const sdkFallback = fallback
      ? [
          { role: 'system', content: toMustache(fallback.systemPrompt) },
          { role: 'user', content: toMustache(fallback.userPrompt) },
        ]
      : undefined

    // Try Langfuse with SDK native fallback
    if (this.langfuse) {
      const prompt = await this.langfuse.getChatPrompt(name, sdkFallback)
      if (prompt) {
        try {
          const compiled = prompt.compile(variables)
          const messages = compiled.filter(isChatMessage)
          const systemMsg = messages.find((m) => m.role === 'system')
          const userMsg = messages.find((m) => m.role === 'user')
          if (systemMsg && userMsg) {
            return { systemPrompt: systemMsg.content, userPrompt: userMsg.content }
          }
        } catch (err) {
          this.logger.warn(`Langfuse compile failed for "${name}": ${getErrorMessage(err)}`)
        }
      }
    }

    // Langfuse disabled or compile failed — use inline fallback with local interpolation
    if (fallback) {
      return {
        systemPrompt: interpolate(fallback.systemPrompt, variables),
        userPrompt: interpolate(fallback.userPrompt, variables),
      }
    }

    throw new Error(`Prompt "${name}" not found in Langfuse or fallback`)
  }

  /**
   * Fetch and compile a text prompt from Langfuse Prompt Management.
   *
   * Uses the SDK's native `fallback` parameter. The inline fallback is
   * converted from `{var}` to `{{var}}` Mustache syntax before passing.
   *
   * @param name Prompt name in Langfuse (e.g. 'critique-post')
   * @param variables Values for {{var}} placeholders
   * @param fallback Optional inline fallback text ({var} syntax)
   */
  async getCompiledText(
    name: string,
    variables: Record<string, string>,
    fallback?: string,
  ): Promise<string> {
    // Convert inline fallback to SDK format ({{var}} Mustache syntax)
    const sdkFallback = fallback ? toMustache(fallback) : undefined

    // Try Langfuse with SDK native fallback
    if (this.langfuse) {
      const prompt = await this.langfuse.getTextPrompt(name, sdkFallback)
      if (prompt) {
        try {
          return prompt.compile(variables) as string
        } catch (err) {
          this.logger.warn(`Langfuse compile failed for "${name}": ${getErrorMessage(err)}`)
        }
      }
    }

    // Langfuse disabled or compile failed — use inline fallback with local interpolation
    if (fallback) {
      return interpolate(fallback, variables)
    }

    throw new Error(`Text prompt "${name}" not found in Langfuse or fallback`)
  }
}

// ── Utility functions ──────────────────────────────────────────────────────

/**
 * Simple {var} interpolation for local fallback prompts.
 * Langfuse uses {{double-brace}} Mustache syntax; local fallbacks use
 * {single-brace}. This replaces {var} with the corresponding value.
 */
function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string): string => {
    if (!(key in variables)) return match
    const val = variables[key]
    return val !== undefined ? val : match
  })
}

/** Safely extract a message from an unknown caught error. */
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Convert {single-brace} placeholders to {{double-brace}} Mustache syntax.
 * Used when passing local fallback prompts (which use {var}) to the Langfuse
 * SDK (which uses {{var}} Mustache). Leaves existing {{var}} untouched.
 */
function toMustache(template: string): string {
  return template.replace(/(?<!\{)\{(\w+)\}(?!\})/g, '{{$1}}')
}

/**
 * Type guard: filter Langfuse `compile()` results to resolved chat messages.
 * Langfuse returns `any[]` which may include unresolved placeholder objects
 * (`{ type: 'placeholder', name: string }`). This guard ensures we only
 * process actual `{ role, content }` messages.
 */
function isChatMessage(msg: unknown): msg is { role: string; content: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'role' in msg &&
    'content' in msg &&
    typeof (msg as { role: unknown }).role === 'string' &&
    typeof (msg as { content: unknown }).content === 'string'
  )
}
