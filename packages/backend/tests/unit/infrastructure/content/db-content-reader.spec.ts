import { afterEach, describe, expect, it, vi } from "vitest";
import { DbContentReader } from "../../../../src/infrastructure/content/db-content-reader.js";

function buildReader() {
  const prisma = {
    topic: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { reader: new DbContentReader(prisma as never), prisma };
}

describe("DbContentReader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps active DB topics into ContentTopic records and preserves the requested limit", async () => {
    const { reader, prisma } = buildReader();
    const createdAt = new Date("2026-08-23T10:00:00.000Z");
    prisma.topic.findMany.mockResolvedValue([
      {
        id: "topic-1",
        topic: "A useful topic",
        keywords: ["useful"],
        facts: ["fact"],
        category: "education",
        createdAt,
      },
    ]);

    await expect(reader.getTopics(7)).resolves.toEqual([
      {
        sourceType: "brief",
        path: "db:topic-1",
        topic: "A useful topic",
        keywords: ["useful"],
        facts: ["fact"],
        category: "education",
        publishedAt: createdAt,
        language: "en",
      },
    ]);
    expect(prisma.topic.findMany).toHaveBeenCalledWith({
      where: { status: "active" },
      orderBy: [{ createdAt: "desc" }],
      take: 7,
    });
  });

  it("uses safe defaults and fails closed when the DB read fails", async () => {
    const { reader, prisma } = buildReader();
    prisma.topic.findMany.mockResolvedValue([
      {
        id: "topic-2",
        topic: "Defaults",
        keywords: null,
        facts: null,
        category: null,
        createdAt: new Date("2026-08-23T10:00:00.000Z"),
      },
    ]);
    await expect(reader.getTopics(0)).resolves.toMatchObject({
      0: expect.objectContaining({ keywords: [], facts: [], category: "general" }),
    });

    prisma.topic.findMany.mockRejectedValue(new Error("database unavailable"));
    await expect(reader.getTopics()).resolves.toEqual([]);
  });

  it("routes briefs through DB and exposes no DB-backed articles", async () => {
    const { reader } = buildReader();
    const getTopics = vi.spyOn(reader, "getTopics").mockResolvedValue([]);

    await expect(reader.readBriefs(9)).resolves.toEqual([]);
    await expect(reader.readArticles(9)).resolves.toEqual([]);
    expect(getTopics).toHaveBeenCalledWith(9);
  });

  it("marks only DB topics as used and swallows update failures", async () => {
    const { reader, prisma } = buildReader();
    const dbTopic = {
      path: "db:topic-3",
      topic: "Topic",
      sourceType: "brief",
    } as never;
    await reader.markUsed(dbTopic);
    expect(prisma.topic.update).toHaveBeenCalledWith({
      where: { id: "topic-3" },
      data: { status: "used", usedAt: expect.any(Date) },
    });

    prisma.topic.update.mockRejectedValue(new Error("write unavailable"));
    await expect(reader.markUsed(dbTopic)).resolves.toBeUndefined();
    await reader.markUsed({ path: "filesystem:topic" } as never);
    expect(prisma.topic.update).toHaveBeenCalledTimes(2);
  });

  it("supports adapter selection, active count, since filtering, and health state", async () => {
    const { reader, prisma } = buildReader();
    const oldDate = new Date("2026-08-22T10:00:00.000Z");
    const newDate = new Date("2026-08-23T10:00:00.000Z");
    prisma.topic.findMany.mockResolvedValue([
      { id: "old", topic: "Old", keywords: [], facts: [], createdAt: oldDate },
      { id: "new", topic: "New", keywords: [], facts: [], createdAt: newDate },
    ]);
    prisma.topic.count.mockResolvedValue(4);

    expect(reader.sourceType).toBe("db");
    expect(reader.canHandle("brief")).toBe(true);
    expect(reader.canHandle("article")).toBe(false);
    await expect(reader.fetchTopics(5, new Date("2026-08-23T00:00:00.000Z"))).resolves.toHaveLength(
      1,
    );
    await expect(reader.fetchTopics(5)).resolves.toHaveLength(2);
    await expect(reader.activeCount()).resolves.toBe(4);
    await expect(reader.healthCheck()).resolves.toEqual({ ok: true });

    prisma.topic.count.mockRejectedValue(new Error("health unavailable"));
    await expect(reader.healthCheck()).resolves.toEqual({
      ok: false,
      error: "health unavailable",
    });
    expect(reader.lastError).toBe("health unavailable");
  });
});
