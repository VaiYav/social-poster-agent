/**
 * Hashnode poster — publishes long-form articles to hashnode.io via Camoufox + LLM-in-the-loop.
 *
 * Hashnode has a markdown editor at https://hashnode.com/new. No API key needed —
 * uses persistent Camoufox context with saved login session.
 *
 * POSSE: sets canonical URL pointing back to the configured BLOG_BASE_URL.
 */
import { Injectable } from "@nestjs/common";
import { SocialNetwork } from "../../../generated/prisma/client";
import { ArticleBasePoster, type ArticlePosterDeps } from "./article-base.poster.js";
import type { IBrowserPort } from "../../../domain/ports/browser.port.js";

@Injectable()
export class HashnodePoster extends ArticleBasePoster {
  constructor(browserPort: IBrowserPort, deps: ArticlePosterDeps) {
    super(browserPort, deps);
  }

  protected getEditorUrl(): string {
    return "https://hashnode.com/new";
  }

  protected getPlatformName(): string {
    return "Hashnode";
  }

  protected getNetwork(): SocialNetwork {
    return SocialNetwork.HASHNODE;
  }
}
