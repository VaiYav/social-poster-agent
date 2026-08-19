/**
 * Dev.to poster — publishes long-form articles to dev.to via Camoufox + LLM-in-the-loop.
 *
 * Dev.to has a markdown editor at https://dev.to/new. No API key needed —
 * uses persistent Camoufox context with saved login session.
 *
 * POSSE: sets canonical URL pointing back to the configured BLOG_BASE_URL.
 */
import { Injectable } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { ArticleBasePoster, type ArticlePosterDeps } from './article-base.poster.js';
import type { IBrowserPort } from '../../../domain/ports/browser.port.js';

@Injectable()
export class DevtoPoster extends ArticleBasePoster {
  constructor(browserPort: IBrowserPort, deps: ArticlePosterDeps) {
    super(browserPort, deps);
  }

  protected getEditorUrl(): string {
    return 'https://dev.to/new';
  }

  protected getPlatformName(): string {
    return 'Dev.to';
  }

  protected getNetwork(): SocialNetwork {
    return SocialNetwork.DEVTO;
  }
}
