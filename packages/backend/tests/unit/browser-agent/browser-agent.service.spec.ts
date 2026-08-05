/**
 * Unit tests for BrowserAgentService — LLM-in-the-loop browser engine (#47).
 *
 * Tests the 4 primitives (act, extract, observe, verify) with mocked
 * LlmService (generateVision) and mocked Playwright Page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserAgentService } from '../../../src/modules/browser-agent/browser-agent.service.js';
import type { ILlmPort, LlmResponse } from '../../../src/domain/ports/llm.port.js';
import { z } from 'zod';

// ── Mock helpers ──

/** Config that disables the screenshot cache (TTL=0) for deterministic tests */
const noCacheConfig = {
  get: <T = string>(key: string, def?: T) => {
    if (key === 'BROWSER_AGENT_CACHE_TTL_MS') return 0 as unknown as T;
    return def as T;
  },
};

/** Config with cache enabled (default TTL) for cache-specific tests */
const cacheConfig = {
  get: <T = string>(_key: string, def?: T) => def as T,
};

function createMockPage(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const locator: Record<string, unknown> = {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
  };
  locator.first = vi.fn().mockReturnValue(locator);

  return {
    url: vi.fn().mockReturnValue('https://example.com/page'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    innerText: vi.fn().mockResolvedValue('Page text content'),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue(locator),
    getByRole: vi.fn().mockReturnValue(locator),
    getByLabel: vi.fn().mockReturnValue(locator),
    accessibility: { snapshot: vi.fn().mockResolvedValue(null) },
    ...overrides,
  };
}

function createMockLlm(responses: string[]): ILlmPort {
  const generateVision = vi.fn();
  responses.forEach((response) => {
    generateVision.mockResolvedValueOnce({
      content: response,
      model: 'test-model',
      tokens: 100,
    } as LlmResponse);
  });
  // After queued responses, return a default
  generateVision.mockResolvedValue({
    content: '{"action":"done","reasoning":"default"}',
    model: 'test-model',
    tokens: 100,
  } as LlmResponse);

  return {
    generate: vi.fn(),
    generateChat: vi.fn(),
    generateVision,
    getPromptVersion: vi.fn().mockReturnValue('test'),
    getProviderStatus: vi.fn().mockReturnValue([]),
    resetCircuitBreakers: vi.fn(),
  } as unknown as ILlmPort;
}

/** Create a BrowserAgentService with cache disabled */
function createService(llm: ILlmPort, config = noCacheConfig): BrowserAgentService {
  return new BrowserAgentService(llm, config);
}

// ── Tests ──

describe('BrowserAgentService', () => {
  let service: BrowserAgentService;
  let mockLlm: ILlmPort;
  let mockPage: Record<string, unknown>;

  beforeEach(() => {
    mockLlm = createMockLlm([]);
    mockPage = createMockPage();
    service = createService(mockLlm);
  });

  describe('act()', () => {
    it('BA-001: returns success when LLM says done', async () => {
      mockLlm = createMockLlm(['{"action":"done","reasoning":"task complete"}']);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Click the publish button');

      expect(result.success).toBe(true);
      expect(result.action).toBe('task complete');
      expect(result.iterations).toBe(1);
    });

    it('BA-002: executes click action then completes', async () => {
      mockLlm = createMockLlm([
        '{"action":"click","target":"Publish","reasoning":"clicking publish"}',
        '{"action":"done","reasoning":"published"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Click the publish button');

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);
      expect(mockLlm.generateVision).toHaveBeenCalledTimes(2);
    });

    it('BA-003: executes type action with text', async () => {
      const typeLocator = {
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        isVisible: vi.fn().mockResolvedValue(true),
      };
      typeLocator.first = vi.fn().mockReturnValue(typeLocator);

      // #title is a CSS selector — the service will try page.locator('#title') first
      mockPage = createMockPage({
        locator: vi.fn().mockReturnValue(typeLocator),
      });

      mockLlm = createMockLlm([
        '{"action":"type","target":"#title","text":"My Article Title","reasoning":"typing title"}',
        '{"action":"done","reasoning":"typed"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Type the article title');

      expect(result.success).toBe(true);
      expect(typeLocator.fill).toHaveBeenCalledWith('My Article Title', { timeout: 5000 });
    });

    it('BA-004: returns failure after max iterations', async () => {
      // LLM always returns a non-done action — never completes
      mockLlm = {
        generateVision: vi.fn().mockResolvedValue({
          content: '{"action":"scroll","direction":"down","reasoning":"looking for button"}',
          model: 'test',
          tokens: 10,
        } as LlmResponse),
      } as unknown as ILlmPort;

      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Find the button');

      expect(result.success).toBe(false);
      expect(result.action).toBe('max_iterations_reached');
    });

    it('BA-005: handles screenshot failure gracefully', async () => {
      mockPage = createMockPage({
        screenshot: vi.fn().mockRejectedValue(new Error('page closed')),
      });

      const result = await service.act(mockPage as never, 'Click something');

      expect(result.success).toBe(false);
      expect(result.action).toBe('screenshot_failed');
    });
  });

  describe('extract()', () => {
    it('BA-010: extracts structured data matching schema', async () => {
      mockLlm = createMockLlm([
        '{"canonicalUrl":"https://my-zodiac-ai.com/blog/mars-in-gemini","title":"Mars in Gemini 2026"}',
      ]);
      service = createService(mockLlm);

      const schema = z.object({
        canonicalUrl: z.string(),
        title: z.string(),
      });

      const result = await service.extract(mockPage as never, schema);

      expect(result).not.toBeNull();
      expect(result?.canonicalUrl).toBe('https://my-zodiac-ai.com/blog/mars-in-gemini');
      expect(result?.title).toBe('Mars in Gemini 2026');
    });

    it('BA-011: returns null when LLM response does not match schema', async () => {
      mockLlm = createMockLlm(['{"wrongField":"value"}']);
      service = createService(mockLlm);

      const schema = z.object({ canonicalUrl: z.string() });
      const result = await service.extract(mockPage as never, schema);

      expect(result).toBeNull();
    });

    it('BA-012: returns null when LLM returns invalid JSON', async () => {
      mockLlm = createMockLlm(['not json at all']);
      service = createService(mockLlm);

      const schema = z.object({ url: z.string() });
      const result = await service.extract(mockPage as never, schema);

      expect(result).toBeNull();
    });

    it('BA-013: extracts JSON from markdown code block', async () => {
      mockLlm = createMockLlm(['```json\n{"url":"https://dev.to/article"}\n```']);
      service = createService(mockLlm);

      const schema = z.object({ url: z.string() });
      const result = await service.extract(mockPage as never, schema);

      expect(result).not.toBeNull();
      expect(result?.url).toBe('https://dev.to/article');
    });
  });

  describe('observe()', () => {
    it('BA-020: returns list of actionable elements', async () => {
      mockLlm = createMockLlm([
        JSON.stringify([
          { description: 'Publish button', type: 'button', interactable: true },
          { description: 'Title input', type: 'input', interactable: true },
          { description: 'Body textarea', type: 'textarea', interactable: true },
        ]),
      ]);
      service = createService(mockLlm);

      const result = await service.observe(mockPage as never);

      expect(result).toHaveLength(3);
      expect(result[0].description).toBe('Publish button');
      expect(result[0].type).toBe('button');
      expect(result[0].interactable).toBe(true);
    });

    it('BA-021: returns empty array when LLM returns invalid response', async () => {
      mockLlm = createMockLlm(['not an array']);
      service = createService(mockLlm);

      const result = await service.observe(mockPage as never);

      expect(result).toEqual([]);
    });
  });

  describe('verify()', () => {
    it('BA-030: returns true when LLM confirms state', async () => {
      mockLlm = createMockLlm(['true']);
      service = createService(mockLlm);

      const result = await service.verify(mockPage as never, 'Is the article published?');

      expect(result).toBe(true);
    });

    it('BA-031: returns false when LLM denies state', async () => {
      mockLlm = createMockLlm(['false']);
      service = createService(mockLlm);

      const result = await service.verify(mockPage as never, 'Is the article published?');

      expect(result).toBe(false);
    });

    it('BA-032: handles LLM response with extra text', async () => {
      mockLlm = createMockLlm(['The page shows the article is published. true']);
      service = createService(mockLlm);

      const result = await service.verify(mockPage as never, 'Is the article published?');

      expect(result).toBe(true);
    });
  });

  describe('screenshot cache', () => {
    it('BA-040: identical screenshots + prompts use cache (single LLM call)', async () => {
      // Use cacheConfig (default TTL=5min) to enable caching
      mockLlm = createMockLlm(['true']);
      service = createService(mockLlm, cacheConfig);

      await service.verify(mockPage as never, 'Is page loaded?');
      await service.verify(mockPage as never, 'Is page loaded?');

      // LLM should only be called once (second hit cache)
      expect(mockLlm.generateVision).toHaveBeenCalledTimes(1);
    });

    it('BA-041: different prompts bypass cache', async () => {
      mockLlm = createMockLlm(['true', 'false']);
      service = createService(mockLlm, cacheConfig);

      await service.verify(mockPage as never, 'Is page loaded?');
      await service.verify(mockPage as never, 'Is the button visible?');

      expect(mockLlm.generateVision).toHaveBeenCalledTimes(2);
    });
  });

  describe('JSON parsing', () => {
    it('BA-050: parseActionResponse handles valid JSON', async () => {
      mockLlm = createMockLlm(['{"action":"click","target":"button","reasoning":"test"}']);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'test');

      // Click executes, then default "done" response kicks in
      expect(result.success).toBe(true);
    });

    it('BA-051: handles JSON embedded in text', async () => {
      mockLlm = createMockLlm([
        'I think you should click the button. {"action":"click","target":"Submit","reasoning":"submitting"}',
        '{"action":"done","reasoning":"done"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Submit the form');

      expect(result.success).toBe(true);
    });
  });

  describe('error recovery', () => {
    it('BA-060: returns consecutive_failures after 3 consecutive errors', async () => {
      // LLM returns valid click action, but findElement always fails
      mockLlm = createMockLlm([
        '{"action":"click","target":"nonexistent-button","reasoning":"trying"}',
        '{"action":"click","target":"nonexistent-button","reasoning":"trying again"}',
        '{"action":"click","target":"nonexistent-button","reasoning":"still trying"}',
      ]);

      // All element-finding strategies fail
      const notFoundLocator = {
        isVisible: vi.fn().mockResolvedValue(false),
        first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
      };
      mockPage = createMockPage({
        locator: vi.fn().mockReturnValue(notFoundLocator),
        getByText: vi.fn().mockReturnValue(notFoundLocator),
        getByRole: vi.fn().mockReturnValue(notFoundLocator),
        getByLabel: vi.fn().mockReturnValue(notFoundLocator),
      });

      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Click the button');

      expect(result.success).toBe(false);
      expect(result.action).toBe('consecutive_failures');
    });

    it('BA-061: resets failure counter on successful action', async () => {
      // First action fails (element not found), second succeeds, third is done
      const goodLocator = {
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        isVisible: vi.fn().mockResolvedValue(true),
      };
      goodLocator.first = vi.fn().mockReturnValue(goodLocator);

      const badLocator = {
        isVisible: vi.fn().mockResolvedValue(false),
        first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
      };

      let callCount = 0;
      mockPage = createMockPage({
        locator: vi.fn().mockImplementation(() => {
          callCount++;
          // First call: element not found, second call: found
          if (callCount === 1) return badLocator;
          return goodLocator;
        }),
        getByText: vi.fn().mockReturnValue(badLocator),
        getByRole: vi.fn().mockReturnValue(badLocator),
        getByLabel: vi.fn().mockReturnValue(badLocator),
      });

      mockLlm = createMockLlm([
        '{"action":"click","target":"#btn","reasoning":"first try fails"}',
        '{"action":"click","target":"#btn","reasoning":"second try succeeds"}',
        '{"action":"done","reasoning":"done"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Click the button');

      // Should succeed — failure counter reset after second iteration
      expect(result.success).toBe(true);
    });
  });

  describe('navigate action', () => {
    it('BA-070: executes navigate action', async () => {
      mockLlm = createMockLlm([
        '{"action":"navigate","url":"https://dev.to/new-article","reasoning":"navigating"}',
        '{"action":"done","reasoning":"arrived"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Go to the article page');

      expect(result.success).toBe(true);
      expect(mockPage.goto).toHaveBeenCalledWith('https://dev.to/new-article', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    });

    it('BA-071: navigate without url throws error', async () => {
      mockLlm = createMockLlm([
        '{"action":"navigate","reasoning":"missing url"}',
        '{"action":"done","reasoning":"done"}',
      ]);
      service = createService(mockLlm);

      // Should still complete — error is caught and next iteration runs
      const result = await service.act(mockPage as never, 'Navigate somewhere');

      expect(result.success).toBe(true);
    });
  });

  describe('scroll action', () => {
    it('BA-080: scroll down presses PageDown', async () => {
      mockLlm = createMockLlm([
        '{"action":"scroll","direction":"down","reasoning":"scrolling"}',
        '{"action":"done","reasoning":"done"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Scroll down');

      expect(result.success).toBe(true);
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('PageDown');
    });

    it('BA-081: scroll up presses PageUp', async () => {
      mockLlm = createMockLlm([
        '{"action":"scroll","direction":"up","reasoning":"scrolling up"}',
        '{"action":"done","reasoning":"done"}',
      ]);
      service = createService(mockLlm);

      const result = await service.act(mockPage as never, 'Scroll up');

      expect(result.success).toBe(true);
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('PageUp');
    });
  });

  describe('extract edge cases', () => {
    it('BA-090: handles null from LLM (explicit null response)', async () => {
      mockLlm = createMockLlm(['null']);
      service = createService(mockLlm);

      const schema = z.object({ url: z.string() });
      const result = await service.extract(mockPage as never, schema);

      // null is valid JSON but doesn't match the schema
      expect(result).toBeNull();
    });

    it('BA-091: handles nested JSON objects', async () => {
      mockLlm = createMockLlm([
        '{"article":{"title":"Test","url":"https://dev.to/test"},"metadata":{"published":true}}',
      ]);
      service = createService(mockLlm);

      const schema = z.object({
        article: z.object({
          title: z.string(),
          url: z.string(),
        }),
        metadata: z.object({
          published: z.boolean(),
        }),
      });

      const result = await service.extract(mockPage as never, schema);

      expect(result).not.toBeNull();
      expect(result?.article.title).toBe('Test');
      expect(result?.metadata.published).toBe(true);
    });
  });
});
