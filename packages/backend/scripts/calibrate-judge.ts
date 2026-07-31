#!/usr/bin/env tsx
/**
 * Judge calibration script (P1).
 *
 * Compares LLM-as-a-Judge scores with actual operator/auto-approve outcomes.
 * Produces per-dimension statistics and threshold recommendations.
 *
 * Run:
 *   npx tsx --env-file=../../.env scripts/calibrate-judge.ts
 *   npx tsx --env-file=../../.env scripts/calibrate-judge.ts --since=7d --json
 */
import { PrismaClient, PostStatus, Prisma } from '@prisma/client';
import type { JudgeScores } from '@spa/shared';

const JUDGE_DIMENSIONS: Array<keyof JudgeScores> = [
  'anti_ai_tone',
  'factual_accuracy',
  'hook_strength',
  'character_limit',
];

type DecisionLabel = 'approved' | 'rejected' | 'human_review' | 'other';

interface CalibrationOptions {
  since?: string;
  json?: boolean;
  status?: string;
}

function parseArgs(): CalibrationOptions {
  const opts: CalibrationOptions = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') opts.json = true;
    if (arg.startsWith('--since=')) opts.since = arg.split('=')[1];
    if (arg.startsWith('--status=')) opts.status = arg.split('=')[1];
  }
  return opts;
}

function parseSince(since?: string): Date | undefined {
  if (!since) return undefined;
  const match = since.match(/^(\d+)([dhwm])$/);
  if (!match) return undefined;
  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  const now = Date.now();
  let ms = 0;
  switch (unit) {
    case 'm': ms = amount * 60 * 1000; break;
    case 'h': ms = amount * 60 * 60 * 1000; break;
    case 'd': ms = amount * 24 * 60 * 60 * 1000; break;
    case 'w': ms = amount * 7 * 24 * 60 * 60 * 1000; break;
  }
  return new Date(now - ms);
}

function classify(status: PostStatus): DecisionLabel {
  if (['APPROVED', 'POSTED', 'POSTING', 'SCHEDULED'].includes(status)) return 'approved';
  if (status === 'REJECTED') return 'rejected';
  if (status === 'HUMAN_REVIEW') return 'human_review';
  return 'other';
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[k]!;
}

interface DimensionStats {
  dimension: keyof JudgeScores;
  approved: { count: number; mean: number; p25: number; p50: number; p75: number };
  rejected: { count: number; mean: number; p25: number; p50: number; p75: number };
  recommendedThreshold: number;
  recommendedHardReject: number;
  separation: number;
}

interface CalibrationReport {
  totalPosts: number;
  totalVariants: number;
  byLabel: Record<DecisionLabel, number>;
  dimensions: DimensionStats[];
}

function computeStats(postIds: string[], rows: { label: DecisionLabel; scores: JudgeScores }[]): CalibrationReport {
  const byLabel: Record<DecisionLabel, number> = { approved: 0, rejected: 0, human_review: 0, other: 0 };
  const approvedValues: Record<string, number[]> = {};
  const rejectedValues: Record<string, number[]> = {};

  for (const row of rows) {
    byLabel[row.label] = (byLabel[row.label] ?? 0) + 1;
    for (const dim of JUDGE_DIMENSIONS) {
      const value = row.scores[dim];
      if (typeof value !== 'number') continue;
      if (row.label === 'approved') {
        (approvedValues[dim] ??= []).push(value);
      } else if (row.label === 'rejected') {
        (rejectedValues[dim] ??= []).push(value);
      }
    }
  }

  const dimensions: DimensionStats[] = JUDGE_DIMENSIONS.map((dim) => {
    const a = (approvedValues[dim] ?? []).sort((x, y) => x - y);
    const r = (rejectedValues[dim] ?? []).sort((x, y) => x - y);
    const aMean = average(a);
    const rMean = average(r);
    const p50Approved = percentile(a, 0.5);
    const p50Rejected = percentile(r, 0.5);

    return {
      dimension: dim,
      approved: {
        count: a.length,
        mean: aMean,
        p25: percentile(a, 0.25),
        p50: p50Approved,
        p75: percentile(a, 0.75),
      },
      rejected: {
        count: r.length,
        mean: rMean,
        p25: percentile(r, 0.25),
        p50: p50Rejected,
        p75: percentile(r, 0.75),
      },
      // Threshold: p25 of approved (we want most approved posts to pass)
      // Hard-reject: p75 of rejected (we want most rejected posts to fail)
      recommendedThreshold: Number(p50Approved.toFixed(2)),
      recommendedHardReject: Number(p50Rejected.toFixed(2)),
      separation: Number((aMean - rMean).toFixed(3)),
    };
  });

  return {
    totalPosts: new Set(postIds).size,
    totalVariants: rows.length,
    byLabel,
    dimensions,
  };
}

async function main() {
  const opts = parseArgs();
  const since = parseSince(opts.since);
  const statusFilter = opts.status ? [opts.status as PostStatus] : undefined;

  const prisma = new PrismaClient();
  try {
    const where: Prisma.PostWhereInput = {};
    if (since) where.createdAt = { gte: since };
    if (statusFilter) where.status = { in: statusFilter };

    const posts = await prisma.post.findMany({
      where,
      select: { id: true, status: true, variants: { select: { judgeScores: true } } },
    });

    const rows: { label: DecisionLabel; scores: JudgeScores }[] = [];
    for (const post of posts) {
      const label = classify(post.status);
      for (const variant of post.variants) {
        if (!variant.judgeScores) continue;
        rows.push({
          label,
          scores: variant.judgeScores as JudgeScores,
        });
      }
    }

    const report = computeStats(posts.map((p) => p.id), rows);

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`\n=== Judge Calibration Report ===`);
      console.error(`Posts analyzed: ${posts.length}`);
      console.error(`Variant-decisions analyzed: ${rows.length}`);
      console.error('\nBy outcome:');
      for (const [label, count] of Object.entries(report.byLabel)) {
        console.error(`  ${label}: ${count}`);
      }
      console.error(`\nPer-dimension stats:`);
      console.table(
        report.dimensions.map((d) => ({
          dimension: d.dimension,
          approved_mean: d.approved.mean.toFixed(2),
          approved_p25: d.approved.p25.toFixed(2),
          rejected_mean: d.rejected.mean.toFixed(2),
          rejected_p75: d.rejected.p75.toFixed(2),
          recommended_threshold: d.recommendedThreshold,
          recommended_hard_reject: d.recommendedHardReject,
          separation: d.separation,
        })),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
