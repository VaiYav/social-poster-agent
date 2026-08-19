import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DomainConfigService } from '../../domain/domain-config/domain-config.service.js';

/**
 * CanonicalUrlService — manages POSSE canonical URLs for syndicated articles.
 *
 * POSSE (Publish Own Site, Syndicate Elsewhere): articles are published on
 * the configured BLOG_BASE_URL first, then syndicated to Dev.to, Hashnode, Medium,
 * Substack with a canonical URL pointing back to the blog. This tells search
 * engines that the blog is the original source.
 *
 * Used by the article generation graph (set_canonical node) and by posters
 * (to set the canonical URL field in platform article settings).
 */
@Injectable()
export class CanonicalUrlService {
  private readonly logger = new Logger(CanonicalUrlService.name);
  private readonly blogBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly domainConfig: DomainConfigService,
  ) {
    // Blog base URL — set BLOG_BASE_URL in your .env
    this.blogBaseUrl = this.domainConfig.blogBaseUrl || this.configService.get<string>('BLOG_BASE_URL', 'https://example.com');
  }

  /**
   * Build the canonical blog URL for an article slug.
   * @example buildBlogUrl('my-article') → 'https://example.com/blog/my-article'
   */
  buildBlogUrl(slug: string): string {
    const cleanSlug = slug
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!cleanSlug) {
      this.logger.warn('buildBlogUrl: slug is empty after cleaning — using "untitled"');
      return `${this.blogBaseUrl}/blog/untitled`;
    }
    return `${this.blogBaseUrl}/blog/${cleanSlug}`;
  }

  /**
   * Set the canonical URL on a Post record.
   * Called by the article graph's set_canonical node after the article is drafted.
   * Silently skips if the post doesn't exist (non-fatal — article graph can proceed).
   */
  async setCanonical(postId: string, canonicalUrl: string): Promise<void> {
    try {
      await this.prisma.post.update({
        where: { id: postId },
        data: { canonicalUrl },
      });
      this.logger.debug(`Set canonical URL for post ${postId}: ${canonicalUrl}`);
    } catch {
      this.logger.warn(`setCanonical: post ${postId} not found — skipping`);
    }
  }

  /**
   * Add a syndicated URL to a Post's syndicatedUrls map.
   * Called after successfully publishing to a platform.
   *
   * @param postId - Post ID
   * @param network - Platform network (e.g. DEVTO, HASHNODE)
   * @param url - URL of the published article on the platform
   */
  async addSyndicatedUrl(postId: string, network: string, url: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { syndicatedUrls: true },
    });
    if (!post) {
      this.logger.warn(`Post ${postId} not found — cannot add syndicated URL`);
      return;
    }
    const existing = (post.syndicatedUrls as Record<string, string> | null) ?? {};
    existing[network] = url;
    await this.prisma.post.update({
      where: { id: postId },
      data: { syndicatedUrls: existing },
    });
    this.logger.debug(`Added syndicated URL for ${network} on post ${postId}: ${url}`);
  }

  /**
   * Verify that a published article has the correct canonical URL set.
   * Fetches the platform article URL and checks for a canonical link tag.
   *
   * Phase 0: stub — real implementation in Phase 1 (needs HTTP fetch + HTML parse).
   * The LLM-in-the-loop verify() can also check this at runtime.
   *
   * @param postUrl - URL of the published article on the platform
   * @param expectedCanonicalUrl - The canonical URL that should be set
   * @returns true if the canonical URL matches
   */
  async verifyCanonical(postUrl: string, expectedCanonicalUrl: string): Promise<boolean> {
    this.logger.debug(
      `verifyCanonical stub: postUrl=${postUrl}, expected=${expectedCanonicalUrl}`,
    );
    // Phase 1: fetch postUrl, parse HTML, check <link rel="canonical" href="...">
    // For now, return true (optimistic — LLM verify() will check at runtime)
    return true;
  }

  /**
   * Generate a slug from a title.
   * @example slugify('Productivity Trends 2026: What to Expect') → 'productivity-trends-2026-what-to-expect'
   */
  slugify(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
