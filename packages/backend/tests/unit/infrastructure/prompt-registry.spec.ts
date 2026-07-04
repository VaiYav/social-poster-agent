/**
 * PromptRegistry unit tests.
 *
 * Tests the facade behavior: Langfuse-first with SDK native fallback,
 * inline fallback when Langfuse is disabled, and version tracking.
 *
 * Source: packages/backend/src/infrastructure/llm/prompt-registry.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from '../../../src/infrastructure/llm/prompt-registry'

// ── Helpers ──

function createMockConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  const defaults: Record<string, unknown> = {
    PROMPT_VERSION: '0.4.0',
  }
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) =>
        overrides[key] ?? defaults[key] ?? defaultValue,
    ),
  } as unknown as ConfigService
}

// ── Tests ──

describe('PromptRegistry', () => {
  let registry: PromptRegistry
  let configService: ConfigService

  beforeEach(() => {
    vi.clearAllMocks()
    configService = createMockConfigService()
    registry = new PromptRegistry(configService)
  })

  describe('getCurrentVersion', () => {
    it('returns the active version from PROMPT_VERSION env var', () => {
      configService = createMockConfigService({ PROMPT_VERSION: '0.4.0' })
      registry = new PromptRegistry(configService)
      expect(registry.getCurrentVersion()).toBe('0.4.0')
    })

    it('defaults to "latest" when PROMPT_VERSION is not set', () => {
      configService = {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService
      registry = new PromptRegistry(configService)
      expect(registry.getCurrentVersion()).toBe('latest')
    })
  })

  describe('getCompiledChat (no Langfuse — inline fallback)', () => {
    it('interpolates {var} placeholders in the inline fallback', async () => {
      const result = await registry.getCompiledChat('test-prompt', {
        topic: 'Mercury retrograde',
        network: 'X',
      }, {
        systemPrompt: 'You are an expert on {topic}.',
        userPrompt: 'Write a {network} post about {topic}.',
      })

      expect(result.systemPrompt).toBe('You are an expert on Mercury retrograde.')
      expect(result.userPrompt).toBe('Write a X post about Mercury retrograde.')
    })

    it('leaves unmatched placeholders intact', async () => {
      const result = await registry.getCompiledChat('test-prompt', {
        topic: 'Saturn return',
      }, {
        systemPrompt: 'You are an expert on {topic}.',
        userPrompt: 'Write about {missingVar}.',
      })

      expect(result.systemPrompt).toBe('You are an expert on Saturn return.')
      expect(result.userPrompt).toBe('Write about {missingVar}.')
    })

    it('throws when no fallback is provided and Langfuse is not configured', async () => {
      await expect(
        registry.getCompiledChat('nonexistent', {}),
      ).rejects.toThrow(/not found/)
    })
  })

  describe('getCompiledText (no Langfuse — inline fallback)', () => {
    it('interpolates {var} placeholders in the inline fallback', async () => {
      const result = await registry.getCompiledText('test-prompt', {
        network: 'X',
        charLimit: '280',
      }, 'Critique this {network} post. Limit: {charLimit} chars.')

      expect(result).toBe('Critique this X post. Limit: 280 chars.')
    })

    it('throws when no fallback is provided and Langfuse is not configured', async () => {
      await expect(
        registry.getCompiledText('nonexistent', {}),
      ).rejects.toThrow(/not found/)
    })
  })
})
