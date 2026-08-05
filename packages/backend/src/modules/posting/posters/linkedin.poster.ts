/**
 * LinkedIn poster — publishes long-form articles to LinkedIn via Camoufox + LLM-in-the-loop.
 *
 * LinkedIn articles are published at https://www.linkedin.com/article/new.
 * No OAuth — uses persistent Camoufox context with saved login session.
 *
 * POSSE: sets canonical URL pointing back to my-zodiac-ai.com/blog.
 *
 * Note: LinkedIn requires the user to have "Creator Mode" enabled to publish
 * articles. The LLM-in-the-loop approach handles this gracefully — if the
 * article editor is not available, the LLM will report the failure.
 */
import { Injectable } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { ArticleBasePoster, type ArticlePosterDeps } from './article-base.poster.js';
import type { IBrowserPort } from '../../../domain/ports/browser.port.js';

@Injectable()
export class LinkedinPoster extends ArticleBasePoster {
  constructor(browserPort: IBrowserPort, deps: ArticlePosterDeps) {
    super(browserPort, deps);
  }

  protected getEditorUrl(): string {
    return 'https://www.linkedin.com/article/new';
  }

  protected getPlatformName(): string {
    return 'LinkedIn';
  }

  protected getNetwork(): SocialNetwork {
    return SocialNetwork.LINKEDIN;
  }
}
