/**
 * P10: Source Attribution & Fact-Linking.
 *
 * Extracts a specific blog URL from a content-source path so posts can link
 * directly to the source article instead of a generic domain.
 *
 * Benefits:
 *  - Higher CTR (specific URL > generic domain)
 *  - SEO backlink to the source article
 *  - Reader satisfaction (can read more on the topic)
 *
 * Supported source path formats (see ContentReader):
 *   - brief:       .../runs/brief-{id}/brief.json  → no blog URL (use generic)
 *   - article:     .../content/blog/<locale>/<slug>.md  → /blog/<slug>
 *   - create_run:  .../runs/create-{id}/report.json → slug extracted from report.files[0]
 *   - topic:       .../runs/topics-{id}/topic-queue.json → no blog URL
 *   - trending:    trending/<sources>                  → no blog URL
 *
 * Locale-aware: /blog/en/ → /blog/, /blog/ru/ → /ru/blog/, etc.
 */

/** Site base URL — env-configurable for staging vs production. */
export const DEFAULT_SITE_BASE_URL = "";

/**
 * Extract a blog slug from a content-source path.
 * Returns null when the path does not point to a blog article.
 *
 * @example
 *   extractBlogSlug('../content/blog/en/example-post.md')           → 'example-post'
 *   extractBlogSlug('../content/blog/ru/primer.md')                 → 'primer'
 *   extractBlogSlug('../content-agent-platform/runs/brief-1/brief.json') → null
 */
export function extractBlogSlug(sourcePath: string): string | null {
  if (!sourcePath || typeof sourcePath !== "string") return null;

  const match = sourcePath.match(/blog\/(?:[a-z]{2}\/)?([^/]+)\.md$/i);
  return match?.[1] ?? null;
}

/**
 * Build a specific blog URL from a content-source path.
 * Returns null when no specific article can be resolved (caller falls back to site base URL).
 *
 * @param sourcePath  Content-source path (ContentTopic.path)
 * @param siteBaseUrl Optional site base URL (defaults to empty string)
 * @returns Specific blog URL or null
 *
 * @example
 *   buildSourceUrl('../content/blog/en/example-post.md', 'https://example.com')
 *     → 'https://example.com/blog/example-post'
 *   buildSourceUrl('../content/blog/ru/primer.md', 'https://example.com')
 *     → 'https://example.com/ru/blog/primer'
 *   buildSourceUrl('../content-agent-platform/runs/brief-1/brief.json')
 *     → null
 */
export function buildSourceUrl(
  sourcePath: string,
  siteBaseUrl = DEFAULT_SITE_BASE_URL,
): string | null {
  const slug = extractBlogSlug(sourcePath);
  if (!slug) return null;

  const localeMatch = sourcePath.match(/blog\/([a-z]{2})\//i);
  const locale = localeMatch?.[1]?.toLowerCase();

  if (locale && locale !== "en") {
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

// ── ROADMAP_V2 Z4 / M0.6: direct UTM fallback builder ──
// Core of the ILinkPort graceful-degradation path: when zodiac-back is
// unreachable (LinkServiceUnavailableError), callers tag the destination URL
// directly instead of embedding a trackable short link. Clicks then land
// un-attributed at zodiac (UTM params still reach PostHog), but posting is
// never blocked by the link service.

/** Params for {@link buildDirectUtmUrl}. */
export interface DirectUtmParams {
  /** utm_source — the publishing network (X / THREADS / FACEBOOK / …). Required. */
  utmSource: string;
  /** utm_medium — defaults to 'social' (matches AttributionLink.medium default). */
  utmMedium?: string;
  /** utm_campaign — campaign or topic category identifier. */
  utmCampaign?: string;
  /** utm_content — post id or account handle. */
  utmContent?: string;
}

/**
 * Append UTM query params to a destination URL without destroying existing ones.
 * Deterministic param order (utm_source → medium → campaign → content) so the
 * same inputs always yield byte-identical URLs (stable SimHash / dedup).
 *
 * @throws TypeError when destinationUrl is not an absolute http(s) URL.
 *
 * @example
 *   buildDirectUtmUrl('https://quiz.my-zodiac-ai.com', { utmSource: 'X', utmCampaign: 'astro-daily', utmContent: 'post-1' })
 *     → 'https://quiz.my-zodiac-ai.com/?utm_source=X&utm_medium=social&utm_campaign=astro-daily&utm_content=post-1'
 *   buildDirectUtmUrl('https://quiz.my-zodiac-ai.com/?lang=en', { utmSource: 'THREADS' })
 *     → 'https://quiz.my-zodiac-ai.com/?lang=en&utm_source=THREADS&utm_medium=social'
 */
export function buildDirectUtmUrl(destinationUrl: string, params: DirectUtmParams): string {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    throw new TypeError(`buildDirectUtmUrl: destinationUrl is not a valid URL: ${destinationUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`buildDirectUtmUrl: destinationUrl must use http/https: ${destinationUrl}`);
  }
  if (!params?.utmSource || typeof params.utmSource !== "string") {
    throw new TypeError("buildDirectUtmUrl: params.utmSource is required");
  }

  const utm: ReadonlyArray<readonly [string, string]> = [
    ["utm_source", params.utmSource],
    ["utm_medium", params.utmMedium ?? "social"],
    ...(params.utmCampaign ? ([["utm_campaign", params.utmCampaign]] as const) : []),
    ...(params.utmContent ? ([["utm_content", params.utmContent]] as const) : []),
  ];
  for (const [key, value] of utm) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}
