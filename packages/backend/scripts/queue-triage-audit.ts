#!/usr/bin/env tsx
/**
 * Queue triage audit script (Phase 0).
 *
 * Diagnoses stuck BullMQ jobs across posting/engagement queues.
 * Cross-references jobs with Prisma records and proposes a triage action.
 * Read-only by default — it never mutates jobs or posts unless you run
 * a follow-up command or apply a triage tool.
 *
 * Run:
 *   npx tsx --env-file=../../.env scripts/queue-triage-audit.ts
 *   npx tsx --env-file=../../.env scripts/queue-triage-audit.ts --engagement --json
 *   npx tsx --env-file=../../.env scripts/queue-triage-audit.ts --network=X --posting --limit=50
 */
import { Queue, type Job } from "bullmq";
import { PrismaClient, type Post, type Interaction } from "../src/generated/prisma/client";
import { isJobInFlight } from "../src/infrastructure/queue/queue-state-utils.js";

type PostLike = Pick<Post, "status">;
type InteractionLike = Pick<Interaction, "status">;

type QueueAction = "posting" | "engagement";

interface AuditOptions {
  network?: string;
  action?: QueueAction;
  json?: boolean;
  limit?: number;
}

interface JobAuditRow {
  queue: string;
  jobId: string | number | undefined;
  state: string;
  entityId?: string;
  network?: string;
  entityStatus?: string;
  entityType: "post" | "interaction";
  attemptsMade: number;
  totalAttempts: number;
  failedReason?: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  proposedAction: string;
  contentPreview?: string;
}

interface QueueSummary {
  queue: string;
  counts: Record<string, number | undefined>;
  audited: number;
}

function parseArgs(): AuditOptions {
  const opts: AuditOptions = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === "--json") opts.json = true;
    if (arg === "--posting") opts.action = "posting";
    if (arg === "--engagement") opts.action = "engagement";
    if (arg.startsWith("--network=")) opts.network = arg.split("=")[1]?.trim();
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.split("=")[1]);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    }
  }
  return opts;
}

function isRateLimit(reason = ""): boolean {
  const lower = reason.toLowerCase();
  return /rate.?limit|daily limit|weekly limit|too many requests|429/.test(lower);
}

function isSessionOrAuthFailure(reason = ""): boolean {
  const lower = reason.toLowerCase();
  return /session|login|auth|cookie|banned|suspended|blocked|not found|timeout|connection closed|target page|context or browser/.test(
    lower,
  );
}

