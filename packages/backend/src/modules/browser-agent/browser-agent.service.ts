import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Page } from '../../domain/ports/browser-primitives.js';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import type {
  LLMActionResult,
  ObservableElement,
} from '../../domain/ports/browser.port.js';
import type { ZodSchema } from 'zod';

/**
 * BrowserAgentService — LLM-in-the-loop browser automation engine (#47).
 *
 * Implements the 4 IBrowserPort LLM primitives:
 * - act(instruction)      — execute a natural-language action via LLM vision
 * - extract(schema)       — extract structured data from page via LLM vision
 * - observe()             — list actionable elements on page via LLM vision
 * - verify(stateDesc)     — verify page state via LLM vision
 *
 * Pattern: browser-use / Stagehand / Skyvern
 *   screenshot + simplified DOM → LLM decides → execute via Playwright
 *   No hardcoded CSS selectors — eliminates selector drift entirely.
 *
 * Flow (act):
 *   1. Screenshot page (Camoufox page.screenshot)
 *   2. Extract simplified DOM context (accessibility tree)
 *   3. Send to LlmService.generateVision() (screenshot + DOM + instruction)
 *   4. Parse LLM response (action type + target + params)
 *   5. Execute action via Playwright (click, type, scroll, navigate, wait)
 *   6. Check if task complete (LLM verify call)
 *   7. If not complete → loop back to step 1 (max MAX_ITERATIONS)
 *
 * Safety:
 * - Max iterations (default 10) prevents infinite loops
 * - SHA256 screenshot cache (5-min TTL) — identical screenshots skip LLM call
 * - temperature=0 for deterministic vision output
 * - Errors are caught and returned as failed LLMActionResult
 *
 * Cost:
 * - Free-first router (Groq → SambaNova → ... → Ollama)
 * - 5-min SHA256 cache for identical screenshots
 * - ~30-90 sec per act() call (LLM thinking time)
 * - BullMQ queue handles async — no real-time requirement
 */
@Injectable()
export class BrowserAgentService {
  private readonly logger = new Logger(BrowserAgentService.name);
  private readonly maxIterations: number;
  private readonly cacheTtlMs: number;
  private readonly screenshotCache = new Map<string, { response: string; expiresAt: number }>();

  constructor(
    @Inject(ILlmPort) private readonly llm: ILlmPort,
    @Optional() configService?: { get: <T = string>(key: string, defaultValue?: T) => T },
  ) {
    this.maxIterations = Number(configService?.get('BROWSER_AGENT_MAX_ITERATIONS', '10') ?? 10);
    this.cacheTtlMs = Number(configService?.get('BROWSER_AGENT_CACHE_TTL_MS', '300000') ?? 300000); // 5 min
  }

  // ============================================================
  // act() — execute a natural-language instruction
  // ============================================================

