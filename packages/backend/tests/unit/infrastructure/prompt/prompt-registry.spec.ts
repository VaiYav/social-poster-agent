/**
 * PromptRegistry unit tests.
 *
 * Tests the facade behavior: Langfuse-first with SDK native fallback,
 * inline fallback when Langfuse is disabled, and version tracking.
 *
 * Source: packages/backend/src/infrastructure/prompt/prompt-registry.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigService } from '@nestjs/config'
import { PromptRegistry } from '../../../../src/infrastructure/prompt/prompt-registry.js'
import type { LangfuseService } from '../../../../src/infrastructure/langfuse/langfuse.service'

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
    registry = new PromptRegistry(configService, undefined, [])
  })

  describe('getCurrentVersion', () => {
    it('returns the active version from PROMPT_VERSION env var', () => {
      configService = createMockConfigService({ PROMPT_VERSION: '0.4.0' })
      registry = new PromptRegistry(configService, undefined, [])
      expect(registry.getCurrentVersion()).toBe('0.4.0')
    })

    it('defaults to "latest" when PROMPT_VERSION is not set', () => {
      configService = {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService
      registry = new PromptRegistry(configService, undefined, [])
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

  describe('label resolution', () => {
    it('uses PROMPT_VERSION env var when no per-prompt override is set', async () => {
      const langfuse = createMockLangfuse({ label: '0.4.0' })
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, [])

      const result = await registry.getCompiledChat('test-prompt', { topic: 'Saturn' }, undefined)

      expect(result.label).toBe('0.4.0')
      expect(result.isFallback).toBe(false)
      expect(langfuse.getChatPrompt).toHaveBeenCalledWith('test-prompt', undefined, '0.4.0')
    })

    it('prefers PROMPT_VERSION_<NAME> over PROMPT_VERSION', async () => {
      const langfuse = createMockLangfuse({ label: 'experimental' })
      configService = createMockConfigService({
        PROMPT_VERSION: '0.4.0',
        PROMPT_VERSION_TEST_PROMPT: 'experimental',
      })
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, [])

      await registry.getCompiledChat('test-prompt', { topic: 'Saturn' }, undefined)

      expect(langfuse.getChatPrompt).toHaveBeenCalledWith('test-prompt', undefined, 'experimental')
    })

    it('uses explicit label parameter when provided', async () => {
      const langfuse = createMockLangfuse({ label: 'v2' })
      configService = createMockConfigService({ PROMPT_VERSION: '0.4.0' })
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, [])

      await registry.getCompiledChat('test-prompt', { topic: 'Saturn' }, undefined, 'v2')

      expect(langfuse.getChatPrompt).toHaveBeenCalledWith('test-prompt', undefined, 'v2')
    })
  })

  describe('label fallback chain', () => {
    it('falls back to production when the resolved label is missing', async () => {
      const langfuse = createMockLangfuse({
        responses: [
          { label: '0.4.0', exists: false },
          { label: 'production', exists: true, isFallback: false },
        ],
      })
      configService = createMockConfigService({ PROMPT_VERSION: '0.4.0' })
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, [])

      const result = await registry.getCompiledChat('test-prompt', { topic: 'Saturn' }, undefined)

      expect(result.label).toBe('production')
      expect(result.isFallback).toBe(false)
      expect(langfuse.getChatPrompt).toHaveBeenCalledTimes(2)
      expect(langfuse.getChatPrompt).toHaveBeenNthCalledWith(1, 'test-prompt', undefined, '0.4.0')
      expect(langfuse.getChatPrompt).toHaveBeenNthCalledWith(2, 'test-prompt', undefined, 'production')
    })

    it('uses inline fallback when all labels are missing', async () => {
      const langfuse = createMockLangfuse({ responses: [] })
      registry = new PromptRegistry(configService, langfuse as unknown as LangfuseService, [])

      const result = await registry.getCompiledChat('test-prompt', { topic: 'Saturn' }, {
        systemPrompt: 'System {topic}',
        userPrompt: 'User {topic}',
      })

      expect(result.systemPrompt).toBe('System Saturn')
      expect(result.userPrompt).toBe('User Saturn')
      expect(result.label).toBe('0.4.0')
      expect(result.isFallback).toBe(true)
    })
  })
})

// ── Mock helpers ───────────────────────────────────────────────────────────

function createMockLangfuse({
  label = '0.4.0',
  responses,
}: {
  label?: string
  responses?: Array<{ label: string; exists: boolean; isFallback?: boolean }>
} = {}) {
  const callLog: { label: string; fallback: unknown }[] = []

  const getChatPrompt = vi.fn(
    async (name: string, fallback: unknown, promptLabel: string) => {
      callLog.push({ label: promptLabel, fallback })

      const response = responses
        ? responses.find((r) => r.label === promptLabel) ?? { exists: false }
        : { exists: true, isFallback: false }

      if (!response.exists) {
        return undefined
      }

      return {
        isFallback: response.isFallback ?? false,
        compile: (_vars: Record<string, string>) => [
          { role: 'system', content: `${name} system` },
          { role: 'user', content: `${name} user` },
        ],
      }
    },
  )

  const getTextPrompt = vi.fn(
    async (name: string, fallback: unknown, promptLabel: string) => {
      callLog.push({ label: promptLabel, fallback })

      const response = responses
        ? responses.find((r) => r.label === promptLabel) ?? { exists: false }
        : { exists: true, isFallback: false }

      if (!response.exists) {
        return undefined
      }

      return {
        isFallback: response.isFallback ?? false,
        compile: (_vars: Record<string, string>) => `${name} text`,
      }
    },
  )

  return { getChatPrompt, getTextPrompt, callLog }
}