function proposeTriage(post: PostLike | null | undefined, job: Job, state: string): string {
  if (state === "unknown") return "REMOVE_AND_REQUEUE";

  if (state === "failed") {
    const reason = job.failedReason ?? "";
    if (isRateLimit(reason)) return "REQUEUE_DELAY";
    if (isSessionOrAuthFailure(reason)) return "ESCALATE_OR_RECOVER_SESSION";
    if ((job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) return "REJECT_OR_ESCALATE";
    return "RETRY";
  }

  if (state === "completed") {
    if (post?.status === "APPROVED") return "VERIFY_THEN_FAIL";
    return "CLEAR_STALE_COMPLETED_JOB";
  }

  if (!post) return "MISSING_POST";

  if (post.status === "APPROVED" && !isJobInFlight(state)) {
    return "REQUEUE_OR_REMOVE_STALE";
  }
  if (post.status === "POSTING" && !isJobInFlight(state)) {
    return "REAP_TO_FAILED";
  }
  if (post.status === "POSTED") return "ALREADY_POSTED_CLEAR_JOB";
  if (post.status === "FAILED" || post.status === "REJECTED") {
    return "CLEAR_TERMINAL_JOB";
  }
  return "REVIEW";
}

function proposeEngagementTriage(
  interaction: InteractionLike | null | undefined,
  job: Job,
  state: string,
): string {
  if (state === "unknown") return "REMOVE_AND_REQUEUE";
  if (state === "failed") {
    const reason = job.failedReason ?? "";
    if (isRateLimit(reason)) return "REQUEUE_DELAY";
    if (isSessionOrAuthFailure(reason)) return "ESCALATE_OR_RECOVER_SESSION";
    if ((job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) return "REJECT_OR_ESCALATE";
    return "RETRY";
  }
  if (state === "completed" && interaction?.status === "IN_PROGRESS") return "VERIFY_THEN_FAIL";
  if (!interaction) return "MISSING_INTERACTION";
  if (interaction.status === "IN_PROGRESS" && !isJobInFlight(state)) return "REAP_TO_FAILED";
  if (interaction.status === "COMPLETED" || interaction.status === "FAILED")
    return "CLEAR_TERMINAL_JOB";
  return "REVIEW";
}

async function getJobsByState(queue: Queue, limit: number): Promise<Job[]> {
  const states: Array<"active" | "waiting" | "delayed" | "completed" | "failed"> = [
    "failed",
    "waiting",
    "delayed",
    "active",
    "completed",
  ];
  const all: Job[] = [];
  for (const state of states) {
    let jobs: Job[] = [];
    try {
      switch (state) {
        case "active":
          jobs = await queue.getActive(0, limit - 1);
          break;
        case "waiting":
          jobs = await queue.getWaiting(0, limit - 1);
          break;
        case "delayed":
          jobs = await queue.getDelayed(0, limit - 1);
          break;
        case "completed":
          jobs = await queue.getCompleted(0, limit - 1);
          break;
        case "failed":
          jobs = await queue.getFailed(0, limit - 1);
          break;
      }
    } catch {
      // Some states may not be present on a paused/empty queue
      continue;
    }
    all.push(...jobs);
    if (all.length >= limit) break;
  }
  return all.slice(0, limit);
}

async function auditPostingQueue(
  prisma: PrismaClient,
  queue: Queue,
  limit: number,
): Promise<JobAuditRow[]> {
  const rows: JobAuditRow[] = [];
  const jobs = await getJobsByState(queue, limit);

  for (const job of jobs) {
    const state = await job.getState();
    const data = (job.data ?? {}) as { postId?: string; network?: string };
    const postId = data.postId ?? (job.id ? String(job.id) : undefined);

    let post: Pick<Post, "id" | "status" | "approvedAt" | "content" | "network"> | null = null;
    if (postId) {
      post = await prisma.post
        .findUnique({
          where: { id: postId },
          select: { id: true, status: true, approvedAt: true, content: true, network: true },
        })
        .catch(() => null);
    }

    rows.push({
      queue: queue.name,
      jobId: job.id,
      state,
      entityId: postId,
      network: (data.network ?? post?.network ?? "") as string,
      entityStatus: post?.status,
      entityType: "post",
      attemptsMade: job.attemptsMade ?? 0,
      totalAttempts: job.opts?.attempts ?? 1,
      failedReason: job.failedReason,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      proposedAction: proposeTriage(post, job, state),
      contentPreview: post?.content ? String(post.content).slice(0, 160) : undefined,
    });
  }

  return rows;
}

async function auditEngagementQueue(
  prisma: PrismaClient,
  queue: Queue,
  limit: number,
): Promise<JobAuditRow[]> {
  const rows: JobAuditRow[] = [];
  const jobs = await getJobsByState(queue, limit);

  for (const job of jobs) {
    const state = await job.getState();
    const data = (job.data ?? {}) as { interactionId?: string; network?: string; action?: string };
    const interactionId = data.interactionId ?? (job.id ? String(job.id) : undefined);

    let interaction: Pick<
      Interaction,
      "id" | "status" | "targetUrl" | "type" | "accountId"
    > | null = null;
    if (interactionId) {
      interaction = await prisma.interaction
        .findUnique({
          where: { id: interactionId },
          select: { id: true, status: true, targetUrl: true, type: true, accountId: true },
        })
        .catch(() => null);
    }

    rows.push({
      queue: queue.name,
      jobId: job.id,
      state,
      entityId: interactionId,
      network: (data.network ?? "") as string,
      entityStatus: interaction?.status,
      entityType: "interaction",
      attemptsMade: job.attemptsMade ?? 0,
      totalAttempts: job.opts?.attempts ?? 1,
      failedReason: job.failedReason,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      proposedAction: proposeEngagementTriage(interaction, job, state),
      contentPreview: interaction?.targetUrl
        ? String(interaction.targetUrl).slice(0, 160)
        : undefined,
    });
  }

  return rows;
}

async function auditQueue(
  prisma: PrismaClient,
  redisUrl: string,
  network: string,
  action: QueueAction,
  limit: number,
): Promise<{ rows: JobAuditRow[]; summary: QueueSummary }> {
  const prefix = process.env.BULLMQ_QUEUE_PREFIX || "spa";
  const queueName = `${prefix}-${action}-${network.toLowerCase()}`;
  const queue = new Queue(queueName, { connection: { url: redisUrl } });

  try {
    const counts = await queue.getJobCounts(
      "active",
      "waiting",
      "prioritized",
      "delayed",
      "completed",
      "failed",
    );

    const rows =
      action === "posting"
        ? await auditPostingQueue(prisma, queue, limit)
        : await auditEngagementQueue(prisma, queue, limit);

    return {
      rows,
      summary: { queue: queueName, counts, audited: rows.length },
    };
  } finally {
    await queue.close();
  }
}

function printSummary(summaries: QueueSummary[], rows: JobAuditRow[], json: boolean) {
  if (json) {
    console.log(JSON.stringify({ summaries, rows }, null, 2));
    return;
  }

  console.error("\n=== Queue counts ===");
  for (const s of summaries) {
    console.error(`${s.queue}:`, JSON.stringify(s.counts), `audited=${s.audited}`);
  }

  const byAction = new Map<string, number>();
  for (const r of rows) {
    byAction.set(r.proposedAction, (byAction.get(r.proposedAction) ?? 0) + 1);
  }
  console.error("\n=== Proposed triage summary ===");
  for (const [action, count] of byAction.entries()) {
    console.error(`${count.toString().padStart(4, " ")}  ${action}`);
  }

  console.log("\n=== Job audit sample ===");
  console.table(
    rows.slice(0, 50).map((r) => ({
      queue: r.queue,
      jobId: r.jobId ? String(r.jobId).slice(0, 14) : "—",
      state: r.state,
      entity: `${r.entityType}:${r.entityStatus ?? "?"}`,
      attempts: `${r.attemptsMade}/${r.totalAttempts}`,
      proposed: r.proposedAction,
      failedReason: r.failedReason ? r.failedReason.slice(0, 55) : "",
    })),
  );

  if (rows.length > 50) {
    console.error(`\n... ${rows.length - 50} more rows; rerun with --json for full output.`);
  }
}

async function main() {
  const opts = parseArgs();
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6381";
  const prisma = new PrismaClient();

  const networks = (process.env.ENABLED_NETWORKS || "X,THREADS")
    .split(",")
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
  const action = opts.action || "posting";
  const limit = opts.limit ?? 100;

  const targetNetworks = opts.network ? [opts.network.toUpperCase()] : networks;
  const summaries: QueueSummary[] = [];
  const allRows: JobAuditRow[] = [];

  for (const network of targetNetworks) {
    const { rows, summary } = await auditQueue(prisma, redisUrl, network, action, limit);
    summaries.push(summary);
    allRows.push(...rows);
  }

  printSummary(summaries, allRows, Boolean(opts.json));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
