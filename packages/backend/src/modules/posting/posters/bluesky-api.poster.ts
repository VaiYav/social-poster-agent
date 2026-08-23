import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SocialNetwork } from "../../../generated/prisma/client.js";
import type { BrowserContext } from "../../../domain/ports/browser-primitives.js";
import type { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { checkContentLength } from "../../posts/network-limits.js";
import type { PostResult } from "./base.poster.js";

interface PublishedRecord {
  uri: string;
  cid: string;
}

interface BlueskySession {
  accessJwt: string;
  did: string;
  handle: string;
}

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, string>>;
}

/** Official AT Protocol transport for Bluesky. BrowserPoster remains the rollback path. */
@Injectable()
export class BlueskyApiPoster {
  private readonly logger = new Logger(BlueskyApiPoster.name);
  private session: BlueskySession | null = null;
  private loginPromise: Promise<BlueskySession> | null = null;

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
    const check = checkContentLength(SocialNetwork.BLUESKY, content);
    if (!check.ok) {
      return {
        error: `Content ${check.length} chars exceeds Bluesky limit ${check.limit}`,
        retryable: false,
      };
    }

    try {
      const session = await this.getSession();
      const root = await this.createRecord(session, content);
      const url = this.toPermalink(root.uri, session.handle);
      const threadReplyResults: Array<{ index: number; success: boolean; error?: string }> = [];
      let parent = root;
      for (const [index, replyText] of (threadItems ?? []).entries()) {
        try {
          parent = await this.createRecord(session, replyText, { root, parent });
          threadReplyResults.push({ index, success: true });
        } catch (error) {
          threadReplyResults.push({
            index,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { url, ...(threadReplyResults.length > 0 ? { threadReplyResults } : {}) };
    } catch (error) {
      this.session = null;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Bluesky API post failed: ${message}`);
      return { error: `Bluesky API post failed: ${message}`, retryable: true };
    }
  }

  async verifyPermalink(url: string): Promise<string | null> {
    if (this.isDryRun()) return url;
    const parsed = this.parsePermalink(url);
    if (!parsed) return null;
    try {
      const identity = await fetch(
        `${this.publicApiBase()}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(parsed.handle)}`,
      );
      if (!identity.ok) return null;
      const { did } = (await identity.json()) as { did?: string };
      if (!did) return null;
      const response = await fetch(
        `${this.publicApiBase()}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${parsed.rkey}`)}`,
      );
      return response.ok ? url : null;
    } catch {
      return null;
    }
  }

  private async getSession(): Promise<BlueskySession> {
    if (this.session) return this.session;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const identifier = this.configService.get<string>("BLUESKY_HANDLE", "");
      const password = this.configService.get<string>("BLUESKY_APP_PASSWORD", "");
      if (!identifier || !password) {
        throw new Error("BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are required for API transport");
      }
      const response = await fetch(`${this.serviceUrl()}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (!response.ok) throw new Error(`createSession HTTP ${response.status}`);
      const session = (await response.json()) as BlueskySession;
      if (!session.accessJwt || !session.did || !session.handle) {
        throw new Error("Bluesky createSession returned an incomplete session");
      }
      this.session = session;
      return session;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async createRecord(
    session: BlueskySession,
    text: string,
    reply?: { root: PublishedRecord; parent: PublishedRecord },
  ): Promise<PublishedRecord> {
    const response = await fetch(`${this.serviceUrl()}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text,
          facets: await this.facets(text),
          createdAt: new Date().toISOString(),
          ...(reply ? { reply } : {}),
        },
      }),
    });
    if (!response.ok) throw new Error(`createRecord HTTP ${response.status}`);
    const result = (await response.json()) as PublishedRecord;
    if (!result.uri || !result.cid) throw new Error("Bluesky createRecord returned no uri/cid");
    return result;
  }

  private async facets(text: string): Promise<Facet[]> {
    const facets: Facet[] = [];
    const urlPattern = /https?:\/\/[^\s]+/g;
    for (const match of text.matchAll(urlPattern)) {
      const value = match[0];
      const start = match.index ?? 0;
      facets.push({
        index: {
          byteStart: this.byteLength(text.slice(0, start)),
          byteEnd: this.byteLength(text.slice(0, start + value.length)),
        },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: value }],
      });
    }
    const mentionPattern = /@[a-zA-Z0-9.-]+/g;
    for (const match of text.matchAll(mentionPattern)) {
      const handle = match[0].slice(1);
      const start = match.index ?? 0;
      try {
        const response = await fetch(
          `${this.publicApiBase()}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
        );
        if (!response.ok) continue;
        const identity = (await response.json()) as { did?: string };
        if (identity.did) {
          facets.push({
            index: {
              byteStart: this.byteLength(text.slice(0, start)),
              byteEnd: this.byteLength(text.slice(0, start + match[0].length)),
            },
            features: [{ $type: "app.bsky.richtext.facet#mention", did: identity.did }],
          });
        }
      } catch {
        // A failed mention lookup must not make a valid text post fail.
      }
    }
    return facets;
  }

  private toPermalink(uri: string, handle: string): string {
    const rkey = uri.split("/").pop();
    if (!rkey) throw new Error("Cannot build Bluesky permalink from API response");
    return `https://bsky.app/profile/${handle.replace(/^@/, "")}/post/${rkey}`;
  }

  private parsePermalink(url: string): { handle: string; rkey: string } | null {
    try {
      const match = new URL(url).pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)$/);
      return match?.[1] && match[2] ? { handle: match[1], rkey: match[2] } : null;
    } catch {
      return null;
    }
  }

  private serviceUrl(): string {
    return this.configService
      .get<string>("BLUESKY_SERVICE_URL", "https://bsky.social")
      .replace(/\/$/, "");
  }

  private publicApiBase(): string {
    return this.configService
      .get<string>("BLUESKY_PUBLIC_API_URL", "https://public.api.bsky.app")
      .replace(/\/$/, "");
  }

  private byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private isDryRun(): boolean {
    return this.configService.get<string>("SPA_DRY_RUN", "false") === "true";
  }

  private syntheticUrl(): string {
    const handle = this.configService.get<string>("BLUESKY_HANDLE", "dryrun").replace(/^@/, "");
    return `https://bsky.app/profile/${handle}/post/dryrun${Date.now()}`;
  }

  private syntheticReplies(threadItems?: string[]): Array<{ index: number; success: boolean }> {
    return (threadItems ?? []).map((_, index) => ({ index, success: true }));
  }
}
