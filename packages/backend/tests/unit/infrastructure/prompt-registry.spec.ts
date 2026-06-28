/**
 * PromptRegistry unit tests.
 *
 * Verifies versioned template storage, 'latest' fallback, version listing,
 * current-version resolution from config, and error handling for missing
 * templates.
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

  describe('register & get', () => {
    it('stores and retrieves a template by version + name', () => {
      registry.register('0.4.0', 'research-extract', {
        systemPrompt: 'You are a research analyst.',
        userPromptTemplate: 'Topic: {topic}',
        description: 'Extract facts',
      })

      const tpl = registry.get('0.4.0', 'research-extract')
      expect(tpl.version).toBe('0.4.0')
      expect(tpl.name).toBe('research-extract')
      expect(tpl.systemPrompt).toBe('You are a research analyst.')
      expect(tpl.userPromptTemplate).toBe('Topic: {topic}')
      expect(tpl.description).toBe('Extract facts')
    })

    it('overwrites a template when re-registered with same version+name', () => {
      registry.register('0.4.0', 'hook-generation', {
        systemPrompt: 'v1',
        userPromptTemplate: 'v1 template',
      })
      registry.register('0.4.0', 'hook-generation', {
        systemPrompt: 'v2',
        userPromptTemplate: 'v2 template',
      })

      const tpl = registry.get('0.4.0', 'hook-generation')
      expect(tpl.systemPrompt).toBe('v2')
      expect(tpl.userPromptTemplate).toBe('v2 template')
    })
  })

  describe('latest fallback', () => {
    it('falls back to the "latest" version when requested version is missing', () => {
      registry.register('latest', 'draft-x', {
        systemPrompt: 'Latest draft prompt.',
        userPromptTemplate: 'Topic: {topic}',
      })

      const tpl = registry.get('0.9.9', 'draft-x')
      expect(tpl.version).toBe('latest')
      expect(tpl.systemPrompt).toBe('Latest draft prompt.')
    })

    it('prefers the exact version over the latest fallback', () => {
      registry.register('0.4.0', 'draft-x', {
        systemPrompt: 'Pinned v0.4.0 prompt.',
        userPromptTemplate: 'Topic: {topic}',
      })
      registry.register('latest', 'draft-x', {
        systemPrompt: 'Latest prompt.',
        userPromptTemplate: 'Topic: {topic}',
      })

      const tpl = registry.get('0.4.0', 'draft-x')
      expect(tpl.version).toBe('0.4.0')
      expect(tpl.systemPrompt).toBe('Pinned v0.4.0 prompt.')
    })
  })

  describe('listVersions', () => {
    it('lists all registered versions', () => {
      registry.register('0.3.0', 'research-extract', {
        systemPrompt: 'old',
        userPromptTemplate: 'old template',
      })
      registry.register('0.4.0', 'research-extract', {
        systemPrompt: 'new',
        userPromptTemplate: 'new template',
      })
      registry.register('latest', 'research-extract', {
        systemPrompt: 'latest',
        userPromptTemplate: 'latest template',
      })

      const versions = registry.listVersions()
      expect(versions).toContain('0.3.0')
      expect(versions).toContain('0.4.0')
      expect(versions).toContain('latest')
      expect(versions).toHaveLength(3)
    })

    it('returns an empty array when nothing is registered', () => {
      expect(registry.listVersions()).toEqual([])
    })
  })

  describe('getCurrentVersion', () => {
    it('returns the active version from PROMPT_VERSION env var', () => {
      configService = createMockConfigService({ PROMPT_VERSION: '0.4.0' })
      registry = new PromptRegistry(configService)
      expect(registry.getCurrentVersion()).toBe('0.4.0')
    })

    it('defaults to "latest" when PROMPT_VERSION is not set', () => {
      // ConfigService.get(key, default) returns the default for unset keys
      configService = {
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      } as unknown as ConfigService
      registry = new PromptRegistry(configService)
      expect(registry.getCurrentVersion()).toBe('latest')
    })
  })

  describe('error handling', () => {
    it('throws when a template is not found in any version', () => {
      expect(() => registry.get('0.4.0', 'nonexistent')).toThrow(
        /not found/,
      )
    })

    it('throws when no latest fallback exists for the name', () => {
      registry.register('0.3.0', 'research-extract', {
        systemPrompt: 'old',
        userPromptTemplate: 'old template',
      })

      // No 'latest' registered for this name → should throw
      expect(() => registry.get('0.9.9', 'research-extract')).toThrow(
        /not found/,
      )
    })
  })

  describe('multiple versions of the same prompt name', () => {
    it('keeps separate templates per version for the same name', () => {
      registry.register('0.3.0', 'hook-generation', {
        systemPrompt: 'v0.3 system',
        userPromptTemplate: 'v0.3 user',
      })
      registry.register('0.4.0', 'hook-generation', {
        systemPrompt: 'v0.4 system',
        userPromptTemplate: 'v0.4 user',
      })

      const v03 = registry.get('0.3.0', 'hook-generation')
      const v04 = registry.get('0.4.0', 'hook-generation')

      expect(v03.systemPrompt).toBe('v0.3 system')
      expect(v04.systemPrompt).toBe('v0.4 system')
      expect(v03.version).toBe('0.3.0')
      expect(v04.version).toBe('0.4.0')
    })
  })
})
