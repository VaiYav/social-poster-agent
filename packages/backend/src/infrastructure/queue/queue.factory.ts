import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import { DiscordNotificationService } from '../notifications/discord-notification.service';

/**
 * BullMQ queue factory — creates Redis-backed queues and workers for posting.
 *
 * Queues (one per network for concurrency=1 isolation — B9 mitigation):
 * - spa-posting-x
 * - spa-posting-threads
 * - spa-posting-facebook
 *
 * Retry config (CONSTITUTION §8):
 * - Max retries: 3 (env: BULLMQ_MAX_RETRIES)
 * - Backoff: exponential, base delay 60s (env: BULLMQ_RETRY_DELAY_MS)
 * - 1min → 5min → 15min
 *
 * Dead-letter: BullMQ 'failed' queue retains jobs for manual intervention.
 */
@Injectable()
export class QueueFactory implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueFactory.name);
  private readonly redisUrl: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly postingMaxRetries: number;
  private readonly postingRetryDelayMs: number;
  private readonly queuePrefix: string;
  private readonly concurrency: number;

  // Queue instances per network
  private readonly queues = new Map<string, Queue>();

  // Worker instances per network
  private readonly workers = new Map<string, Worker>();

  constructor(
    private readonly configService: ConfigService,
    private readonly discord: DiscordNotificationService,
  ) {
    this.redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6381');
    // NOTE: parse env ints with an explicit fallback that preserves a valid 0.
    // `Number(x) || fallback` treats a parsed 0 as falsy, so BULLMQ_MAX_RETRIES=0
    // (operator disabling retries to avoid duplicate posts) was silently replaced by 3.
    this.maxRetries = this.parseIntEnv('BULLMQ_MAX_RETRIES', 3);
    this.retryDelayMs = this.parseIntEnv('BULLMQ_RETRY_DELAY_MS', 60000);
    // Posting jobs get more retries + longer backoff for session-recovery scenarios
    this.postingMaxRetries = this.parseIntEnv('BULLMQ_POSTING_MAX_RETRIES', 8);
    this.postingRetryDelayMs = this.parseIntEnv('BULLMQ_POSTING_RETRY_DELAY_MS', 120000); // 2min base
    this.queuePrefix = this.configService.get<string>('BULLMQ_QUEUE_PREFIX', 'spa');
    // Concurrency must be >= 1 (0 would stall the queue), so clamp the parsed value.
    this.concurrency = Math.max(1, this.parseIntEnv('BULLMQ_CONCURRENCY_PER_QUEUE', 1));
  }

  /**
   * Parse an integer env var, falling back only when unset/empty/non-numeric.
   * Crucially preserves a legitimate 0 (unlike `Number(x) || fallback`).
   */
  private parseIntEnv(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  onModuleInit(): void {
    this.logger.log(
      `BullMQ configured for Redis (${this.redisUrl}, prefix=${this.queuePrefix}, retries=${this.maxRetries}, postingRetries=${this.postingMaxRetries})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.logger.log('BullMQ queues and workers closed');
  }

  private getConnectionOpts() {
    return { connection: { url: this.redisUrl } };
  }

  /**
   * Get or create a queue for a specific network and action.
   * Queue name: {prefix}:{action}-{network}
   * action: 'posting' or 'engagement'
   */
  getQueue(network: string, action: 'posting' | 'engagement' = 'posting'): Queue {
    const queueName = `${this.queuePrefix}-${action}-${network.toLowerCase()}`;
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, this.getConnectionOpts());
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * Enqueue a posting job for a specific post.
   * Job ID = postId for idempotency (BullMQ deduplicates by jobId).
   *
   * Sprint K: Priority queues — trending posts get priority 1 (higher = lower number).
   */
  async enqueuePosting(postId: string, network: string, opts?: { priority?: number; delay?: number }): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    await queue.add(
      'post',
      { postId, network },
      {
        jobId: postId, // idempotent — won't create duplicate jobs
        priority: opts?.priority ?? 10, // Sprint K: default priority 10, trending = 1
        delay: opts?.delay, // Sprint K: delayed jobs for multi-stage threads
        attempts: this.postingMaxRetries, // more retries for session-recovery scenarios
        backoff: {
          type: 'exponential',
          delay: this.postingRetryDelayMs, // 2min → 4min → 8min → 16min...
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    this.logger.log(`Enqueued posting job for post ${postId} → ${network} (priority: ${opts?.priority ?? 10})`);
  }

  /**
   * Enqueue an engagement job (like, comment, follow, browsing session).
   * Job ID = interactionId or browsingSessionId for idempotency.
   * Optional delay (ms) for scheduled browsing sessions.
   */
  async enqueueEngagement(
    interactionId: string,
    network: string,
    action: 'like' | 'comment' | 'follow' | 'reply' | 'browsing-session',
    payload: Record<string, unknown>,
    opts?: { delay?: number },
  ): Promise<void> {
    const queue = this.getQueue(network, 'engagement');
    await queue.add(
      action,
      { interactionId, network, action, ...payload },
      {
        jobId: interactionId, // idempotent
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelayMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        ...(opts?.delay ? { delay: opts.delay } : {}),
      },
    );
    this.logger.log(`Enqueued ${action} job ${interactionId} → ${network}${opts?.delay ? ` (delay: ${Math.round(opts.delay / 1000 / 60)}min)` : ''}`);
  }

  /**
   * RP1: look up an engagement job by its interactionId (re-entrancy guard).
   * Returns the job if one already exists in the engagement queue in any state, so
   * the replies cron can avoid re-deciding / re-enqueuing a reply that is already in
   * flight for a comment that is still NEW. Redis-backed, so it survives restarts.
   */
  async getEngagementJob(interactionId: string, network: string): Promise<Job | undefined> {
    const queue = this.getQueue(network, 'engagement');
    return queue.getJob(interactionId);
  }

  /**
   * Retry a failed job by moving it back to the waiting state.
   */
  async retryFailedJob(network: string, jobId: string): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found in ${network} queue`);
    }
    if (job.failedReason) {
      await job.retry();
      this.logger.log(`Retrying failed job ${jobId} in ${network} queue`);
    } else {
      throw new Error(`Job ${jobId} is not in failed state`);
    }
  }

  /**
   * Schedule a posting job for a specific time.
   */
  async schedulePosting(
    postId: string,
    network: string,
    scheduledAt: Date,
  ): Promise<void> {
    const queue = this.getQueue(network, 'posting');
    const delayMs = scheduledAt.getTime() - Date.now();
    if (delayMs <= 0) {
      // Schedule time is in the past — enqueue immediately
      return this.enqueuePosting(postId, network);
    }
    await queue.add(
      'post',
      { postId, network },
      {
        jobId: postId,
        delay: delayMs,
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelayMs,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    this.logger.log(`Scheduled posting job for post ${postId} → ${network} at ${scheduledAt.toISOString()}`);
  }

  /**
   * Register a worker for a specific network queue.
   * Called by QueueModule on bootstrap.
   */
  registerWorker(
    network: string,
    handler: (job: Job) => Promise<void>,
    action: 'posting' | 'engagement' = 'posting',
  ): Worker {
    const queueName = `${this.queuePrefix}-${action}-${network.toLowerCase()}`;
    let worker = this.workers.get(queueName);
    if (worker) {
      this.logger.warn(`Worker for ${queueName} already registered`);
      return worker;
    }

    worker = new Worker(queueName, handler, {
      ...this.getConnectionOpts(),
      concurrency: this.concurrency,
    });

    // Attempts are configured per-action at enqueue time (enqueuePosting uses
    // postingMaxRetries, enqueueEngagement uses maxRetries) — mirror that here so failure
    // logs and the DLQ alert report the retry budget actually in effect for this queue,
    // instead of always assuming the general-queue default.
    const effectiveMaxRetries = action === 'posting' ? this.postingMaxRetries : this.maxRetries;

    worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed (${queueName})`);
    });

    worker.on('failed', (job, err) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      this.logger.error(
        `Job ${job?.id} failed (${queueName}): ${err.message} (attempts: ${attemptsMade}/${effectiveMaxRetries})`,
      );

      // Send Discord alert when job exhausts all retries → enters DLQ
      if (attemptsMade >= effectiveMaxRetries) {
        this.discord
          .critical(
            'Job Entered DLQ — Manual Intervention Needed',
            `Job **${job?.id}** in \`${queueName}\` exhausted all ${effectiveMaxRetries} retry attempts.`,
            [
              { name: 'Error', value: err.message.slice(0, 1024) },
              { name: 'Queue', value: queueName, inline: true },
              { name: 'Attempts', value: `${attemptsMade}/${effectiveMaxRetries}`, inline: true },
            ],
          )
          .catch(() => void 0);
      }
    });

    worker.on('stalled', (jobId) => {
      this.logger.warn(`Job ${jobId} stalled (${queueName}) — will be retried`);
    });

    this.workers.set(queueName, worker);
    this.logger.log(`Worker registered for ${queueName} (concurrency=${this.concurrency})`);
    return worker;
  }

  /**
   * Get failed jobs (dead-letter queue) for a network.
   */
  async getFailedJobs(network: string, action: 'posting' | 'engagement' = 'posting') {
    const queue = this.getQueue(network, action);
    return queue.getFailed();
  }

  /**
   * Get active/waiting job counts for a network.
   */
  async getJobCounts(network: string, action: 'posting' | 'engagement' = 'posting') {
    const queue = this.getQueue(network, action);
    return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }

  /**
   * Pause a queue — stops workers from processing new jobs (F5).
   * Already-running jobs continue to completion.
   */
  async pauseQueue(network: string, action: 'posting' | 'engagement' = 'posting'): Promise<void> {
    const queue = this.getQueue(network, action);
    await queue.pause();
  }

  /**
   * Resume a paused queue — workers start picking up jobs again (F5).
   */
  async resumeQueue(network: string, action: 'posting' | 'engagement' = 'posting'): Promise<void> {
    const queue = this.getQueue(network, action);
    await queue.resume();
  }

  /**
   * Check if a queue is currently paused.
   */
  async isQueuePaused(network: string, action: 'posting' | 'engagement' = 'posting'): Promise<boolean> {
    const queue = this.getQueue(network, action);
    return queue.isPaused();
  }
}
