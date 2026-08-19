/**
 * ContentReader unit tests.
 *
 * Tests reading briefs, articles, topic-queues, create-runs from the
 * content-agent-platform (CAP) and blog, plus the getTopics priority
 * ordering and Sprint J cache behavior.
 *
 * Source: packages/backend/src/infrastructure/content/content-reader.ts
 * Covers UTC-480 through UTC-494 (15 test cases).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// ── Mock node:fs/promises ──
// We control readdir/access/readFile/stat to simulate the CAP directory layout.
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: fsMocks.readFile,
  readdir: fsMocks.readdir,
  access: fsMocks.access,
  stat: fsMocks.stat,
}));

// gray-matter is a real dependency — use the real implementation.
import { ConfigService } from '@nestjs/config';
import { ContentReader } from '../../../src/infrastructure/content/content-reader.js';

// ── Helpers ──

const CAP_PATH = '/tmp/cap';
const BLOG_PATH = '/tmp/blog';

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    CONTENT_AGENT_PLATFORM_PATH: CAP_PATH,
    SITE_BLOG_PATH: BLOG_PATH,
    CONTENT_CACHE_TTL_MS: 120_000,
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

/** A valid brief.json payload matching BriefSchema. */
const validBrief = {
  topic: 'Workflow Trends 2026',
  source_locale: 'en',
  target_queries: ['workflow trends 2026', 'workflow trends dates'],
  intent: 'informational',
  outline: [
    { heading: 'productivity', intent_note: 'overview', entities: ['Workflow', 'Q2'] },
    { heading: 'Dates', entities: ['July 14', 'August 7'] },
  ],
};

/** A valid topic-queue.json payload matching TopicQueueSchema. */
const validTopicQueue = {
  locale: 'en',
  seeds: ['productivity', 'workflow trends'],
  clusters: [
    { representative: 'Workflow trends effects', members: 3, status: 'new', score: 0.9 },
    { representative: 'Launch day rituals', members: 2, status: 'reviewed', score: 0.7 },
  ],
};

/** A valid create-run report.json matching CreateRunReportSchema. */
const validCreateReport = {
  files: ['content/blog/en/workflow-trends-2026.md'],
  skipped: [],
  tokens_in: 100,
  tokens_out: 200,
  usd: 0.01,
  steps: 5,
  errors: [],
};

/** A valid markdown article with frontmatter matching ArticleFrontmatterSchema. */
const validArticleMd = `---
title: Product Launch in Q4
description: Discipline and ambition under the product launch.
date: "2026-07-21"
tags: [productivity, q4]
answerCapsule:
  question: What does the product launch in Q4 mean?
  answer: Focus on goals and structure.
  keyPoints: [Goal-setting, Discipline]
seo:
  keywords: [product launch q4, q4 product launch]
---

# Product Launch in Q4

The product launch in Q4 highlights Discipline, ambition and long-term goal setting.
`;

/** Simulate readdir returning Dirent-like objects. */
function dirents(names: { name: string; isDir: boolean }[]) {
  return names.map((n) => ({
    name: n.name,
    isDirectory: () => n.isDir,
    isFile: () => !n.isDir,
  }));
}

/** Configure fs mocks for a CAP runs dir with given subdirectories. */
function setupCapRuns(
  dirs: { name: string; file: string; content: string }[],
  opts: { accessFails?: boolean } = {},
) {
  if (opts.accessFails) {
    fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));
    return;
  }
  fsMocks.access.mockResolvedValueOnce(undefined);
  fsMocks.readdir.mockResolvedValueOnce(
    dirents(dirs.map((d) => ({ name: d.name, isDir: true }))),
  );
  for (const d of dirs) {
    fsMocks.readFile.mockResolvedValueOnce(d.content);
    fsMocks.stat.mockResolvedValueOnce({ mtime: new Date('2026-07-15T10:00:00Z') });
  }
}

// ── Tests ──

