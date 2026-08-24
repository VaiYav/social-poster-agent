import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SocialNetwork } from "../../../generated/prisma/client.js";
import type { BrowserContext } from "../../../domain/ports/browser-primitives.js";
import type { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { checkContentLength } from "../../posts/network-limits.js";
import type { PostResult } from "./base.poster.js";

interface MastodonStatus {
  id: string;
  url?: string;
}

/** Official Mastodon REST transport. BrowserPoster remains the explicit rollback path. */
@Injectable()
export class MastodonApiPoster {
  private readonly logger = new Logger(MastodonApiPoster.name);
  private instanceLimit: number | null = null;

  constructor(private readonly configService: ConfigService) {}

  async post(
    _context: BrowserContext | null,
    _browser: IBrowserPort,
    content: string,
    threadItems?: string[],
  ): Promise<PostResult> {
    if (this.isDryRun()) {
      return { url: this.syntheticUrl(), threadReplyResults: this.syntheticReplies(threadItems) };
    }
    try {
      const limit = await this.getInstanceLimit();
      const check = checkContentLength(SocialNetwork.MASTODON, content);
      if (check.length > limit) {
        return {
          error: `Content ${check.length} chars exceeds Mastodon instance limit ${limit}`,
          retryable: false,
        };
      }
      let parentId: string | undefined;
      let root: MastodonStatus | undefined;
      for (const text of [content, ...(threadItems ?? [])]) {
        const status = await this.createStatus(text, parentId);
        root ??= status;
        parentId = status.id;
      }
      if (!root) return { error: "Mastodon API returned no root status", retryable: true };
      const replyCount = threadItems?.length ?? 0;
      return {
        url: root.url ?? this.statusUrl(root.id),
        ...(replyCount > 0
          ? { threadReplyResults: threadItems!.map((_, index) => ({ index, success: true })) }
          : {}),
      };
    } catch (error) {
      this.logger.warn(
        `Mastodon API post failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        error: `Mastodon API post failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  }

  async verifyPermalink(url: string): Promise<string | null> {
    if (this.isDryRun()) return url;
    const id = this.parseStatusId(url);
    try {
      const response = await fetch(
        id ? `${this.baseUrl()}/api/v1/statuses/${encodeURIComponent(id)}` : url,
        { headers: this.authHeaders() },
      );
      return response.ok ? url : null;
    } catch {
      return null;
    }
  }

  private async createStatus(status: string, inReplyToId?: string): Promise<MastodonStatus> {
    const body = new URLSearchParams({
      status,
      visibility: this.visibility(),
      ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}),
    });
    const response = await fetch(`${this.baseUrl()}/api/v1/statuses`, {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as MastodonStatus;
  }

  private async getInstanceLimit(): Promise<number> {
    if (this.instanceLimit !== null) return this.instanceLimit;
    try {
      const response = await fetch(`${this.baseUrl()}/api/v1/instance`);
      if (response.ok) {
        const body = (await response.json()) as {
          configuration?: { statuses?: { max_characters?: number } };
          max_toot_chars?: number;
        };
        this.instanceLimit =
          body.configuration?.statuses?.max_characters ?? body.max_toot_chars ?? 500;
      }
    } catch {
      // Use the canonical profile default when instance discovery is unavailable.
    }
    this.instanceLimit ??= 500;
    return this.instanceLimit;
  }

  private baseUrl(): string {
    const configured = this.configService.get<string>("MASTODON_BASE_URL", "");
    if (configured) return configured.replace(/\/$/, "");
    const instance = this.configService.get<string>("MASTODON_INSTANCE", "mastodon.social");
    return `https://${instance.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  }

  private authHeaders(): Record<string, string> {
    const token = this.configService.get<string>("MASTODON_ACCESS_TOKEN", "");
    if (!token) throw new Error("MASTODON_ACCESS_TOKEN is required for API transport");
    return { authorization: `Bearer ${token}` };
  }

  private visibility(): string {
    const value = this.configService.get<string>("MASTODON_VISIBILITY", "public");
    return ["public", "unlisted", "private", "direct"].includes(value) ? value : "public";
  }

  private parseStatusId(url: string): string | null {
    try {
      const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
      return segment && /^\d+$/.test(segment) ? segment : null;
    } catch {
      return null;
    }
  }

  private statusUrl(id: string): string {
    return `${this.baseUrl()}/@${this.configService.get<string>("MASTODON_USERNAME", "operator")}/${id}`;
  }

  private isDryRun(): boolean {
    return this.configService.get<string>("SPA_DRY_RUN", "false") === "true";
  }

  private syntheticUrl(): string {
    return `${this.baseUrl()}/@dryrun/${Date.now()}`;
  }

  private syntheticReplies(threadItems?: string[]): Array<{ index: number; success: boolean }> {
    return (threadItems ?? []).map((_, index) => ({ index, success: true }));
  }
}
