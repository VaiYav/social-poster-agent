// Link port — abstract contract for CTA link creation and funnel reporting.
// Implementation: ZodiacLinkClient (infrastructure/link/zodiac-link.client.ts) —
// HTTP adapter over my_zodiac_ai/back `/internal/attribution-links` (ADR-007).
// Fallback path (zodiac unavailable): buildDirectUtmUrl() from
// modules/content-enhancements/source-url.util.ts — a plain UTM-tagged URL.
// See ROADMAP_V2.md §Z4 and docs/adr/ADR-007-link-attribution-zodiac.md.

/** Social network the post is published to — maps to AttributionLink.platform (= utm_source). */
export type LinkNetwork = "X" | "THREADS" | "FACEBOOK" | string;

/**
 * Params for creating a trackable short link in zodiac-back.
 * `postId` is stored as customField `post_id` so clicks can be joined back
 * to this Post row without relying on utm_content alone.
 */
export interface CreateTrackableLinkParams {
  /** Target network — becomes AttributionLink.platform / utm_source. */
  network: LinkNetwork;
  /** Campaign identifier, e.g. `astro-daily-2026-08` or topic category. */
  campaign: string;
  /** Local Post id — forwarded as customFields.post_id. */
  postId?: string;
  /** Account handle — forwarded as utm_content when postId is absent. */
  accountHandle?: string;
  /** Override destination; defaults to ZODIAC_DEFAULT_DESTINATION_URL (quiz funnel). */
  destinationUrl?: string;
}

/** A durably created attribution link in zodiac-back. */
export interface TrackableLink {
  /** zodiac-back AttributionLink id (ObjectId string). */
  linkId: string;
  /** URL-safe slug, e.g. `Ab3xYz9_`. */
  slug: string;
  /** Full short URL, e.g. `https://quiz.my-zodiac-ai.com/r/Ab3xYz9_`. */
  shortUrl: string;
}

/** Optional time window for funnel reports. */
export interface FunnelReportParams {
  from?: Date;
  to?: Date;
}

/** Per-link funnel report from zodiac-back (clicks → conversions). */
export interface LinkFunnelReport {
  linkId: string;
  slug?: string;
  totalClicks: number;
  conversions: number;
  conversionRate: number | null;
  revenueTotal: number | null;
  currency?: string;
  /** Optional breakdowns served by zodiac-back's funnel-report.service. */
  byCountry?: Record<string, number>;
  byDevice?: Record<string, number>;
}

/**
 * Port for lead attribution links.
 *
 * Implementations MUST be non-blocking for posting:
 * callers wrap createTrackableLink() with a timeout + circuit breaker and
 * degrade to buildDirectUtmUrl() when zodiac-back is unreachable (ROADMAP_V2 M2.1).
 */
export interface ILinkPort {
  /**
   * Create a trackable short link in zodiac-back before publishing.
   *
   * @throws LinkServiceUnavailableError when zodiac-back cannot be reached or
   *   responds outside 2xx within the configured timeout — callers should
   *   catch this and fall back to buildDirectUtmUrl().
   */
  createTrackableLink(params: CreateTrackableLinkParams): Promise<TrackableLink>;

  /**
   * Fetch the per-link funnel report (clicks → conversions → revenue).
   * Used by the conversion dashboard (M2.4) and metrics aggregation.
   */
  getFunnelReport(linkId: string, params?: FunnelReportParams): Promise<LinkFunnelReport>;
}

/** Error thrown when zodiac-back is unreachable / times out / returns non-2xx. */
export class LinkServiceUnavailableError extends Error {
  constructor(
    message = "Link attribution service (zodiac-back) unavailable",
    opts?: { cause?: unknown },
  ) {
    super(message);
    this.name = "LinkServiceUnavailableError";
    if (opts?.cause) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** DI symbol token for NestJS providers. */
export const ILinkPort = Symbol("ILinkPort");
