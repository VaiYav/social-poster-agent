import { Module, type DynamicModule } from "@nestjs/common";
import { CanonicalModule } from "../canonical/canonical.module.js";
import { GenerationModule } from "../generation/generation.module.js";
import { BrowserAgentModule } from "../browser-agent/browser-agent.module.js";
import { ArticleGenerationCron } from "./article-generation.cron.js";
import { DevtoPoster } from "../posting/posters/devto.poster.js";
import { HashnodePoster } from "../posting/posters/hashnode.poster.js";
import { LinkedinPoster } from "../posting/posters/linkedin.poster.js";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { ContentModule } from "../../infrastructure/content/content.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { PostsModule } from "../posts/posts.module.js";

/**
 * SyndicationModule — wrapper module for the cross-platform content syndication
 * feature. Feature-flagged by `SYNDICATION_ENABLED` (default: false).
 *
 * When enabled, registers:
 * - CanonicalModule (CanonicalUrlService for POSSE canonical URLs)
 * - ArticleGenerationCron (weekly article generation trigger)
 * - BrowserAgentModule (LLM-in-the-loop browser engine #47)
 * - Article posters (Dev.to, Hashnode, LinkedIn) — P1-01/02/03
 *
 * When disabled (default), none of these are registered — no services,
 * no routes, no cron timers. Same pattern as ENGAGEMENT_ENABLED,
 * ORCHESTRATOR_ENABLED, etc.
 *
 * Usage in AppModule:
 * ```typescript
 * const syndicationImports = parseBool(process.env.SYNDICATION_ENABLED)
 *   ? [SyndicationModule.forRoot()]
 *   : [];
 * ```
 */
@Module({})
export class SyndicationModule {
  /**
   * Create the SyndicationModule with all sub-modules wired.
   * Called only when SYNDICATION_ENABLED=true.
   */
  static forRoot(): DynamicModule {
    return {
      module: SyndicationModule,
      imports: [
        CanonicalModule,
        GenerationModule, // ArticleGenerationCron needs GenerationService
        ContentModule, // ArticleGenerationCron reads and consumes source topics
        AccountsModule, // ArticleGenerationCron selects the target account
        PostsModule, // ArticleGenerationCron persists reviewable article drafts
        BrowserAgentModule, // LLM-in-the-loop browser engine (#47)
        BrowserModule, // Posters need IBrowserPort
      ],
      providers: [
        ArticleGenerationCron,
        // P1-01/02/03: Article posters (Camoufox + LLM-in-the-loop)
        DevtoPoster,
        HashnodePoster,
        LinkedinPoster,
      ],
      exports: [CanonicalModule, DevtoPoster, HashnodePoster, LinkedinPoster],
    };
  }
}