  async act(page: Page, instruction: string): Promise<LLMActionResult> {
    this.logger.log(`act: "${instruction}"`);

    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      try {
        // Step 1: Screenshot
        const screenshot = await this.captureScreenshot(page);
        if (!screenshot) {
          return { success: false, action: 'screenshot_failed', error: 'Failed to capture screenshot' };
        }

        // Step 2: Extract DOM context
        const domContext = await this.extractDomContext(page);

        // Step 3: Ask LLM what action to take
        const systemPrompt = `You are a browser automation agent. You see a screenshot of a web page and a simplified DOM context. Your task is to perform the following instruction: "${instruction}"

Analyze the screenshot and DOM, then decide what action to take next. Respond in JSON format:
{
  "action": "click" | "type" | "scroll" | "navigate" | "wait" | "done" | "extract",
  "target": "<element description or selector>",
  "text": "<text to type, if action is 'type'>",
  "url": "<URL to navigate to, if action is 'navigate'>",
  "direction": "up" | "down", (if action is 'scroll')
  "reasoning": "<brief explanation of why this action>"
}

If the instruction is already complete, respond with {"action": "done", "reasoning": "..."}.
If you need to extract data, respond with {"action": "extract", "target": "...", "reasoning": "..."}.`;

        const userPrompt = `Instruction: ${instruction}

Current URL: ${page.url()}
DOM context (simplified):
${domContext}

What action should I take next?`;

        const cacheKey = this.cacheKey(screenshot, userPrompt);
        const cached = this.getCached(cacheKey);
        let response: string;

        if (cached) {
          this.logger.debug(`act: LLM response from cache (iteration ${iteration + 1})`);
          response = cached;
        } else {
          const llmResponse = await this.llm.generateVision(systemPrompt, userPrompt, screenshot, {
            role: 'vision',
            temperature: 0,
            maxTokens: 500,
          });
          response = llmResponse.content;
          this.setCached(cacheKey, response);
        }

        // Step 4: Parse LLM response
        const parsed = this.parseActionResponse(response);
        if (!parsed) {
          this.logger.warn(`act: failed to parse LLM response (iteration ${iteration + 1}): ${response.slice(0, 200)}`);
          continue;
        }

        this.logger.debug(
          `act: iteration ${iteration + 1}, action=${parsed.action}, target=${parsed.target ?? 'N/A'}`,
        );

        // Step 5: Execute action
        if (parsed.action === 'done') {
          return {
            success: true,
            action: parsed.reasoning ?? 'task complete',
            iterations: iteration + 1,
          };
        }

        await this.executeAction(page, parsed);

        // Action executed successfully — reset failure counter
        consecutiveFailures = 0;

        // Step 6: Brief pause for page to settle
        await page.waitForTimeout(500);
      } catch (error) {
        consecutiveFailures++;
        this.logger.warn(
          `act: iteration ${iteration + 1} failed (${consecutiveFailures}/${maxConsecutiveFailures}): ${error instanceof Error ? error.message : String(error)}`,
        );
        // Too many consecutive failures — page may be in an unrecoverable state
        if (consecutiveFailures >= maxConsecutiveFailures) {
          return {
            success: false,
            action: 'consecutive_failures',
            error: `${consecutiveFailures} consecutive failures during "${instruction}" — page may be stuck`,
            iterations: iteration + 1,
          };
        }
        // Continue to next iteration — LLM may recover
      }
    }

