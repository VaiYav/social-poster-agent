// ZodiacLinkClient — ILinkPort adapter over my_zodiac_ai/back
// `/internal/attribution-links` (ADR-007, ROADMAP_V2 Z4/M2.1).
//
// Contract with zodiac-back:
//   POST /internal/attribution-links          → AttributionLinkWithUrl
//   GET  /internal/attribution-links/:id/funnel → LinkFunnelReport
//   Auth: Authorization: Bearer $ZODIAC_INTERNAL_TOKEN (InternalAuthGuard)
//
// Failure semantics: EVERY failure (disabled config, timeout, non-2xx,
// circuit open) surfaces as LinkServiceUnavailableError so callers can fall
// back to buildDirectUtmUrl() — posting is never blocked by the link service.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { CircuitBreaker } from "../../domain/circuit-breaker.js";
import {
  LinkServiceUnavailableError,
  type CreateTrackableLinkParams,
  type FunnelReportParams,
  type ILinkPort,
  type LinkFunnelReport,
  type TrackableLink,
} from "../../domain/ports/link.port.js";

/** AttributionLinkWithUrl subset returned by zodiac-back on create. */
interface ZodiacLinkResponse {
  id: string;
  slug: string;
  shortUrl: string;
}

interface CreateLinkBody {
  platform: string;
  medium: string;
  campaign: string;
  content?: string;
  customFields?: Record<string, string>;
  destinationUrl: string;
  notes?: string;
}

@Injectable()
export class ZodiacLinkClient implements ILinkPort {
  private readonly logger = new Logger(ZodiacLinkClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultDestination: string;
  private readonly timeoutMs: number;
  private readonly breaker = new CircuitBreaker("zodiac-links", {
    failureThreshold: 3,
    resetTimeoutMs: 60_000,
    failureWindowMs: 120_000,
  });

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (this.config.get<string>("ZODIAC_API_URL") ?? "").replace(/\/+$/, "");
    this.token = this.config.get<string>("ZODIAC_INTERNAL_TOKEN", "");
    this.defaultDestination = this.config.get<string>(
      "ZODIAC_DEFAULT_DESTINATION_URL",
      "https://quiz.my-zodiac-ai.com",
    );
    this.timeoutMs = Number(this.config.get<string>("ZODIAC_TIMEOUT_MS", "5000"));
  }

  /** The port is operational only when both URL and token are configured. */
  get enabled(): boolean {
    return this.baseUrl !== "" && this.token !== "";
  }

  async createTrackableLink(params: CreateTrackableLinkParams): Promise<TrackableLink> {
    if (!this.enabled) {
      throw new LinkServiceUnavailableError(
        "Zodiac link service disabled — ZODIAC_API_URL/ZODIAC_INTERNAL_TOKEN not set",
      );
    }

    const body: CreateLinkBody = {
      // utm_source on the zodiac side; lowercase freeform ("x"/"threads"/"facebook")
      platform: params.network.toLowerCase(),
      medium: "social",
      campaign: params.campaign,
      ...(params.accountHandle && !params.postId ? { content: params.accountHandle } : {}),
      ...(params.postId ? { customFields: { post_id: params.postId } } : {}),
      destinationUrl: params.destinationUrl ?? this.defaultDestination,
      notes: `social-poster-agent${params.postId ? ` post:${params.postId}` : ""}`,
    };

    try {
      return await this.breaker.execute(async () => {
        const res = await this.request("POST", "/internal/attribution-links", body);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`create failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
        }
        const json = (await res.json()) as Partial<ZodiacLinkResponse>;
        if (!json.id || !json.slug || !json.shortUrl) {
          throw new Error("create failed: malformed response (id/slug/shortUrl missing)");
        }
        return { linkId: json.id, slug: json.slug, shortUrl: json.shortUrl };
      });
    } catch (err) {
      throw new LinkServiceUnavailableError(
        `Zodiac createTrackableLink failed for ${params.network}/${params.campaign}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async getFunnelReport(linkId: string, params?: FunnelReportParams): Promise<LinkFunnelReport> {
    if (!this.enabled) {
      throw new LinkServiceUnavailableError(
        "Zodiac link service disabled — ZODIAC_API_URL/ZODIAC_INTERNAL_TOKEN not set",
      );
    }
    const query = new URLSearchParams();
    if (params?.from) query.set("from", params.from.toISOString());
    if (params?.to) query.set("to", params.to.toISOString());
    const qs = query.toString();

    try {
      return await this.breaker.execute(async () => {
        const res = await this.request(
          "GET",
          `/internal/attribution-links/${encodeURIComponent(linkId)}/funnel${qs ? `?${qs}` : ""}`,
        );
        if (!res.ok) {
          throw new Error(`funnel report failed: HTTP ${res.status}`);
        }
        return (await res.json()) as LinkFunnelReport;
      });
    } catch (err) {
      throw new LinkServiceUnavailableError(
        `Zodiac getFunnelReport failed for ${linkId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async request(method: "POST" | "GET", path: string, body?: CreateLinkBody) {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
