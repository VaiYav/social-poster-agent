import { Injectable, Inject } from "@nestjs/common";
import type { ContentTopic } from "@spa/shared";
import { IContentPort } from "../../domain/ports/content.port.js";

/**
 * Content source service — facade over IContentPort.
 * Used by GenerationService to get topics for post generation.
 *
 * The actual adapter (ContentReader for CAP filesystem, or DbContentReader
 * for DB-backed LLM topics) is wired in ContentModule based on whether
 * CONTENT_AGENT_PLATFORM_PATH is available.
 */
@Injectable()
export class ContentSourceService {
  constructor(@Inject(IContentPort) private readonly contentPort: IContentPort) {}

  async getTopics(limit = 5): Promise<ContentTopic[]> {
    return this.contentPort.getTopics(limit);
  }

  async getBriefs(limit = 10): Promise<ContentTopic[]> {
    return this.contentPort.readBriefs(limit);
  }

  async getArticles(limit = 10): Promise<ContentTopic[]> {
    return this.contentPort.readArticles(limit);
  }

  /**
   * 2.8.1: Mark a topic as used so it is not reused in the next generation cycle.
   */
  async markUsed(topic: ContentTopic): Promise<void> {
    return this.contentPort.markUsed(topic);
  }
}
