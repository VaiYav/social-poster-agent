import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { ABVariantService } from "../../../src/modules/content-enhancements/ab-variant.service";
import { createMockPrismaService } from "../../mocks/index.js";
import { SocialNetwork } from "../../../src/generated/prisma/client";

describe("ABVariantService", () => {
  let prisma: ReturnType<typeof createMockPrismaService>;
  let service: ABVariantService;

  beforeEach(() => {
    prisma = createMockPrismaService();
    const config = new ConfigService({ AB_VARIANTS_ENABLED: "false" });
    service = new ABVariantService(config, prisma as never);
  });

  it("creates a default variant when A/B is disabled", async () => {
    (prisma.postVariant.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await service.createVariants("post-1", SocialNetwork.X, "base content", null);

    expect(prisma.postVariant.createMany).toHaveBeenCalledWith({
      data: [
        {
          postId: "post-1",
          network: SocialNetwork.X,
          label: "default",
          content: "base content",
          judgeScores: undefined,
          selected: false,
        },
      ],
    });
  });

  it("creates a/b/base variants when A/B is enabled", async () => {
    const config = new ConfigService({ AB_VARIANTS_ENABLED: "true" });
    service = new ABVariantService(config, prisma as never);

    (prisma.postVariant.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });

    await service.createVariants("post-1", SocialNetwork.X, "base content", {
      a: { label: "a", content: "A variant", emojiCount: 0, hashtagCount: 0 },
      b: { label: "b", content: "B variant", emojiCount: 2, hashtagCount: 0 },
      winner: null,
    });

    const data = (prisma.postVariant.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toHaveLength(3);
    expect(data.map((v: { label: string }) => v.label).sort()).toEqual(["a", "b", "base"]);
  });

  it("selects the default variant when no variants exist", async () => {
    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.postVariant.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "pv-1" });

    const result = await service.selectAndApplyVariant("post-1", SocialNetwork.X, "content");

    expect(result.label).toBe("default");
    expect(prisma.postVariant.create).toHaveBeenCalledWith({
      data: {
        postId: "post-1",
        network: SocialNetwork.X,
        label: "default",
        content: "content",
        selected: true,
      },
    });
  });

  it("updates default variant content to match approved edits", async () => {
    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "pv-1", label: "default", content: "old content", selected: false },
    ]);

    const result = await service.selectAndApplyVariant("post-1", SocialNetwork.X, "new content");

    expect(result.label).toBe("default");
    expect(result.content).toBe("new content");
    expect(prisma.postVariant.update).toHaveBeenCalledWith({
      where: { id: "pv-1" },
      data: { content: "new content", selected: true },
    });
  });

  it("updates metrics for the selected variant", async () => {
    (prisma.postVariant.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await service.updateMetrics("post-1", { likes: 10, comments: 2, shares: 1, impressions: 100 });

    expect(prisma.postVariant.updateMany).toHaveBeenCalledWith({
      where: { postId: "post-1", selected: true },
      data: { likes: 10, comments: 2, shares: 1, impressions: 100, metricsAt: expect.any(Date) },
    });
  });

  it("getWinnerForTopic returns the historical winner with enough samples", async () => {
    const config = new ConfigService({
      AB_VARIANTS_ENABLED: "true",
      AB_TEST_MIN_SAMPLE_SIZE: "3",
      AB_TEST_LOOKBACK_DAYS: "30",
    });
    service = new ABVariantService(config, prisma as never);

    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `a-${i}`,
        postId: `p-${i}`,
        network: SocialNetwork.X,
        label: "a",
        content: "A variant",
        selected: true,
        likes: 10,
        comments: 2,
        shares: 1,
        impressions: 100,
        postedAt: new Date(),
        metricsAt: new Date(),
        post: {
          id: `p-${i}`,
          network: SocialNetwork.X,
          postedAt: new Date(),
          postUrl: "https://x.com/status/1",
          sourceRef: { topic: "Workflow Trends" },
        },
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `b-${i}`,
        postId: `p-${i + 3}`,
        network: SocialNetwork.X,
        label: "b",
        content: "B variant",
        selected: true,
        likes: 1,
        comments: 0,
        shares: 0,
        impressions: 20,
        postedAt: new Date(),
        metricsAt: new Date(),
        post: {
          id: `p-${i + 3}`,
          network: SocialNetwork.X,
          postedAt: new Date(),
          postUrl: "https://x.com/status/2",
          sourceRef: { topic: "Workflow Trends" },
        },
      })),
    ]);

    const winner = await service.getWinnerForTopic("Workflow Trends", SocialNetwork.X);

    expect(winner).toBe("a");
  });

  it("getWinnerForTopic returns null when sample size is below threshold", async () => {
    const config = new ConfigService({
      AB_VARIANTS_ENABLED: "true",
      AB_TEST_MIN_SAMPLE_SIZE: "10",
      AB_TEST_LOOKBACK_DAYS: "30",
    });
    service = new ABVariantService(config, prisma as never);

    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "a-1",
        postId: "p-1",
        network: SocialNetwork.X,
        label: "a",
        content: "A variant",
        selected: true,
        likes: 100,
        comments: 0,
        shares: 0,
        impressions: 100,
        postedAt: new Date(),
        metricsAt: new Date(),
        post: {
          id: "p-1",
          network: SocialNetwork.X,
          postedAt: new Date(),
          postUrl: "https://x.com/status/1",
          sourceRef: { topic: "Workflow Trends" },
        },
      },
    ]);

    const winner = await service.getWinnerForTopic("Workflow Trends", SocialNetwork.X);

    expect(winner).toBeNull();
  });

  it("selectAndApplyVariant uses the historical winner for weighted selection", async () => {
    const config = new ConfigService({
      AB_VARIANTS_ENABLED: "true",
      AB_TEST_MIN_SAMPLE_SIZE: "3",
      AB_TEST_LOOKBACK_DAYS: "30",
      AB_TEST_EXPLOITATION_WEIGHT: "1",
    });
    service = new ABVariantService(config, prisma as never);

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      sourceRef: { topic: "Workflow Trends" },
    });

    (prisma.postVariant.findMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { where?: { selected?: boolean; postId?: string } }) => {
        if (args.where?.selected) {
          return [
            ...Array.from({ length: 3 }, (_, i) => ({
              id: `a-${i}`,
              postId: `p-${i}`,
              network: SocialNetwork.X,
              label: "a",
              content: "A variant",
              selected: true,
              likes: 10,
              comments: 2,
              shares: 1,
              impressions: 100,
              postedAt: new Date(),
              metricsAt: new Date(),
              post: {
                id: `p-${i}`,
                network: SocialNetwork.X,
                postedAt: new Date(),
                postUrl: "https://x.com/status/1",
                sourceRef: { topic: "Workflow Trends" },
              },
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
              id: `b-${i}`,
              postId: `p-${i + 3}`,
              network: SocialNetwork.X,
              label: "b",
              content: "B variant",
              selected: true,
              likes: 1,
              comments: 0,
              shares: 0,
              impressions: 20,
              postedAt: new Date(),
              metricsAt: new Date(),
              post: {
                id: `p-${i + 3}`,
                network: SocialNetwork.X,
                postedAt: new Date(),
                postUrl: "https://x.com/status/2",
                sourceRef: { topic: "Workflow Trends" },
              },
            })),
          ];
        }
        return [
          { id: "pv-a", label: "a", content: "A variant", selected: false },
          { id: "pv-b", label: "b", content: "B variant", selected: false },
          { id: "pv-base", label: "base", content: "base content", selected: false },
        ];
      },
    );

    (prisma.postVariant.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.postVariant.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "pv-a" });

    const result = await service.selectAndApplyVariant("post-1", SocialNetwork.X, "base content");

    expect(result.label).toBe("a");
    expect(prisma.postVariant.update).toHaveBeenCalledWith({
      where: { id: "pv-a" },
      data: { selected: true },
    });
  });
});
