/**
 * P1-07: IndexNow listener.
 *
 * Listens for POST_VERIFIED and submits the canonical (owned) URL and any
 * syndicated URL to the IndexNow protocol. IndexNow is primarily for the POSSE
 * source, but it also accepts the syndicated copy when one is available.
 */
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ConfigService } from "@nestjs/config";
import { IndexNowService } from "../../infrastructure/indexnow/indexnow.service";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import type { PostVerifiedEvent } from "../post-verified.event.js";

@Injectable()
export class IndexNowListener {
  private readonly logger = new Logger(IndexNowListener.name);
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly indexNow: IndexNowService,
  ) {
    this.enabled = parseBool(this.configService.get<string>("INDEXNOW_ENABLED", "false"));
  }

  @OnEvent("post.post_verified")
  async handlePostVerified(payload: PostVerifiedEvent): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`IndexNow disabled — skipping POST_VERIFIED for ${payload.postId}`);
      return;
    }

    const urls = [
      ...new Set(
        [payload.canonicalUrl, payload.syndicatedUrl, payload.postUrl].filter((u): u is string =>
          Boolean(u),
        ),
      ),
    ];

    if (urls.length === 0) {
      this.logger.debug(`IndexNow: no URL to submit for ${payload.postId}`);
      return;
    }

    try {
      this.logger.log(
        `IndexNow: submitting ${urls.length} URL(s) for ${payload.postId} (${payload.network})`,
      );
      await this.indexNow.submit(urls);
    } catch (err) {
      this.logger.error(
        `IndexNow listener failed for ${payload.postId}: ${(err as Error).message}`,
      );
      // NEVER rethrow — event listeners must be fire-and-forget.
    }
  }
}