    return {
      success: false,
      action: 'max_iterations_reached',
      error: `Failed to complete "${instruction}" in ${this.maxIterations} iterations`,
      iterations: this.maxIterations,
    };
  }

  // ============================================================
  // extract() — extract structured data from page
  // ============================================================

  async extract<T>(page: Page, schema: ZodSchema<T>): Promise<T | null> {
    this.logger.debug(`extract: schema=${schema.description ?? 'unnamed'}`);

    try {
      const screenshot = await this.captureScreenshot(page);
      if (!screenshot) return null;

      const domContext = await this.extractDomContext(page);
      const schemaStr = this.describeSchema(schema);

      const systemPrompt = `You are a data extraction agent. You see a screenshot of a web page and a simplified DOM context. Extract the requested data from the page.

The data must match this schema:
${schemaStr}

Respond with ONLY the JSON data, no markdown, no explanation. If the data is not visible on the page, respond with null.`;

      const userPrompt = `Extract data from this page.

Current URL: ${page.url()}
DOM context (simplified):
${domContext}

Respond with JSON matching the schema above:`;

      const cacheKey = this.cacheKey(screenshot, userPrompt);
      const cached = this.getCached(cacheKey);
      let response: string;

      if (cached) {
        this.logger.debug('extract: LLM response from cache');
        response = cached;
      } else {
        const llmResponse = await this.llm.generateVision(systemPrompt, userPrompt, screenshot, {
          role: 'vision',
          temperature: 0,
          maxTokens: 1000,
        });
        response = llmResponse.content;
        this.setCached(cacheKey, response);
      }

      // Parse and validate against schema
      const json = this.extractJson(response);
      if (json === null) {
        this.logger.warn(`extract: failed to parse JSON from LLM response: ${response.slice(0, 200)}`);
        return null;
      }

      const result = schema.safeParse(json);
      if (!result.success) {
        this.logger.warn(`extract: schema validation failed: ${result.error.message}`);
        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.warn(`extract failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ============================================================
  // observe() — list actionable elements on page
  // ============================================================

  async observe(page: Page): Promise<ObservableElement[]> {
    this.logger.debug('observe: listing actionable elements');

    try {
      const screenshot = await this.captureScreenshot(page);
      if (!screenshot) return [];

      const domContext = await this.extractDomContext(page);

      const systemPrompt = `You are a browser observation agent. You see a screenshot of a web page and a simplified DOM context. List all actionable elements on the page (buttons, links, input fields, textareas, selects, etc.).

Respond in JSON array format:
[
  {
    "description": "<human-readable description of the element>",
    "type": "button" | "link" | "input" | "textarea" | "select" | "other",
    "interactable": true | false
  }
]

List up to 20 elements. Focus on the most important ones.`;

      const userPrompt = `List actionable elements on this page.

Current URL: ${page.url()}
DOM context (simplified):
${domContext}

Respond with JSON array:`;

      const cacheKey = this.cacheKey(screenshot, userPrompt);
      const cached = this.getCached(cacheKey);
      let response: string;

      if (cached) {
        this.logger.debug('observe: LLM response from cache');
        response = cached;
      } else {
        const llmResponse = await this.llm.generateVision(systemPrompt, userPrompt, screenshot, {
          role: 'vision',
          temperature: 0,
          maxTokens: 1500,
        });
        response = llmResponse.content;
        this.setCached(cacheKey, response);
      }

      const json = this.extractJson(response);
      if (!json || !Array.isArray(json)) {
        this.logger.warn(`observe: failed to parse JSON array from LLM response`);
        return [];
      }

      return json.map((el: Record<string, unknown>) => ({
        description: String(el['description'] ?? ''),
        type: String(el['type'] ?? 'other'),
        interactable: Boolean(el['interactable'] ?? true),
      }));
    } catch (error) {
      this.logger.warn(`observe failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ============================================================
  // verify() — verify page state
  // ============================================================

  async verify(page: Page, stateDescription: string): Promise<boolean> {
    this.logger.debug(`verify: "${stateDescription}"`);

    try {
      const screenshot = await this.captureScreenshot(page);
      if (!screenshot) return false;

      const systemPrompt = `You are a page state verification agent. You see a screenshot of a web page. Determine if the page matches the described state.

Respond with ONLY "true" or "false" — no other text.`;

      const userPrompt = `Does this page match the following state description?

State: "${stateDescription}"
Current URL: ${page.url()}

Respond with true or false:`;

      const cacheKey = this.cacheKey(screenshot, userPrompt);
      const cached = this.getCached(cacheKey);
      let response: string;

      if (cached) {
        this.logger.debug('verify: LLM response from cache');
        response = cached;
      } else {
        const llmResponse = await this.llm.generateVision(systemPrompt, userPrompt, screenshot, {
          role: 'vision',
          temperature: 0,
          maxTokens: 10,
        });
        response = llmResponse.content;
        this.setCached(cacheKey, response);
      }

      const normalized = response.trim().toLowerCase();
      // Check if response contains "true" (LLMs may add explanatory text)
      const result = normalized.includes('true') && !normalized.startsWith('false');
      this.logger.debug(`verify: "${stateDescription}" → ${result}`);
      return result;
    } catch (error) {
      this.logger.warn(`verify failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  /**
   * Capture a screenshot as base64 PNG data URL.
   * Uses Playwright's page.screenshot() with type='png'.
   * Returns null if screenshot fails.
   */
  private async captureScreenshot(page: Page): Promise<string | null> {
    try {
      const buffer = await page.screenshot({
        type: 'png',
        fullPage: false,
        // Scale down for faster LLM processing + lower token cost
        scale: 'device',
      });
      const base64 = buffer.toString('base64');
      return `data:image/png;base64,${base64}`;
    } catch (error) {
      this.logger.warn(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Extract a simplified DOM context from the page.
   * Uses Playwright's accessibility snapshot for a clean, LLM-friendly view.
   * Falls back to page.innerText() if accessibility snapshot fails.
   */
  private async extractDomContext(page: Page): Promise<string> {
    try {
      // Try accessibility snapshot first — gives a clean tree of interactive elements
      // playwright-core types don't expose `accessibility` directly, but it exists at runtime
      const pageWithA11y = page as Page & { accessibility?: { snapshot(): Promise<unknown> } };
      const snapshot = await pageWithA11y.accessibility?.snapshot();
      if (snapshot) {
        return this.formatAccessibilityTree(snapshot as AccessibilityNode, 0);
      }
    } catch {
      // Accessibility snapshot can fail on some pages — fall back to text
    }

    // Fallback: extract visible text content (truncated for token budget)
    try {
      const text = await page.innerText('body');
      return text.slice(0, 3000);
    } catch {
      return '(unable to extract DOM context)';
    }
  }

  /**
   * Format an accessibility snapshot into a readable tree string.
   * Truncates deep trees to keep token budget reasonable.
   */
  private formatAccessibilityTree(
    node: AccessibilityNode,
    depth: number,
    maxDepth = 4,
  ): string {
    if (depth > maxDepth) return '';

    const indent = '  '.repeat(depth);
    const role = node.role ?? 'unknown';
    const name = node.name ? ` "${node.name.slice(0, 80)}"` : '';
    const value = node.value ? ` [value: ${String(node.value).slice(0, 50)}]` : '';

    let result = `${indent}[${role}]${name}${value}\n`;

    if (Array.isArray(node.children)) {
      for (const child of node.children.slice(0, 20)) {
        result += this.formatAccessibilityTree(child, depth + 1, maxDepth);
      }
    }

    // Truncate at ~3000 chars to keep token budget reasonable
    if (result.length > 3000) {
      result = result.slice(0, 3000) + '\n... (truncated)';
    }

    return result;
  }

  /**
   * Execute a parsed LLM action on the page.
   */
  private async executeAction(
    page: Page,
    action: ParsedAction,
  ): Promise<void> {
    switch (action.action) {
      case 'click': {
        if (!action.target) throw new Error('click action requires target');
        // Try to find element by text first, then by selector
        const locator = await this.findElement(page, action.target);
        if (locator) {
          await locator.click({ timeout: 5000 }).catch((e) => {
            throw new Error(`click failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        } else {
          throw new Error(`click: element not found for "${action.target}"`);
        }
        break;
      }

      case 'type': {
        if (!action.target || !action.text) throw new Error('type action requires target and text');
        const locator = await this.findElement(page, action.target);
        if (locator) {
          await locator.fill(action.text, { timeout: 5000 }).catch((e) => {
            throw new Error(`type failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        } else {
          throw new Error(`type: element not found for "${action.target}"`);
        }
        break;
      }

      case 'scroll': {
        const direction = action.direction ?? 'down';
        await page.keyboard.press(direction === 'up' ? 'PageUp' : 'PageDown');
        break;
      }

      case 'navigate': {
        if (!action.url) throw new Error('navigate action requires url');
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }

      case 'wait': {
        await page.waitForTimeout(2000);
        break;
      }

      case 'done':
      case 'extract':
        // No-op — these are signals, not actions
        break;

      default:
        this.logger.warn(`Unknown action type: ${action.action}`);
    }
  }

  /**
   * Find an element on the page by description or selector.
   * The LLM provides a natural-language description; we try multiple strategies:
   * 1. If it looks like a CSS selector → use it directly
   * 2. If it's text → use getByText
   * 3. If it's a role/label → use getByRole
   */
  private async findElement(page: Page, target: string) {
    // Strategy 1: CSS selector (starts with #, ., [, or is a tag name)
    if (/^[#.\[]/.test(target) || /^[a-z]+$/.test(target)) {
      try {
        const loc = page.locator(target).first();
        if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
          return loc;
        }
      } catch {
        // Not a valid selector — try next strategy
      }
    }

    // Strategy 2: getByText
    try {
      const loc = page.getByText(target, { exact: false }).first();
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        return loc;
      }
    } catch {
      // Text not found — try next strategy
    }

    // Strategy 3: getByRole with name
    try {
      const loc = page.getByRole('button', { name: target, exact: false }).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        return loc;
      }
    } catch {
      // Role not found
    }

    // Strategy 4: getByLabel
    try {
      const loc = page.getByLabel(target, { exact: false }).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        return loc;
      }
    } catch {
      // Label not found
    }

    return null;
  }

  /**
   * Parse the LLM's JSON response into a structured action.
   */
  private parseActionResponse(response: string): ParsedAction | null {
    const json = this.extractJson(response);
    if (!json || typeof json !== 'object') return null;

    const obj = json as Record<string, unknown>;
    const direction = obj['direction'];
    return {
      action: String(obj['action'] ?? 'unknown'),
      target: obj['target'] ? String(obj['target']) : undefined,
      text: obj['text'] ? String(obj['text']) : undefined,
      url: obj['url'] ? String(obj['url']) : undefined,
      direction: direction === 'up' || direction === 'down' ? direction : undefined,
      reasoning: obj['reasoning'] ? String(obj['reasoning']) : undefined,
    };
  }

  /**
   * Extract JSON from an LLM response that may contain markdown fences or extra text.
   */
  private extractJson(response: string): unknown {
    // Try direct parse first
    try {
      return JSON.parse(response);
    } catch {
      // Not pure JSON — try to extract from markdown code block
    }

    // Try extracting from ```json ... ``` block
    const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch?.[1]) {
      try {
        return JSON.parse(jsonBlockMatch[1].trim());
      } catch {
        // Invalid JSON in code block
      }
    }

    // Try finding first { or [ and last } or ]
    const firstBrace = response.indexOf('{');
    const lastBrace = response.lastIndexOf('}');
    const firstBracket = response.indexOf('[');
    const lastBracket = response.lastIndexOf(']');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(response.slice(firstBrace, lastBrace + 1));
      } catch {
        // Invalid JSON
      }
    }

    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try {
        return JSON.parse(response.slice(firstBracket, lastBracket + 1));
      } catch {
        // Invalid JSON
      }
    }

    return null;
  }

  /**
   * Describe a Zod schema as a string for the LLM prompt.
   */
  private describeSchema(schema: ZodSchema): string {
    // Zod schemas have a description property and can be introspected
    const desc = (schema as { description?: string }).description;
    if (desc) return desc;

    // Fallback: use the schema's shape if available
    try {
      const shape = (schema as { _def?: { shape?: Record<string, unknown> } })._def?.shape;
      if (shape) {
        return JSON.stringify(Object.keys(shape));
      }
    } catch {
      // Schema introspection failed
    }

    return '(schema description unavailable — extract the most relevant data from the page)';
  }

  // ============================================================
  // Screenshot cache (SHA256, 5-min TTL)
  // ============================================================

  private cacheKey(screenshot: string, prompt: string): string {
    const hash = createHash('sha256');
    hash.update(screenshot);
    hash.update(prompt);
    return hash.digest('hex');
  }

  private getCached(key: string): string | null {
    const entry = this.screenshotCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.screenshotCache.delete(key);
      return null;
    }
    return entry.response;
  }

  private setCached(key: string, response: string): void {
    // TTL=0 means caching is disabled
    if (this.cacheTtlMs <= 0) return;

    this.screenshotCache.set(key, {
      response,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    // Periodic cleanup: remove expired entries (every ~100 inserts)
    if (this.screenshotCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.screenshotCache) {
        if (now > v.expiresAt) {
          this.screenshotCache.delete(k);
        }
      }
    }
  }
}

// ============================================================
// Internal types
// ============================================================

interface ParsedAction {
  action: string;
  target?: string;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  reasoning?: string;
}

/** Accessibility tree node from Playwright's page.accessibility.snapshot() */
interface AccessibilityNode {
  role?: string;
  name?: string;
  value?: string;
  children?: AccessibilityNode[];
}
