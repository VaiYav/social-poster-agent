// LinkAttributionService — M2.1 lead-funnel CTA assignment.
//
// Before a post goes out, this service creates a trackable short link in
// my_zodiac_ai/back (via ILinkPort) and persists it on Post.ctaUrl.
// Graceful degradation ladder (posting is NEVER blocked):
//   1. zodiac reachable  → short link (Post.attributionLinkId/Slug set)
//   2. zodiac down       → direct UTM URL via buildDirectUtmUrl()
//                           (attribution fields stay null = fallback marker)
//   3. no destination    → no CTA (post ships text-only)
//
// Delivery policy per network:
//   X / THREADS → "reply"  — clean post text; link goes into an immediate
//                            first reply (PostingService fires it post-verify)
//   FACEBOOK (+ others inline) → "inline" — link appended to the content

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Post } from "../../generated/prisma/client";

import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import {
  ILinkPort,
  LinkServiceUnavailableError,
} from "../../domain/ports/link.port.js";
import { buildDirectUtmUrl } from "../content-enhancements/source-url.util.js";

export type CtaDeliveryMode = "inline" | "reply";

export interface AssignedCta {
  ctaUrl: string;
  mode: CtaDeliveryMode;
  source: "zodiac" | "utm-fallback";
}

const REPLY_MODE_NETWORKS = new Set<string>(["X", "THREADS"]);

@Injectable()
export class LinkAttributionService {
  private readonly logger = new Logger(LinkAttributionService.name);

  constructor(
    @Inject(ILinkPort) private readonly linkPort: ILinkPort,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Networks whose CTA lives in a first reply instead of the post body. */
  static deliveryModeFor(network: string): CtaDeliveryMode {
    return REPLY_MODE_NETWORKS.has(network) ? "reply" : "inline";
  }

  /** Append the CTA URL to post body for inline networks (idempotent). */
  static appendInline(content: string, ctaUrl: string): string {
    if (!ctaUrl || content.includes(ctaUrl)) return content;
    return `${content}\n\n${ctaUrl}`;
  }

  /**
   * Create + persist the trackable CTA for a post. Never throws.
   * Returns null when even the fallback destination is unavailable.
   */
  async assignForPost(
    post: Pick<Post, "id" | "network" | "sourceRef" | "ctaUrl">,
  ): Promise<AssignedCta | null> {
    // Idempotency: a retry after a crash must not mint duplicate links.
    if (post.ctaUrl) {
      return {
        ctaUrl: post.ctaUrl,
        mode: LinkAttributionService.deliveryModeFor(post.network),
        source: post.ctaUrl.includes("/r/") ? "zodiac" : "utm-fallback",
      };
    }

    const campaign = this.campaignFor(post);

    // 1. Primary path — zodiac short link.
    try {
      const link = await this.linkPort.createTrackableLink({
        network: post.network,
        campaign,
        postId: post.id,
      });
      await this.prisma.post.update({
        where: { id: post.id },
        data: {
          ctaUrl: link.shortUrl,
          attributionLinkId: link.linkId,
          attributionSlug: link.slug,
        },
      });
      this.logger.log(`CTA assigned (zodiac) for ${post.id}: ${link.shortUrl}`);
      return {
        ctaUrl: link.shortUrl,
        mode: LinkAttributionService.deliveryModeFor(post.network),
        source: "zodiac",
      };
    } catch (err) {
      const message =
        err instanceof LinkServiceUnavailableError
          ? err.message
          : `unexpected: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(`Zodiac link unavailable for ${post.id} (${message}) — falling back to direct UTM`);
    }

    // 2. Fallback — direct UTM-tagged destination (R1/M0.6 builder).
    const destination = this.config.get<string>("ZODIAC_DEFAULT_DESTINATION_URL") ?? "";
    if (!destination) {
      this.logger.warn(`No ZODIAC_DEFAULT_DESTINATION_URL — shipping post ${post.id} without CTA`);
      return null;
    }
    try {
      const url = buildDirectUtmUrl(destination, {
        utmSource: post.network.toLowerCase(),
        utmCampaign: campaign,
        utmContent: post.id,
      });
      await this.prisma.post.update({
        where: { id: post.id },
        data: { ctaUrl: url }, // attributionLinkId/Slug stay null = fallback marker
      });
      this.logger.log(`CTA assigned (utm-fallback) for ${post.id}: ${url}`);
      return {
        ctaUrl: url,
        mode: LinkAttributionService.deliveryModeFor(post.network),
        source: "utm-fallback",
      };
    } catch (err) {
      this.logger.warn(
        `UTM fallback failed for ${post.id}: ${err instanceof Error ? err.message : String(err)} — shipping without CTA`,
      );
      return null;
    }
  }

  /**
   * Campaign slug: topic/category when known + YYYY-MM month bucket, e.g.
   * "astrology-daily-2026-08". Deterministic per post-source so funnel reports
   * group naturally by campaign in the zodiac admin.
   */
  private campaignFor(post: Pick<Post, "id" | "network" | "sourceRef">): string {
    const month = new Date().toISOString().slice(0, 7);
    let prefix = "spa";
    const ref = post.sourceRef as { type?: string; topic?: string } | null;
    const topicSlug = ref?.topic
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (ref?.type === "trending") prefix = "trending";
    else if (topicSlug) prefix = topicSlug;
    return `${prefix}-${month}`.slice(0, 80);
  }
}
