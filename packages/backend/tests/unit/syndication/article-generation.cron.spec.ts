import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { SchedulerRegistry } from "@nestjs/schedule";
import { ContentType, PostStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";
import type { IContentPort } from "../../../src/domain/ports/content.port.js";
import type { ArticleGraphState, ArticleContent, ContentTopic } from "@spa/shared";
import { AccountsService } from "../../../src/modules/accounts/accounts.service.js";
import { GenerationService } from "../../../src/modules/generation/generation.service.js";
import { PostsService } from "../../../src/modules/posts/posts.service.js";
import { ArticleGenerationCron } from "../../../src/modules/syndication/article-generation.cron.js";

const article: ArticleContent = {
  title: "A useful article",
  slug: "a-useful-article",
  bodyMarkdown: "# A useful article\n\nBody.",
  excerpt: "Body.",
  tags: ["testing"],
};

const topic: ContentTopic = {
  sourceType: "article",
  path: "content/en/a-useful-article.md",
  topic: "A useful article",
  keywords: ["testing"],
  canonicalUrl: "https://blog.example.test/blog/a-useful-article",
};

const generatedState: ArticleGraphState = {
  runId: "article-run-1",
  topic: topic.topic,
  keywords: topic.keywords,
  facts: ["A fact"],
  outline: [],
  draft: article,
  judgeScores: null,
  judgeFeedback: null,
  refineCount: 0,
  judgeRetried: false,
  canonicalUrl: topic.canonicalUrl ?? null,
  finalArticle: article,
  error: null,
  language: "en",
  targetNetworks: [SocialNetwork.DEVTO, SocialNetwork.HASHNODE],
};

function createCron() {
  const contentPort = {
    getTopics: vi.fn().mockResolvedValue([topic]),
    markUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as IContentPort;
  const generationService = {
    generateArticle: vi.fn().mockResolvedValue(generatedState),
  } as unknown as GenerationService;
  const accountsService = {
    getNextAccountForNetwork: vi.fn((network: SocialNetwork) =>
      Promise.resolve({ id: `account-${network}`, network }),
    ),
  } as unknown as AccountsService;
  const postsService = {
    create: vi.fn().mockResolvedValue({ id: "post-1" }),
  } as unknown as PostsService;
  const configService = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "SYNDICATION_NETWORKS" ? "DEVTO,HASHNODE" : fallback,
    ),
  } as unknown as ConfigService;
  const schedulerRegistry = { addCronJob: vi.fn() } as unknown as SchedulerRegistry;

  return {
    cron: new ArticleGenerationCron(
      generationService,
      contentPort,
      accountsService,
      postsService,
      configService,
      schedulerRegistry,
    ),
    contentPort,
    generationService,
    accountsService,
    postsService,
  };
}

describe("ArticleGenerationCron", () => {
  it("persists one reviewable article draft per configured network and marks the topic used", async () => {
    const { cron, postsService, contentPort, generationService } = createCron();

    await cron.handleArticleGeneration();

    expect(generationService.generateArticle).toHaveBeenCalledWith({
      topic: topic.topic,
      keywords: topic.keywords,
      language: "en",
      targetNetworks: [SocialNetwork.DEVTO, SocialNetwork.HASHNODE],
    });
    expect(postsService.create).toHaveBeenCalledTimes(2);
    const drafts = postsService.create.mock.calls as unknown as Array<[Record<string, unknown>]>;
    for (const [draft] of drafts) {
      expect(draft.contentType).toBe(ContentType.ARTICLE);
      expect(JSON.parse(String(draft.content))).toEqual(article);
      expect(draft.canonicalUrl).toBe(topic.canonicalUrl);
      expect(draft.sourceRef).toMatchObject({
        type: topic.sourceType,
        path: topic.path,
        topic: topic.topic,
      });
      expect(draft.status).toBe(PostStatus.DRAFT);
    }
    expect(contentPort.markUsed).toHaveBeenCalledWith(topic);
  });

  it("does nothing when no source topics are available", async () => {
    const { cron, postsService, contentPort, generationService } = createCron();
    vi.mocked(contentPort.getTopics).mockResolvedValue([]);

    await cron.handleArticleGeneration();

    expect(generationService.generateArticle).not.toHaveBeenCalled();
    expect(postsService.create).not.toHaveBeenCalled();
    expect(contentPort.markUsed).not.toHaveBeenCalled();
  });

  it("does not persist or consume a topic when generation returns an error", async () => {
    const { cron, postsService, contentPort, generationService } = createCron();
    vi.mocked(generationService.generateArticle).mockResolvedValue({
      ...generatedState,
      draft: null,
      finalArticle: null,
      error: "generation failed",
    });

    await cron.handleArticleGeneration();

    expect(postsService.create).not.toHaveBeenCalled();
    expect(contentPort.markUsed).not.toHaveBeenCalled();
  });
});
