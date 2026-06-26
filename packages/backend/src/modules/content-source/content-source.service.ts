import { Injectable } from '@nestjs/common';
import { ContentReader, type ContentTopic } from '../../infrastructure/content/content-reader';

/**
 * Content source service — facade over ContentReader.
 * Used by GenerationService to get topics for post generation.
 */
@Injectable()
export class ContentSourceService {
  constructor(private readonly contentReader: ContentReader) {}

  async getTopics(limit = 5): Promise<ContentTopic[]> {
    return this.contentReader.getTopics(limit);
  }

  async getBriefs(limit = 10): Promise<ContentTopic[]> {
    return this.contentReader.readBriefs(limit);
  }

  async getArticles(limit = 10): Promise<ContentTopic[]> {
    return this.contentReader.readArticles(limit);
  }
}
