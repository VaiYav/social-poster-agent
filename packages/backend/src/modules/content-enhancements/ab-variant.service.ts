/**
 * A/B Variant Service — persistence and selection of post variants for A/B testing.
 *
 * At generation time, the service persists the variants produced by
 * `ABVariantGenerator` into the `PostVariant` table. When a post is later
 * published, the service selects the variant that should actually be posted,
 * updates `post.content`, and records the selection so outcomes can be joined
 * back to the variant.
 *
 * P7 feedback loop: `selectAndApplyVariant` looks up the historical winner for
 * the current topic + network and uses a weighted selection (e.g. 80% winner,
 * 20% challenger) while still preserving exploration for new topics.
 */
import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { PostStatus, SocialNetwork } from "../../generated/prisma/client";
import type { Prisma } from "../../generated/prisma/client";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import type { ABVariantPair } from "./ab-variant.generator.js";
import type { JudgeScores } from "@spa/shared";
import {
  type VariantStatsRow,
  computeVariantStats,
  extractTopic,
  pickWinner,
} from "./ab-test.utils.js";

function normalize(text: string): string {
  // Collapse whitespace and lower-case for case-insensitive, whitespace-tolerant comparison.
  // Hashtags are intentionally preserved: they are part of the variant content.
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function hashProbability(seed: string): number {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const n = parseInt(hex, 16);
  return Number.isNaN(n) ? 0 : n / 0xffffffff;
}

function pickVariantByWeight<T extends { id: string; label: string }>(
  postId: string,
  a: T,
  b: T,
  weightA: number,
): T {
  return hashProbability(postId) < weightA ? a : b;
}

@Injectable()
export class ABVariantService {
  private readonly logger = new Logger(ABVariantService.name);
  private readonly abEnabled: boolean;
  private readonly lookbackDays: number;
  private readonly minSampleSize: number;
  private readonly exploitationWeight: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.abEnabled = parseBool(this.configService.get<string>("AB_VARIANTS_ENABLED", "false"));
    this.lookbackDays = Number(this.configService.get("AB_TEST_LOOKBACK_DAYS", 30));
    this.minSampleSize = Number(this.configService.get("AB_TEST_MIN_SAMPLE_SIZE", 3));
    this.exploitationWeight = Number(this.configService.get("AB_TEST_EXPLOITATION_WEIGHT", 0.8));
  }

  /**
   * Persist variants for a freshly generated post.
   *
   * When A/B variants are enabled, stores `a`, `b`, and `base` (the original
   * refined text). When disabled, stores a single `default` variant.
   */
  async createVariants(
    postId: string,
    network: SocialNetwork,
    baseContent: string,
    abVariants: ABVariantPair | null,
    judgeScores?: JudgeScores,
  ): Promise<void> {
    const judgeScoresJson = judgeScores ? (judgeScores as Prisma.InputJsonValue) : undefined;

    const data: Prisma.PostVariantCreateManyInput[] = [];

    if (abVariants && this.abEnabled) {
      data.push(
        {
          postId,
          network,
          label: "a",
          content: abVariants.a.content,
          judgeScores: judgeScoresJson,
          selected: false,
        },
        {
          postId,
          network,
          label: "b",
          content: abVariants.b.content,
          judgeScores: judgeScoresJson,
          selected: false,
        },
        {
          postId,
          network,
          label: "base",
          content: baseContent,
          judgeScores: judgeScoresJson,
          selected: false,
        },
      );
    } else {
      data.push({
        postId,
        network,
        label: "default",
        content: baseContent,
        judgeScores: judgeScoresJson,
        selected: false,
      });
    }

    await this.prisma.postVariant.createMany({ data });
  }

  /**
   * Select the variant that will be posted for a given post.
   *
   * If the post content is still the original `base` content and A/B variants
   * are enabled, the service looks up the historical winner for the topic and
   * uses a weighted split between `a` and `b` (80% winner / 20% challenger by
   * default). If no winner exists yet, the split is 50/50.
   *
   * If the operator edited the content to match a variant, that variant is
   * selected. For any other edit, a `custom` variant is created.
   *
   * Returns the selected variant content. The caller should use it for posting
   * and update the post row if the content changed.
   */
  async selectAndApplyVariant(
    postId: string,
    network: SocialNetwork,
    currentContent: string,
  ): Promise<{ id: string; label: string; content: string; changed: boolean }> {
    const [post, variants] = await Promise.all([
      this.prisma.post.findUnique({
        where: { id: postId },
        select: { sourceRef: true },
      }),
      this.prisma.postVariant.findMany({ where: { postId } }),
    ]);

    if (variants.length === 0) {
      const created = await this.prisma.postVariant.create({
        data: {
          postId,
          network,
          label: "default",
          content: currentContent,
          selected: true,
        },
      });
      return { id: created.id, label: "default", content: currentContent, changed: false };
    }

    const defaultVariant = variants.find((v) => v.label === "default");
    if (defaultVariant) {
      // Non-A/B mode: keep the default variant content in sync with the post.
      const changed = normalize(defaultVariant.content) !== normalize(currentContent);
      await this.prisma.postVariant.update({
        where: { id: defaultVariant.id },
        data: { content: currentContent, selected: true },
      });
      return { id: defaultVariant.id, label: "default", content: currentContent, changed };
    }

    const a = variants.find((v) => v.label === "a");
    const b = variants.find((v) => v.label === "b");
    const base = variants.find((v) => v.label === "base");

    if (!this.abEnabled || !a || !b) {
      const created = await this.prisma.postVariant.create({
        data: {
          postId,
          network,
          label: "default",
          content: currentContent,
          selected: true,
        },
      });
      return { id: created.id, label: "default", content: currentContent, changed: false };
    }

    const normalizedCurrent = normalize(currentContent);

    // Original base content -> weighted split between a and b using the historical winner.
    if (base && normalizedCurrent === normalize(base.content)) {
      const topic = post?.sourceRef
        ? extractTopic({ post: { sourceRef: post.sourceRef }, content: currentContent })
        : currentContent.slice(0, 50);

      const winner = await this.getWinnerForTopic(topic, network);
      const weightA =
        winner === "a"
          ? this.exploitationWeight
          : winner === "b"
            ? 1 - this.exploitationWeight
            : 0.5;

      const selected = pickVariantByWeight(postId, a, b, weightA);
      await this.prisma.postVariant.updateMany({ where: { postId }, data: { selected: false } });
      await this.prisma.postVariant.update({
        where: { id: selected.id },
        data: { selected: true },
      });
      return {
        id: selected.id,
        label: selected.label,
        content: selected.content,
        changed: selected.content !== currentContent,
      };
    }

    // Content matches a specific variant (e.g. operator edited to a variant).
    if (normalizedCurrent === normalize(a.content)) {
      await this.prisma.postVariant.updateMany({ where: { postId }, data: { selected: false } });
      await this.prisma.postVariant.update({ where: { id: a.id }, data: { selected: true } });
      return { id: a.id, label: "a", content: a.content, changed: false };
    }

    if (normalizedCurrent === normalize(b.content)) {
      await this.prisma.postVariant.updateMany({ where: { postId }, data: { selected: false } });
      await this.prisma.postVariant.update({ where: { id: b.id }, data: { selected: true } });
      return { id: b.id, label: "b", content: b.content, changed: false };
    }

    // Custom operator edit: create a custom variant and select it.
    await this.prisma.postVariant.updateMany({ where: { postId }, data: { selected: false } });
    const custom = await this.prisma.postVariant.create({
      data: {
        postId,
        network,
        label: "custom",
        content: currentContent,
        selected: true,
      },
    });
    return { id: custom.id, label: "custom", content: currentContent, changed: false };
  }

  /**
   * Look up the historical winning variant for a given topic and network.
   *
   * Returns `a`, `b`, or `null` when there is not enough data (sample size is
   * below the threshold or no posted variants exist yet).
   */
  async getWinnerForTopic(
    topic: string,
    network: SocialNetwork,
    options?: { minSampleSize?: number; days?: number },
  ): Promise<"a" | "b" | null> {
    const minSampleSize = options?.minSampleSize ?? this.minSampleSize;
    const days = options?.days ?? this.lookbackDays;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.prisma.postVariant.findMany({
      where: {
        selected: true,
        network,
        label: { in: ["a", "b"] },
        post: {
          status: PostStatus.POSTED,
          postedAt: { gte: since },
        },
      },
      include: {
        post: {
          select: {
            id: true,
            network: true,
            postedAt: true,
            postUrl: true,
            sourceRef: true,
          },
        },
      },
      orderBy: { post: { postedAt: "desc" } },
    });

    const typedRows = rows as VariantStatsRow[];

    const matching = typedRows.filter((row) => extractTopic(row) === topic);
    const byLabel = new Map<string, VariantStatsRow[]>();
    for (const row of matching) {
      const list = byLabel.get(row.label) ?? [];
      list.push(row);
      byLabel.set(row.label, list);
    }

    const variants = [];
    for (const [label, labelRows] of byLabel) {
      variants.push(computeVariantStats(label, labelRows));
    }

    const winner = pickWinner(variants, minSampleSize);
    if (winner === "a" || winner === "b") return winner;
    return null;
  }

  /**
   * Record the selected variant's `postedAt` after a successful post.
   */
  async recordPosted(postId: string, postedAt: Date): Promise<void> {
    await this.prisma.postVariant.updateMany({
      where: { postId, selected: true },
      data: { postedAt },
    });
  }

  /**
   * Update metrics for the selected variant of a post.
   * Called by MetricsScraper after a new PostMetrics snapshot is collected.
   */
  async updateMetrics(
    postId: string,
    metrics: {
      likes: number;
      comments: number;
      shares: number;
      impressions?: number | null;
    },
  ): Promise<void> {
    await this.prisma.postVariant.updateMany({
      where: { postId, selected: true },
      data: {
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        impressions: metrics.impressions ?? null,
        metricsAt: new Date(),
      },
    });
  }
}
