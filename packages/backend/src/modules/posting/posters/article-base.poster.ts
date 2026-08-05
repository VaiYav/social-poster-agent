/**
 * Article base poster — common functionality for article-based syndication platforms.
 *
 * Platforms: Dev.to, Hashnode, LinkedIn (articles), Medium, Substack.
 * Unlike micro-post posters (X/Threads/Facebook), these platforms publish
 * long-form markdown articles with:
 *   - Title field
 *   - Body editor (markdown or rich text)
 *   - Tags
 *   - Canonical URL field (POSSE)
 *
 * Uses BrowserAgentService (#47 LLM-in-the-loop) for all interactions —
 * no hardcoded selectors. The LLM sees a screenshot + accessibility tree
 * and decides what to click/type.
 */
import { Logger } from '@nestjs/common';
import type { BrowserContext, Page } from '../../../domain/ports/browser-primitives.js';
import type { IBrowserPort } from '../../../domain/ports/browser.port.js';
import type { BrowserAgentService } from '../../browser-agent/browser-agent.service.js';
import type { ArticleContent } from '@spa/shared';
import { SocialNetwork } from '@prisma/client';
import type { CanonicalUrlService } from '../../canonical/canonical-url.service.js';

export interface ArticlePostResult {
  url?: string;
  error?: string;
  success: boolean;
  canonicalUrl?: string;
}

export interface ArticlePosterDeps {
  browserAgent: BrowserAgentService;
  canonicalService: CanonicalUrlService;
}

/**
 * Base class for article syndication posters.
 *
 * Subclasses implement `getEditorUrl()` and `getPlatformName()`.
 * The posting flow is:
 *   1. Navigate to editor URL
 *   2. LLM fills title field
 *   3. LLM fills body editor with markdown
 *   4. LLM fills tags field
 *   5. LLM sets canonical URL (POSSE)
 *   6. LLM clicks publish button
 *   7. LLM extracts published article URL
 */
export abstract class ArticleBasePoster {
  protected readonly logger: Logger;

  constructor(
    protected readonly browserPort: IBrowserPort,
    protected readonly deps: ArticlePosterDeps,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  /** The URL of the platform's article editor (e.g. https://dev.to/new) */
  protected abstract getEditorUrl(): string;

  /** Platform name for logging (e.g. 'Dev.to', 'Hashnode') */
  protected abstract getPlatformName(): string;

  /** The SocialNetwork enum value for this platform */
  protected abstract getNetwork(): SocialNetwork;

  /**
   * Publish an article to the platform.
   *
   * @param context - Browser context (persistent Camoufox context for this platform)
   * @param article - Article content (title, bodyMarkdown, tags, etc.)
   * @param canonicalUrl - POSSE canonical URL pointing back to the blog
   * @returns Result with published URL or error
   */
  async postArticle(
    context: BrowserContext,
    article: ArticleContent,
    canonicalUrl: string,
  ): Promise<ArticlePostResult> {
    const platform = this.getPlatformName();
    this.logger.log(`Posting article "${article.title}" to ${platform}`);

    let page: Page | null = null;
    try {
      // Step 1: Open a new page and navigate to the editor
      page = await context.newPage();
      const editorUrl = this.getEditorUrl();
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000); // Let SPA render

      // Step 2: LLM fills the title
      const titleResult = await this.deps.browserAgent.act(
        page as never,
        `Find the article title field and type: "${article.title}"`,
      );
      if (!titleResult.success) {
        return { success: false, error: `Failed to fill title: ${titleResult.error}` };
      }

      // Step 3: LLM fills the body editor with markdown
      const bodyResult = await this.deps.browserAgent.act(
        page as never,
        `Find the article body editor and type the following markdown content:\n\n${article.bodyMarkdown}`,
      );
      if (!bodyResult.success) {
        return { success: false, error: `Failed to fill body: ${bodyResult.error}` };
      }

      // Step 4: LLM fills tags (if the platform supports tags)
      if (article.tags.length > 0) {
        const tagsResult = await this.deps.browserAgent.act(
          page as never,
          `Find the tags input field and type these tags (comma-separated): ${article.tags.join(', ')}`,
        );
        // Tags are optional — don't fail if not found
        if (!tagsResult.success) {
          this.logger.warn(`Tags field not found or failed — skipping: ${tagsResult.error}`);
        }
      }

      // Step 5: LLM sets canonical URL (POSSE — important for SEO)
      const canonicalResult = await this.deps.browserAgent.act(
        page as never,
        `Find the canonical URL field (may be in "Settings" or "Advanced options") and type: ${canonicalUrl}`,
      );
      if (!canonicalResult.success) {
        this.logger.warn(`Canonical URL field not found — skipping: ${canonicalResult.error}`);
      }

      // Step 6: LLM clicks the publish button
      const publishResult = await this.deps.browserAgent.act(
        page as never,
        'Find and click the "Publish" button to publish the article',
      );
      if (!publishResult.success) {
        return { success: false, error: `Failed to click publish: ${publishResult.error}` };
      }

      // Step 7: Wait for navigation + extract published URL
      await page.waitForTimeout(3000); // Let publish complete

      const urlSchema = z.object({ url: z.string().url() });
      const extracted = await this.deps.browserAgent.extract(
        page as never,
        urlSchema,
      );

      if (!extracted || !extracted.url) {
        this.logger.warn('Could not extract published URL — article may still be published');
        return {
          success: true,
          canonicalUrl,
          url: page.url(), // Fallback to current page URL
        };
      }

      // Step 8: Record syndicated URL
      this.logger.log(`Article published on ${platform}: ${extracted.url}`);
      return {
        success: true,
        url: extracted.url,
        canonicalUrl,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to post article to ${platform}: ${msg}`);
      return { success: false, error: msg };
    } finally {
      if (page) {
        await page.close().catch(() => void 0);
      }
    }
  }
}

// Inline z import to avoid circular dependency issues
import { z } from 'zod';
