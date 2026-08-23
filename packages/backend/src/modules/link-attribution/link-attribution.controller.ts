// LinkAttributionController — M2.4 backend feed for the conversion dashboard.
// Aggregates zodiac funnel reports over recent CTA-bearing posts so the UI
// needs a single endpoint (per-link reports stay available via ILinkPort).

import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";

import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { ILinkPort } from "../../domain/ports/link.port.js";
import { LinkAttributionService } from "./link-attribution.service.js";

@ApiTags("link-attribution")
@Controller("link-attribution")
export class LinkAttributionController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ILinkPort) private readonly linkPort: ILinkPort,
  ) {}

  @Get("summary")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Conversion summary over recent CTA-bearing posts (clicks/conversions per post + totals)",
  })
  @ApiQuery({ name: "days", required: false, description: "Lookback window (default 30)" })
  @ApiResponse({ status: 200, description: "{ posts: [...], totals: {...}, degradedLinks: n }" })
  async summary(@Query("days") days?: string) {
    const lookbackDays = Math.min(Math.max(Number(days) || 30, 1), 365);
    const since = new Date(Date.now() - lookbackDays * 86_400_000);

    const posts = await this.prisma.post.findMany({
      where: { ctaUrl: { not: null }, createdAt: { gte: since } },
      select: {
        id: true,
        network: true,
        status: true,
        ctaUrl: true,
        attributionLinkId: true,
        attributionSlug: true,
        sourceRef: true,
        postedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    let totalClicks = 0;
    let totalConversions = 0;
    let degradedLinks = 0;

    const rows = await Promise.all(
      posts.map(async (post) => {
        const source = post.ctaUrl?.includes("/r/")
          ? "zodiac"
          : ("utm-fallback" as const);
        let clicks = 0;
        let conversions = 0;

        if (post.attributionLinkId && source === "zodiac") {
          try {
            const report = await this.linkPort.getFunnelReport(post.attributionLinkId);
            if (report.found) {
              clicks = report.totals.clicks;
              conversions = report.totals.converted;
              totalClicks += clicks;
              totalConversions += conversions;
            }
          } catch {
            degradedLinks += 1;
          }
        }

        const ref = post.sourceRef as { topic?: string } | null;
        return {
          postId: post.id,
          network: post.network,
          status: post.status,
          postedAt: post.postedAt?.toISOString() ?? null,
          topic: ref?.topic ?? null,
          ctaUrl: post.ctaUrl ?? undefined,
          attributionSlug: post.attributionSlug ?? undefined,
          deliveryMode: LinkAttributionService.deliveryModeFor(post.network),
          source,
          clicks,
          conversions,
        };
      }),
    );

    return {
      windowDays: lookbackDays,
      totals: {
        posts: rows.length,
        clicks: totalClicks,
        conversions: totalConversions,
        conversionRate: totalClicks > 0 ? Number((totalConversions / totalClicks).toFixed(4)) : null,
      },
      degradedLinks,
      posts: rows,
    };
  }
}
