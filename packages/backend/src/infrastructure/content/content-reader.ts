import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile, readdir, access, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  BriefSchema,
  ArticleFrontmatterSchema,
  TopicQueueSchema,
  CreateRunReportSchema,
  type ContentTopic,
} from '@spa/shared';

// Re-export for backward compatibility (other modules may import from here)
export { BriefSchema, ArticleFrontmatterSchema, TopicQueueSchema, CreateRunReportSchema, type ContentTopic };

// ============================================================
// Content Reader — reads content-agent-platform runs + blog
// ============================================================

@Injectable()
export class ContentReader {
  private readonly logger = new Logger(ContentReader.name);
  private readonly capPath: string;
  private readonly blogPath: string;

  // Sprint J: LRU-style cache for getTopics — avoids re-reading disk on every call
  private topicsCache: { limit: number; topics: ContentTopic[]; expiresAt: number } | null = null;
  private readonly cacheTtlMs: number;

  constructor(private readonly configService: ConfigService) {
    this.capPath = this.configService.get<string>(
      'CONTENT_AGENT_PLATFORM_PATH',
      '../content-agent-platform',
    );
    this.blogPath = this.configService.get<string>('SITE_BLOG_PATH', '../content/blog/en');
    this.cacheTtlMs = this.configService.get<number>('CONTENT_CACHE_TTL_MS', 120_000); // 2 min
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
        // Use file modification time for freshness prioritization (B5)
        const fileStat = await fsStat(briefPath);
        topics.push({
          sourceType: 'brief',
          path: briefPath,
          topic: parsed.topic,
          keywords: parsed.target_queries.slice(0, 5),
          facts: parsed.outline.flatMap((o) => o.entities.slice(0, 3)),
          outline: parsed.outline.map((o) => ({ heading: o.heading, entities: o.entities })),
          // B5: category + freshness for topic prioritization
          category: parsed.outline[0]?.heading ?? 'general',
          publishedAt: fileStat.mtime,
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
        const { data: frontmatter } = matter(raw);
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
   * Read topic queues from content-agent-platform/runs/topics-{star}/topic-queue.json
   * Source 2 (§10.1): ranked topic clusters for topic diversity.
   */
  async readTopicQueues(limit = 10): Promise<ContentTopic[]> {
    const runsDir = join(this.capPath, 'runs');
    try {
      await access(runsDir);
    } catch {
      this.logger.debug(`CAP runs dir not found: ${runsDir}`);
      return [];
    }

    const entries = await readdir(runsDir, { withFileTypes: true });
    const topicDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('topics-'))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, limit * 2);

    const topics: ContentTopic[] = [];
    for (const dir of topicDirs) {
      if (topics.length >= limit) break;
      try {
        const queuePath = join(runsDir, dir, 'topic-queue.json');
        const raw = await readFile(queuePath, 'utf-8');
        const parsed = TopicQueueSchema.parse(JSON.parse(raw));
        const fileStat = await fsStat(queuePath);

        // Each cluster representative becomes a topic candidate
        for (const cluster of parsed.clusters) {
          if (topics.length >= limit) break;
          topics.push({
            sourceType: 'topic',
            path: queuePath,
            topic: cluster.representative,
            keywords: parsed.seeds.slice(0, 5),
            facts: [],
            category: cluster.status === 'new' ? 'trending' : 'general',
            publishedAt: fileStat.mtime,
          });
        }
      } catch (err) {
        this.logger.debug(`Skipping ${dir}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Read ${topics.length} topics from CAP topic-queues`);
    return topics;
  }

  /**
   * Read create-run reports from content-agent-platform/runs/create-{star}/report.json
   * Source 3 (§10.1): freshly created articles — best for freshness priority.
   * Extracts topic from file path (slug → human-readable topic).
   */
  async readCreateRuns(limit = 10): Promise<ContentTopic[]> {
    const runsDir = join(this.capPath, 'runs');
    try {
      await access(runsDir);
    } catch {
      this.logger.debug(`CAP runs dir not found: ${runsDir}`);
      return [];
    }

    const entries = await readdir(runsDir, { withFileTypes: true });
    const createDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('create-'))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, limit * 2);

    const topics: ContentTopic[] = [];
    for (const dir of createDirs) {
      if (topics.length >= limit) break;
      try {
        const reportPath = join(runsDir, dir, 'report.json');
        const raw = await readFile(reportPath, 'utf-8');
        const parsed = CreateRunReportSchema.parse(JSON.parse(raw));
        const fileStat = await fsStat(reportPath);

        // Use the first created file as the topic source
        // File paths look like: content/blog/en/slug-with-dashes.md
        const firstFile = parsed.files[0];
        if (!firstFile) continue;

        const slug = firstFile.split('/').pop()?.replace(/\.md$/, '') ?? '';
        const topic = slug
          .replace(/-\d{4}$/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        topics.push({
          sourceType: 'create_run',
          path: reportPath,
          topic,
          keywords: [],
          facts: [],
          category: 'fresh',
          publishedAt: fileStat.mtime,
        });
      } catch (err) {
        this.logger.debug(`Skipping ${dir}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Read ${topics.length} topics from CAP create-runs`);
    return topics;
  }

  /**
   * Get topics from all sources, prioritized per §10.1:
   *   1. briefs (SERP-grounded, best quality)
   *   2. create-runs (freshly created articles)
   *   3. topic-queues (ranked clusters for diversity)
   *   4. articles (blog fallback)
   *
   * Sprint J: Results cached for CONTENT_CACHE_TTL_MS (default 2 min).
   */
  async getTopics(limit = 5): Promise<ContentTopic[]> {
    // Sprint J: Check cache — return cached if fresh and covers the requested limit
    if (this.topicsCache && Date.now() < this.topicsCache.expiresAt && this.topicsCache.limit >= limit) {
      this.logger.debug(`Content cache hit (limit: ${limit})`);
      return this.topicsCache.topics.slice(0, limit);
    }

    const briefs = await this.readBriefs(limit);
    if (briefs.length >= limit) {
      const result = briefs.slice(0, limit);
      this.topicsCache = { limit, topics: result, expiresAt: Date.now() + this.cacheTtlMs };
      return result;
    }

    const remaining = limit - briefs.length;
    const createRuns = await this.readCreateRuns(remaining);
    if (briefs.length + createRuns.length >= limit) {
      const result = [...briefs, ...createRuns].slice(0, limit);
      this.topicsCache = { limit, topics: result, expiresAt: Date.now() + this.cacheTtlMs };
      return result;
    }

    const remaining2 = limit - briefs.length - createRuns.length;
    const topicQueues = await this.readTopicQueues(remaining2);
    if (briefs.length + createRuns.length + topicQueues.length >= limit) {
      const result = [...briefs, ...createRuns, ...topicQueues].slice(0, limit);
      this.topicsCache = { limit, topics: result, expiresAt: Date.now() + this.cacheTtlMs };
      return result;
    }

    const remaining3 = limit - briefs.length - createRuns.length - topicQueues.length;
    const articles = await this.readArticles(remaining3);
    const result = [...briefs, ...createRuns, ...topicQueues, ...articles].slice(0, limit);
    this.topicsCache = { limit, topics: result, expiresAt: Date.now() + this.cacheTtlMs };
    return result;
  }

  /** Sprint J: Invalidate cache (for testing or manual refresh). */
  invalidateCache(): void {
    this.topicsCache = null;
  }
}
