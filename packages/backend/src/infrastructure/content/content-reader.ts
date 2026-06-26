import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BriefSchema,
  ArticleFrontmatterSchema,
  type ContentTopic,
} from '@spa/shared';

// Re-export for backward compatibility (other modules may import from here)
export { BriefSchema, ArticleFrontmatterSchema, type ContentTopic };

// ============================================================
// Content Reader — reads content-agent-platform runs + blog
// ============================================================

@Injectable()
export class ContentReader {
  private readonly logger = new Logger(ContentReader.name);
  private readonly capPath: string;
  private readonly blogPath: string;

  constructor(private readonly configService: ConfigService) {
    this.capPath = this.configService.get<string>(
      'CONTENT_AGENT_PLATFORM_PATH',
      '../content-agent-platform',
    );
    this.blogPath = this.configService.get<string>('SITE_BLOG_PATH', '../content/blog/en');
  }

  // Read briefs from content-agent-platform/runs/brief-*/brief.json
  // Priority source — SERP-grounded, SEO-optimized.
  async readBriefs(limit = 10): Promise<ContentTopic[]> {
    const runsDir = join(this.capPath, 'runs');
    try {
      await access(runsDir);
    } catch {
      this.logger.warn(`CAP runs dir not found: ${runsDir}`);
      return [];
    }

    const entries = await readdir(runsDir, { withFileTypes: true });
    const briefDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('brief-'))
      .map((e) => e.name)
      .sort()
      .reverse() // newest first
      .slice(0, limit * 2); // read extra in case some fail parsing

    const topics: ContentTopic[] = [];
    for (const dir of briefDirs) {
      if (topics.length >= limit) break;
      try {
        const briefPath = join(runsDir, dir, 'brief.json');
        const raw = await readFile(briefPath, 'utf-8');
        const parsed = BriefSchema.parse(JSON.parse(raw));
        topics.push({
          sourceType: 'brief',
          path: briefPath,
          topic: parsed.topic,
          keywords: parsed.target_queries.slice(0, 5),
          facts: parsed.outline.flatMap((o) => o.entities.slice(0, 3)),
          outline: parsed.outline.map((o) => ({ heading: o.heading, entities: o.entities })),
          // B5: category + freshness for topic prioritization
          category: parsed.outline[0]?.heading ?? 'general',
          publishedAt: new Date(),
        });
      } catch (err) {
        this.logger.debug(`Skipping ${dir}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Read ${topics.length} briefs from CAP`);
    return topics;
  }

  /**
   * Read articles from content/blog/en/*.md (fallback source).
   * Parses frontmatter for title, description, answerCapsule, keywords.
   */
  async readArticles(limit = 10): Promise<ContentTopic[]> {
    try {
      await access(this.blogPath);
    } catch {
      this.logger.warn(`Blog dir not found: ${this.blogPath}`);
      return [];
    }

    const files = (await readdir(this.blogPath, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .slice(0, limit * 2);

    const topics: ContentTopic[] = [];
    for (const file of files) {
      if (topics.length >= limit) break;
      try {
        const filePath = join(this.blogPath, file);
        const raw = await readFile(filePath, 'utf-8');
        const frontmatter = this.parseFrontmatter(raw);
        const parsed = ArticleFrontmatterSchema.parse(frontmatter);
        topics.push({
          sourceType: 'article',
          path: filePath,
          topic: parsed.title,
          keywords: parsed.seo?.keywords ?? parsed.tags.slice(0, 5),
          facts: parsed.answerCapsule?.keyPoints ?? [],
          // B5: category + freshness for topic prioritization
          category: parsed.tags[0] ?? 'general',
          publishedAt: parsed.date ? new Date(parsed.date) : undefined,
        });
      } catch (err) {
        this.logger.debug(`Skipping ${file}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Read ${topics.length} articles from blog`);
    return topics;
  }

  /**
   * Get topics from all sources, prioritized: briefs > articles.
   */
  async getTopics(limit = 5): Promise<ContentTopic[]> {
    const briefs = await this.readBriefs(limit);
    if (briefs.length >= limit) return briefs.slice(0, limit);

    const articles = await this.readArticles(limit - briefs.length);
    return [...briefs, ...articles].slice(0, limit);
  }

  private parseFrontmatter(raw: string): Record<string, unknown> {
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match || !match[1]) return {};

    const yaml = match[1];
    const result: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: string[] | null = null;

    for (const line of yaml.split('\n')) {
      const arrayItemMatch = line.match(/^\s+-\s+(.*)$/);
      if (arrayItemMatch && currentArray && currentKey) {
        currentArray.push(arrayItemMatch[1]!.trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }

      const kvMatch = line.match(/^(\w[\w]*):\s*(.*)$/);
      if (kvMatch) {
        currentKey = kvMatch[1]!;
        const value = kvMatch[2]!.trim();
        if (value === '' || value === '[]') {
          currentArray = [];
          result[currentKey] = currentArray;
        } else {
          currentArray = null;
          result[currentKey] = value.replace(/^['"]|['"]$/g, '');
        }
      }
    }

    return result;
  }
}