describe('ContentReader (UTC-480 — CAP content reading)', () => {
  let service: ContentReader;
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.readFile.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.access.mockReset();
    fsMocks.stat.mockReset();
    configService = createMockConfigService();
    service = new ContentReader(configService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── readBriefs ──

  it('UTC-480: readBriefs() parses brief.json via BriefSchema → ContentTopic[]', async () => {
    setupCapRuns([
      { name: 'brief-001', file: 'brief.json', content: JSON.stringify(validBrief) },
    ]);

    const topics = await service.readBriefs(10);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('brief');
    expect(topics[0]!.topic).toBe('Workflow Trends 2026');
    expect(topics[0]!.keywords).toEqual(['workflow trends 2026', 'workflow trends dates']);
    // outline mapped with heading + entities
    expect(topics[0]!.outline).toEqual([
      { heading: 'productivity', entities: ['Workflow', 'Q2'] },
      { heading: 'Dates', entities: ['July 14', 'August 7'] },
    ]);
    // category from first outline heading
    expect(topics[0]!.category).toBe('productivity');
    // publishedAt from file mtime
    expect(topics[0]!.publishedAt).toEqual(new Date('2026-07-15T10:00:00Z'));
    // path points to brief.json
    expect(topics[0]!.path).toBe(join(CAP_PATH, 'runs', 'brief-001', 'brief.json'));
  });

  it('UTC-481: readBriefs() skips invalid JSON (logs warn, does not throw)', async () => {
    setupCapRuns([{ name: 'brief-001', file: 'brief.json', content: '{not valid json' }]);

    const topics = await service.readBriefs(10);

    expect(topics).toHaveLength(0);
    // readFile was called (attempted to parse)
    expect(fsMocks.readFile).toHaveBeenCalled();
  });

  it('UTC-482: readBriefs() skips when brief.json missing (readFile rejects)', async () => {
    fsMocks.access.mockResolvedValueOnce(undefined);
    fsMocks.readdir.mockResolvedValueOnce(dirents([{ name: 'brief-001', isDir: true }]));
    fsMocks.readFile.mockRejectedValueOnce(new Error('ENOENT'));

    const topics = await service.readBriefs(10);

    expect(topics).toHaveLength(0);
  });

  it('UTC-483: readBriefs() returns [] when CAP runs dir does not exist', async () => {
    fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

    const topics = await service.readBriefs(10);

    expect(topics).toEqual([]);
    expect(fsMocks.readdir).not.toHaveBeenCalled();
  });

  // ── readArticles ──

  it('UTC-484: readArticles() parses .md frontmatter via ArticleFrontmatterSchema', async () => {
    fsMocks.access.mockResolvedValueOnce(undefined);
    fsMocks.readdir.mockResolvedValueOnce(
      dirents([{ name: 'product-launch-q4.md', isDir: false }]),
    );
    fsMocks.readFile.mockResolvedValueOnce(validArticleMd);

    const topics = await service.readArticles(10);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('article');
    expect(topics[0]!.topic).toBe('Product Launch in Q4');
    // keywords from seo.keywords
    expect(topics[0]!.keywords).toEqual(['product launch q4', 'q4 product launch']);
    // F10: facts include answerCapsule.keyPoints + answer; body adds more when present.
    expect(topics[0]!.facts).toEqual([
      'Goal-setting',
      'Discipline',
      'Focus on goals and structure.',
      'The product launch in Q4 highlights Discipline, ambition and long-term goal setting.',
    ]);
    // category from first tag
    expect(topics[0]!.category).toBe('productivity');
    // publishedAt from date
    expect(topics[0]!.publishedAt).toEqual(new Date('2026-07-21'));
  });

  it('UTC-485: readArticles() skips files with missing/invalid frontmatter', async () => {
    fsMocks.access.mockResolvedValueOnce(undefined);
    fsMocks.readdir.mockResolvedValueOnce(
      dirents([{ name: 'bad.md', isDir: false }, { name: 'good.md', isDir: false }]),
    );
    // bad.md: frontmatter missing required `title`
    fsMocks.readFile.mockResolvedValueOnce('---\ndescription: no title\n---\nbody');
    fsMocks.readFile.mockResolvedValueOnce(validArticleMd);

    const topics = await service.readArticles(10);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.topic).toBe('Product Launch in Q4');
  });

  it('UTC-486: readArticles() skips .md file with no content / empty frontmatter', async () => {
    fsMocks.access.mockResolvedValueOnce(undefined);
    fsMocks.readdir.mockResolvedValueOnce(
      dirents([{ name: 'empty.md', isDir: false }]),
    );
    // empty file → gray-matter returns empty data → ArticleFrontmatterSchema fails (no title)
    fsMocks.readFile.mockResolvedValueOnce('');

    const topics = await service.readArticles(10);

    expect(topics).toHaveLength(0);
  });

  it('UTC-487: readArticles() returns [] when blog dir does not exist', async () => {
    fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

    const topics = await service.readArticles(10);

    expect(topics).toEqual([]);
  });

  // ── readTopicQueues ──

  it('UTC-488: readTopicQueues() parses topic-queue.json clusters → ContentTopic[]', async () => {
    setupCapRuns([
      { name: 'topics-001', file: 'topic-queue.json', content: JSON.stringify(validTopicQueue) },
    ]);

    const topics = await service.readTopicQueues(10);

    expect(topics).toHaveLength(2);
    expect(topics[0]!.sourceType).toBe('topic');
    expect(topics[0]!.topic).toBe('Workflow trends effects');
    // keywords from seeds
    expect(topics[0]!.keywords).toEqual(['productivity', 'workflow trends']);
    // category: 'trending' when status === 'new'
    expect(topics[0]!.category).toBe('trending');
    // second cluster: status 'reviewed' → 'general'
    expect(topics[1]!.category).toBe('general');
    expect(topics[1]!.topic).toBe('Launch day rituals');
  });

  // ── readCreateRuns ──

  it('UTC-489: readCreateRuns() parses report.json → ContentTopic[] (slug → topic)', async () => {
    setupCapRuns([
      { name: 'create-001', file: 'report.json', content: JSON.stringify(validCreateReport) },
    ]);

    const topics = await service.readCreateRuns(10);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('create_run');
    // slug "workflow-trends-2026" → "Workflow Trends 2026" (trailing -2026 stripped)
    expect(topics[0]!.topic).toBe('Workflow Trends');
    expect(topics[0]!.category).toBe('fresh');
  });

  it('UTC-490: readCreateRuns() skips report with no files', async () => {
    setupCapRuns([
      { name: 'create-001', file: 'report.json', content: JSON.stringify({ files: [] }) },
    ]);

    const topics = await service.readCreateRuns(10);

    expect(topics).toHaveLength(0);
  });

  // ── getTopics priority ordering ──
  // getTopics calls readBriefs → readCreateRuns → readTopicQueues → readArticles,
  // each invoking access(runsDir) + readdir(runsDir). We use mockImplementation
  // to route readFile/stat by path so all read methods share the same mock state.

  /** Configure fs mocks for a full getTopics call with given CAP dirs + blog files. */
  function setupGetTopics(opts: {
    capDirs?: { name: string; content: string }[];
    blogFiles?: { name: string; content: string }[];
    capAccessFails?: boolean;
    blogAccessFails?: boolean;
  }) {
    const capDirs = opts.capDirs ?? [];
    const blogFiles = opts.blogFiles ?? [];

    // access: resolve for runsDir and blogPath (unless explicitly failing)
    fsMocks.access.mockImplementation(async (p: string) => {
      if (p === join(CAP_PATH, 'runs') && opts.capAccessFails) throw new Error('ENOENT');
      if (p === BLOG_PATH && opts.blogAccessFails) throw new Error('ENOENT');
      return undefined;
    });

    // readdir: return CAP dirs or blog files depending on path
    fsMocks.readdir.mockImplementation(async (p: string) => {
      if (p === join(CAP_PATH, 'runs')) {
        return dirents(capDirs.map((d) => ({ name: d.name, isDir: true })));
      }
      if (p === BLOG_PATH) {
        return dirents(blogFiles.map((f) => ({ name: f.name, isDir: false })));
      }
      return [];
    });

    // readFile: return content by path
    fsMocks.readFile.mockImplementation(async (p: string) => {
      const capDir = capDirs.find((d) => p === join(CAP_PATH, 'runs', d.name, 'brief.json') ||
        p === join(CAP_PATH, 'runs', d.name, 'topic-queue.json') ||
        p === join(CAP_PATH, 'runs', d.name, 'report.json'));
      if (capDir) return capDir.content;
      const blogFile = blogFiles.find((f) => p === join(BLOG_PATH, f.name));
      if (blogFile) return blogFile.content;
      throw new Error('ENOENT');
    });

    // stat: return a fixed mtime
    fsMocks.stat.mockResolvedValue({ mtime: new Date('2026-07-15T10:00:00Z') });
  }

  it('UTC-491: getTopics() returns briefs first when enough are available', async () => {
    setupGetTopics({
      capDirs: [{ name: 'brief-001', content: JSON.stringify(validBrief) }],
    });

    const topics = await service.getTopics(5);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('brief');
  });

  it('UTC-492: getTopics() falls through to articles when no briefs/create-runs/queues', async () => {
    setupGetTopics({
      capDirs: [],
      blogFiles: [{ name: 'product-launch-q4.md', content: validArticleMd }],
    });

    const topics = await service.getTopics(5);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.sourceType).toBe('article');
  });

  it('UTC-493: getTopics() returns [] when all sources empty', async () => {
    setupGetTopics({ capAccessFails: true, blogAccessFails: true });

    const topics = await service.getTopics(5);

    expect(topics).toEqual([]);
  });

  // ── Cache behavior ──

  it('UTC-494: getTopics() cache hit within TTL → no fs.readFile on second call', async () => {
    setupGetTopics({
      capDirs: [{ name: 'brief-001', content: JSON.stringify(validBrief) }],
    });

    const first = await service.getTopics(5);
    const readFileCallsAfterFirst = fsMocks.readFile.mock.calls.length;

    const second = await service.getTopics(5);

    expect(second).toEqual(first);
    // No additional readFile calls (cache hit)
    expect(fsMocks.readFile.mock.calls.length).toBe(readFileCallsAfterFirst);
  });

  it('UTC-495: getTopics() cache miss after TTL expiry → re-reads fs', async () => {
    vi.useFakeTimers();
    setupGetTopics({
      capDirs: [{ name: 'brief-001', content: JSON.stringify(validBrief) }],
    });

    const first = await service.getTopics(5);
    expect(first).toHaveLength(1);

    // Advance past TTL (120s)
    vi.advanceTimersByTime(130_000);

    const second = await service.getTopics(5);
    expect(second).toHaveLength(1);
    // readFile called again (cache invalidated by TTL)
    expect(fsMocks.readFile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('UTC-496: invalidateCache() clears cache → next getTopics re-reads fs', async () => {
    setupGetTopics({
      capDirs: [{ name: 'brief-001', content: JSON.stringify(validBrief) }],
    });

    await service.getTopics(5);
    const callsAfterFirst = fsMocks.readFile.mock.calls.length;

    service.invalidateCache();

    await service.getTopics(5);

    // readFile called again after invalidateCache
    expect(fsMocks.readFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
