/**
 * P7: A/B test pure helpers — shared by ABTestService and ABVariantService.
 *
 * Keeping the winner/topic/stats logic in one place avoids duplication
 * between the analytics aggregation and the runtime selection feedback loop.
 */
import type { SocialNetwork } from "../../generated/prisma/client";
import type { ABTestVariant } from "@spa/shared";

export interface VariantStatsRow {
  id: string;
  postId: string;
  network: SocialNetwork;
  label: string;
  content: string;
  judgeScores: unknown;
  selected: boolean;
  postedAt: Date | null;
  metricsAt: Date | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  post: {
    id: string;
    network: SocialNetwork;
    postedAt: Date | null;
    postUrl: string | null;
    sourceRef: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getJudgeScore(row: VariantStatsRow, key: string): number | null {
  if (!isRecord(row.judgeScores)) return null;
  const value = row.judgeScores[key];
  if (typeof value === "number") return value;
  return null;
}

function average(
  rows: VariantStatsRow[],
  fn: (r: VariantStatsRow) => number | null | undefined,
): number {
  const values = rows.map(fn).filter((v): v is number => v !== null && v !== undefined);
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function averageMaybe(
  rows: VariantStatsRow[],
  fn: (r: VariantStatsRow) => number | null | undefined,
): number | null {
  const values = rows.map(fn).filter((v): v is number => v !== null && v !== undefined);
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

export function extractTopic(row: {
  post: Pick<VariantStatsRow["post"], "sourceRef">;
  content: string;
}): string {
  if (isRecord(row.post.sourceRef)) {
    const ref = row.post.sourceRef;
    if (typeof ref["topic"] === "string") return ref["topic"];
    if (typeof ref["originalTopic"] === "string") return ref["originalTopic"];
    if (typeof ref["title"] === "string") return ref["title"];
  }
  return row.content.slice(0, 50);
}

export function computeVariantStats(label: string, rows: VariantStatsRow[]): ABTestVariant {
  const avgLikes = average(rows, (r) => r.likes);
  const avgComments = average(rows, (r) => r.comments);
  const avgShares = average(rows, (r) => r.shares);
  const avgImpressions = averageMaybe(rows, (r) => r.impressions);
  const avgEngagement = avgLikes + avgComments + avgShares;

  const avgAntiAiTone = averageMaybe(rows, (r) => getJudgeScore(r, "anti_ai_tone"));
  const avgHookStrength = averageMaybe(rows, (r) => getJudgeScore(r, "hook_strength"));

  return {
    label,
    sampleSize: rows.length,
    avgLikes,
    avgComments,
    avgShares,
    avgImpressions:
      typeof avgImpressions === "number" && Number.isFinite(avgImpressions) ? avgImpressions : null,
    avgEngagement,
    avgAntiAiTone:
      typeof avgAntiAiTone === "number" && Number.isFinite(avgAntiAiTone) ? avgAntiAiTone : null,
    avgHookStrength:
      typeof avgHookStrength === "number" && Number.isFinite(avgHookStrength)
        ? avgHookStrength
        : null,
  };
}

export function pickWinner(variants: ABTestVariant[], minSampleSize: number): string | null {
  let winner: string | null = null;
  let bestEngagement = -Infinity;
  let winnerTied = false;

  for (const v of variants) {
    if (v.sampleSize < minSampleSize) continue;

    if (v.avgEngagement > bestEngagement) {
      bestEngagement = v.avgEngagement;
      winner = v.label;
      winnerTied = false;
    } else if (v.avgEngagement === bestEngagement) {
      winnerTied = true;
    }
  }

  if (winnerTied) return null;
  return winner;
}
