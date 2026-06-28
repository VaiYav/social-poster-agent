/**
 * P10: Source Attribution & Fact-Linking.
 *
 * Extracts a specific blog URL from a content-source path so posts can link
 * directly to the source article instead of the generic `my-zodiac-ai.com`.
 *
 * Benefits:
 *  - Higher CTR (specific URL > generic domain)
 *  - SEO backlink to the source article
 *  - Reader satisfaction (can read more on the topic)
 *
 * Supported source path formats (see ContentReader):
 *   - brief:       ../content-agent-platform/runs/brief-{id}/brief.json  → no blog URL (use generic)
 *   - article:     ../content/blog/en/<slug>.md                        → my-zodiac-ai.com/blog/<slug>
 *   - create_run:  ../content-agent-platform/runs/create-{id}/report.json → slug extracted from report.files[0]
 *   - topic:       ../content-agent-platform/runs/topics-{id}/topic-queue.json → no blog URL
 *   - trending:    trending/<sources>                                  → no blog URL
 *
 * Locale-aware: /blog/en/ → /blog/, /blog/ru/ → /ru/blog/, etc.
 */

/** Site base URL — env-configurable for staging vs production. */
export const DEFAULT_SITE_BASE_URL = 'https://my-zodiac-ai.com';

/**
 * Extract a blog slug from a content-source path.
 * Returns null when the path does not point to a blog article.
 *
 * @example
 *   extractBlogSlug('../content/blog/en/mars-in-aries.md')           → 'mars-in-aries'
 *   extractBlogSlug('../content/blog/ru/luna-v-kozeroge.md')         → 'luna-v-kozeroge'
 *   extractBlogSlug('../content-agent-platform/runs/brief-1/brief.json') → null
 */
export function extractBlogSlug(sourcePath: string): string | null {
  if (!sourcePath || typeof sourcePath !== 'string') return null;

  // Match: .../blog/<locale>/<slug>.md
  // Locale is optional — some paths may omit it.
  const match = sourcePath.match(/blog\/(?:[a-z]{2}\/)?([^/]+)\.md$/i);
  return match?.[1] ?? null;
}

/**
 * Build a specific blog URL from a content-source path.
 * Returns null when no specific article can be resolved (caller falls back to site base URL).
 *
 * @param sourcePath  Content-source path (ContentTopic.path)
 * @param siteBaseUrl Optional site base URL (defaults to my-zodiac-ai.com)
 * @returns Specific blog URL or null
 *
 * @example
 *   buildSourceUrl('../content/blog/en/mars-in-aries.md')
 *     → 'https://my-zodiac-ai.com/blog/mars-in-aries'
 *   buildSourceUrl('../content/blog/ru/luna-v-kozeroge.md')
 *     → 'https://my-zodiac-ai.com/ru/blog/luna-v-kozeroge'
 *   buildSourceUrl('../content-agent-platform/runs/brief-1/brief.json')
 *     → null
 */
export function buildSourceUrl(sourcePath: string, siteBaseUrl = DEFAULT_SITE_BASE_URL): string | null {
  const slug = extractBlogSlug(sourcePath);
  if (!slug) return null;

  // Detect locale from path: /blog/<locale>/<slug>.md
  const localeMatch = sourcePath.match(/blog\/([a-z]{2})\//i);
  const locale = localeMatch?.[1]?.toLowerCase();

  // Non-default locales get a /<locale>/ prefix (matches Nuxt i18n routing)
  // Default locale ('en') gets no prefix — canonical URLs.
  if (locale && locale !== 'en') {
    return `${siteBaseUrl}/${locale}/blog/${slug}`;
  }
  return `${siteBaseUrl}/blog/${slug}`;
}

/**
 * Resolve the best CTA URL for a post.
 * Falls back to the site base URL when no specific article is available.
 *
 * @param sourcePath Content-source path
 * @param siteBaseUrl Optional site base URL
 * @returns Specific blog URL or the site base URL
 */
export function resolveCtaUrl(sourcePath: string, siteBaseUrl = DEFAULT_SITE_BASE_URL): string {
  return buildSourceUrl(sourcePath, siteBaseUrl) ?? siteBaseUrl;
}
